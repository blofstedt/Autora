/**
 * What the console notices, and what it tells the phone: a condition is said
 * once, dismissed until it clears, and a message goes only where it belongs.
 *
 *   npx tsx tests/noticer.test.ts
 */
import assert from "node:assert/strict";
import { Noticer, findings, type NoticerMemory } from "../server/noticer";
import {
  HeldMessages, defaultPush, deliver, mergePush,
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

await test("settings: only which news is sent is kept, and nonsense leaves the old value", () => {
  const p = defaultPush();
  mergePush(p, { on: { turns: false, jobs: "yes" } });
  assert.equal(p.on.turns, false);
  assert.equal(p.on.jobs, true, "a value that is not a switch is ignored");
  mergePush(p, null);
  mergePush(p, "nonsense");
  assert.deepEqual(p, { on: { jobs: true, notices: true, turns: false, asks: true } });
});

await test("settings written by an older build, which named a chat bot and a topic, load without them", () => {
  const p = defaultPush();
  mergePush(p, {
    ntfy: { enabled: true, server: "https://ntfy.sh", topic: "autora-x1" },
    telegram: { enabled: true, chat: "42" },
    on: { asks: false },
  });
  assert.deepEqual(p, { on: { jobs: true, notices: true, turns: true, asks: false } });
  assert.ok(!("ntfy" in p) && !("telegram" in p), "nothing of the old channels is carried");
});

await test("a message goes to the devices that asked, and nowhere else", async () => {
  const sent: any[] = [];
  const web = { count: () => 2, send: async (m: any) => { sent.push(m); return { ok: true, sent: 2, failed: 0 }; } };
  const out = await deliver({ title: "Backup finished", body: "All 3 disks copied.", url: "http://umbrel.local:8817/?session=s1" }, web);
  assert.deepEqual(out, [{ channel: "web", ok: true }]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "http://umbrel.local:8817/?session=s1");
});

await test("a failure is a line, never a throw; and with no device nothing is sent at all", async () => {
  const down = { count: () => 1, send: async () => { throw new Error("network is down"); } };
  const [d] = await deliver({ title: "x", body: "y" }, down);
  assert.equal(d.ok, false);
  assert.match(d.error!, /network is down/);
  let called = false;
  const none = { count: () => 0, send: async () => { called = true; return { ok: true, sent: 0, failed: 0 }; } };
  assert.deepEqual(await deliver({ title: "x", body: "y" }, none), []);
  assert.equal(called, false);
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
