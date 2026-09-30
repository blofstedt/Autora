/**
 * What the console notices, and what it tells the phone: a condition is said
 * once, dismissed until it clears, and a message goes only where it belongs.
 *
 *   npx tsx tests/noticer.test.ts
 */
import assert from "node:assert/strict";
import { Noticer, findings, type NoticerMemory } from "../server/noticer";
import {
  HeldMessages, cleanServer, defaultPush, deliver, mergePush, telegramChats,
} from "../server/push";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    throw err;
  }
}

const GB = 1024 ** 3;
const quietJobs = { containers: null, jobs: [] };

console.log("noticer and push");

await test("a full disk, an app in a loop and a failed schedule are noticed; a healthy box is not", () => {
  assert.deepEqual(findings({ disk: { used: 50 * GB, total: 100 * GB }, ...quietJobs }), []);
  const found = findings({
    disk: { used: 98 * GB, total: 100 * GB },
    containers: [
      { name: "jellyfin", state: "restarting", status: "Restarting (1) 3 seconds ago" },
      { name: "pihole", state: "running", status: "Up 4 days (healthy)" },
    ],
    jobs: [
      { id: "j1", name: "Backup", prompt: "", cron: "", enabled: true, last_error: "exit 2", failed: true },
      { id: "j2", name: "Off", prompt: "", cron: "", enabled: false, last_error: "x", failed: true },
    ],
  });
  assert.deepEqual(found.map((f) => f.key), ["disk:critical", "container:restarting:jellyfin", "job:j1"]);
  assert.match(found[0].title, /almost out of space/);
  assert.match(found[0].prompt, /Delete nothing/);
});

await test("said once, even across a restart; dismissed until it clears; news again when it returns", () => {
  const memory: NoticerMemory = { announced: {}, dismissed: {} };
  const full = findings({ disk: { used: 92 * GB, total: 100 * GB }, ...quietJobs });
  const n = new Noticer(memory);
  assert.equal(n.update(full, 100).length, 1, "new: announced");
  assert.equal(n.update(full, 200).length, 0, "still true: not again");

  // A restart: a fresh noticer over the same memory stays quiet about it...
  const after = new Noticer(memory);
  assert.equal(after.update(full, 300).length, 0);
  // ...but still lists it, with the time it was first seen.
  assert.equal(after.list()[0].since, 100);

  after.dismiss("disk", 400);
  assert.equal(after.list().length, 0, "dismissed: not listed");
  assert.equal(after.update(full, 500).length, 0);

  // It clears, and then it comes back: that is news.
  assert.equal(after.update([], 600).length, 0);
  assert.deepEqual(memory, { announced: {}, dismissed: {} });
  assert.equal(after.update(full, 700).length, 1);
});

await test("settings: a server is a plain http(s) address, a topic is ntfy's kind of name", () => {
  const p = defaultPush();
  mergePush(p, { ntfy: { enabled: true, server: "https://ntfy.example.com/", topic: "autora-x1" }, on: { turns: false } });
  assert.equal(p.ntfy.server, "https://ntfy.example.com");
  assert.equal(p.ntfy.topic, "autora-x1");
  assert.equal(p.on.turns, false);
  mergePush(p, { ntfy: { server: "javascript:alert(1)", topic: "has spaces" } });
  assert.equal(p.ntfy.server, "https://ntfy.example.com", "nonsense leaves the old value");
  assert.equal(p.ntfy.topic, "autora-x1");
  assert.equal(cleanServer("https://user:pw@ntfy.sh"), null, "no credentials in the address");
  mergePush(p, { telegram: { enabled: true, chat: 123456789 } });
  assert.equal(p.telegram.chat, "123456789");
});

await test("a message goes to each channel set up, and each token only to its own service", async () => {
  const p = defaultPush();
  mergePush(p, { ntfy: { enabled: true, topic: "autora-x1" }, telegram: { enabled: true, chat: "42" } });
  const seen: { url: string; headers: Record<string, string>; body: any }[] = [];
  const fake = (async (url: string, init: any) => {
    seen.push({ url, headers: init?.headers ?? {}, body: JSON.parse(init?.body ?? "{}") });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
  const out = await deliver(
    { title: "Backup finished", body: "All 3 disks copied.", url: "http://umbrel.local:8817/?session=s1" },
    p, { ntfy: "tk_ntfy", telegram: "123:bot" }, fake,
  );
  assert.deepEqual(out.map((d) => [d.channel, d.ok]), [["ntfy", true], ["telegram", true]]);
  const ntfy = seen.find((s) => s.url.startsWith("https://ntfy.sh"))!;
  assert.equal(ntfy.headers.Authorization, "Bearer tk_ntfy");
  assert.equal(ntfy.body.topic, "autora-x1");
  assert.equal(ntfy.body.click, "http://umbrel.local:8817/?session=s1");
  const tg = seen.find((s) => s.url.startsWith("https://api.telegram.org/"))!;
  assert.equal(tg.url, "https://api.telegram.org/bot123:bot/sendMessage");
  assert.equal(tg.body.chat_id, "42");
  assert.ok(!JSON.stringify(ntfy).includes("123:bot") && !JSON.stringify(tg).includes("tk_ntfy"));
});

await test("a failure is a line, never the token", async () => {
  const p = defaultPush();
  mergePush(p, { telegram: { enabled: true, chat: "42" } });
  const down = (async () => { throw new TypeError("fetch failed https://api.telegram.org/botSECRET/sendMessage"); }) as unknown as typeof fetch;
  const [d] = await deliver({ title: "x", body: "y" }, p, { ntfy: "", telegram: "SECRET" }, down);
  assert.equal(d.ok, false);
  assert.ok(!d.error!.includes("SECRET"));
  const refused = (async () => new Response(JSON.stringify({ ok: false, description: "Unauthorized" }), { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(telegramChats("SECRET", refused), (e: Error) => /Unauthorized/.test(e.message) && !e.message.includes("SECRET"));
  // Nothing set up: nothing sent, nothing thrown.
  assert.deepEqual(await deliver({ title: "x", body: "y" }, defaultPush(), { ntfy: "", telegram: "" }, down), []);
});

await test("the chats that wrote to the bot, newest first", async () => {
  const updates = (async () => new Response(JSON.stringify({ ok: true, result: [
    { message: { chat: { id: 1, first_name: "Ann" } } },
    { message: { chat: { id: 2, title: "Family" } } },
    { message: { chat: { id: 1, first_name: "Ann" } } },
  ] }), { status: 200 })) as unknown as typeof fetch;
  assert.deepEqual(await telegramChats("t", updates), [{ id: "1", name: "Ann" }, { id: "2", name: "Family" }]);
});

await test("held through quiet hours, then sent as one message", () => {
  const held = new HeldMessages();
  assert.equal(held.take(null), null);
  held.hold({ title: "Backup finished", body: "ok" });
  assert.equal(held.take(null)?.title, "Backup finished", "one is sent as itself");
  held.hold({ title: "Backup finished", body: "ok" });
  held.hold({ title: "The disk is 91% full", body: "…", urgent: true });
  const one = held.take("http://app")!;
  assert.match(one.title, /2 things/);
  assert.match(one.body, /^• Backup finished: ok\n• The disk is 91% full: …$/);
  assert.equal(one.urgent, true);
  assert.equal(held.size, 0);
});

console.log(`${passed} passed`);
