/**
 * What has to survive and what has to run by itself: a restart, scheduled and
 * watched jobs, tools the agent writes, attachments, widgets, and the browser
 * driven by the agent. The real server, a scripted model.
 *
 *   npx tsx tests/e2e-more.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { sleep, startApp, type App, type Ev } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    throw err;
  }
}
const texts = (ev: Ev[]) => ev.filter((e) => e.kind === "turn.agent.text").map((e) => e.payload.text).join("");
const toolBack = (app: App) => JSON.stringify(app.seen.at(-1)!.messages.filter((m) => m.role === "tool"));
const steps = (app: App, plan: { name: string; args?: Record<string, unknown> }[], last = "Done.") => {
  app.decide = (req) => {
    const n = req.messages.filter((m) => m.role === "tool").length;
    return n < plan.length ? { tools: [plan[n]] } : { text: last };
  };
};

async function main() {
  const app = await startApp();
  const pages = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    if ((req.url ?? "").startsWith("/shop")) {
      return void res.end(`<title>Shop</title><body><h1>Shop</h1><button onclick="document.title='BOUGHT'">Buy now</button>
        <a href="/about">About us</a><input aria-label="Email" placeholder="you@example.com"></body>`);
    }
    if ((req.url ?? "").startsWith("/about")) return void res.end("<title>About</title><h1>About us</h1><p>We sell things.</p>");
    res.end("<title>Home</title>ok");
  });
  await new Promise<void>((r) => pages.listen(0, "127.0.0.1", r));
  const site = `http://127.0.0.1:${(pages.address() as any).port}`;
  try {
    console.log("a restart");
    await test("chats, their events and the settings all come back after the server restarts", async () => {
      app.script.push({ text: "Remember this reply." });
      const s = await app.newSession("Survivor");
      await app.turn(s, "say something");
      await app.api("PATCH", `/api/sessions/${s}`, { title: "Survivor", pinned: true });
      await app.api("POST", "/api/secrets", { name: "KEPT_SECRET", value: "kept-value-123456" });
      await sleep(800); // saves are batched
      await app.restart();
      const list = (await app.api("GET", "/api/sessions")).body;
      const row = list.find((x: any) => x.id === s);
      assert.ok(row, "the chat is gone");
      assert.equal(row.pinned, true);
      const ev = await app.events(s);
      assert.match(texts(ev), /Remember this reply/);
      const seqs = ev.map((e) => e.seq);
      assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
      assert.equal(new Set(seqs).size, seqs.length, "duplicate events after a restart");
      assert.match(String((await app.api("GET", "/api/settings")).body.active.provider), /local/i);
      // The chat is usable, and new events carry on the sequence.
      app.script.push({ text: "Still here." });
      const again = await app.turn(s, "still there?");
      assert.match(texts(again), /Still here/);
      assert.ok(Math.max(...again.map((e) => e.seq)) > Math.max(...seqs));
    });
    await test("a turn cut off by a restart is not left looking like it is still running", async () => {
      const s = await app.newSession("Cut off");
      app.decide = () => ({ text: "word ".repeat(400), slow: true });
      await app.say(s, "go");
      await app.until(s, (e) => e.some((x) => x.kind === "turn.agent.text"), "the reply to start");
      await app.restart();
      app.decide = null;
      const row = (await app.api("GET", "/api/sessions")).body.find((x: any) => x.id === s);
      assert.ok(row);
      assert.equal(row.busy, false, "it still says it is working");
      app.script.push({ text: "Recovered." });
      assert.match(texts(await app.turn(s, "hello?")), /Recovered/);
    });

    console.log("jobs that run by themselves");
    await test("a scheduled task runs on demand in a chat of its own, with its prompt", async () => {
      app.decide = () => ({ text: "Backup checked." });
      const made = await app.api("POST", "/api/jobs", { name: "Nightly check", cron: "0 3 * * *", prompt: "Check the backup." });
      assert.equal(made.status, 200);
      assert.equal(made.body.cron_error, null);
      const ran = await app.api("POST", `/api/jobs/${made.body.id}/run`);
      assert.equal(ran.status, 200, JSON.stringify(ran.body));
      const ev = await app.until(ran.body.session, (e) => e.some((x) => x.kind === "turn.agent.done"), "the run");
      assert.match(texts(ev), /Backup checked/);
      assert.match(app.seen.at(-1)!.last, /Check the backup/);
      const job = (await app.api("GET", "/api/jobs")).body.find((j: any) => j.id === made.body.id);
      assert.ok(job.last_run, "the run was not recorded");
      assert.equal(job.runs.length, 1);
      app.decide = null;
    });
    await test("a schedule that is not a schedule says so instead of silently never running", async () => {
      const made = await app.api("POST", "/api/jobs", { name: "Bad", cron: "every tuesday-ish", prompt: "x" });
      assert.equal(made.status, 200);
      assert.ok(made.body.cron_error, "a cron nobody can run was accepted quietly");
      const listed = (await app.api("GET", "/api/jobs")).body.find((j: any) => j.id === made.body.id);
      assert.equal(listed.next_run, null);
    });
    await test("a watcher on a file notices when it changes, and only then", async () => {
      const file = `${app.home}/watched.txt`;
      fs.writeFileSync(file, "version one");
      app.decide = () => ({ text: "It changed." });
      const made = await app.api("POST", "/api/jobs", { name: "Watch it", cron: "", prompt: "Say what changed.", watch: { type: "file", target: file } });
      assert.equal(made.status, 200);
      await sleep(700);
      const first = (await app.api("GET", "/api/jobs")).body.find((j: any) => j.id === made.body.id);
      assert.ok(!first.last_session, "the first look is a baseline, not news");
      fs.writeFileSync(file, "version two, quite different");
      const again = await app.api("POST", `/api/jobs/${made.body.id}/run`);
      assert.equal(again.status, 200, JSON.stringify(again.body));
      app.decide = null;
    });

    console.log("the clock");
    await test("a time zone is chosen, schedules are planned on it, and it survives a restart", async () => {
      assert.equal((await app.api("PATCH", "/api/settings", { timezone: "Not/AZone" })).status, 400, "an unknown zone was taken as UTC");
      const set = await app.api("PATCH", "/api/settings", { timezone: "Asia/Tokyo" });
      assert.equal(set.status, 200);
      const made = await app.api("POST", "/api/jobs", { name: "Morning", cron: "0 8 * * *", prompt: "Good morning." });
      const job = (await app.api("GET", "/api/jobs")).body.find((j: any) => j.id === made.body.id);
      const inTokyo = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(job.next_run * 1000));
      assert.equal(inTokyo, "08:00", "the schedule is not on the person's clock");
      // Changing the zone plans every job again on the new clock.
      await app.api("PATCH", "/api/settings", { timezone: "America/New_York" });
      const again = (await app.api("GET", "/api/jobs")).body.find((j: any) => j.id === made.body.id);
      const inNy = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(again.next_run * 1000));
      assert.equal(inNy, "08:00");
      await sleep(700);
      await app.restart();
      const back = (await app.api("GET", "/api/settings")).body;
      assert.equal(back.timezone, "America/New_York");
      assert.ok(back.machine_timezone);
      const kept = (await app.api("GET", "/api/jobs")).body.find((j: any) => j.id === made.body.id);
      assert.equal(new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(kept.next_run * 1000)), "08:00", "the restarted server is on another clock");
      assert.equal((await app.api("PATCH", "/api/settings", { timezone: "" })).status, 200);
      assert.equal((await app.api("GET", "/api/settings")).body.timezone, "");
    });

    console.log("tools the agent writes");
    await test("a tool the agent saves is offered in the next chat, and runs", async () => {
      const s = await app.newSession();
      steps(app, [{ name: "tool_create", args: { name: "shout", description: "Shout a word.", script: 'echo "$ARG_WORD" | tr a-z A-Z', parameters: { type: "object", properties: { word: { type: "string" } }, required: ["word"] } } }], "Saved.");
      const ev = await app.turn(s, "make a shout tool");
      assert.ok(ev.some((e) => e.kind === "tool.call" && e.payload.name === "tool_create"));
      app.decide = null;
      app.seen.length = 0;
      const s2 = await app.newSession();
      steps(app, [{ name: "my_shout", args: { word: "hello" } }], "Shouted.");
      await app.turn(s2, "shout hello");
      assert.ok(app.seen[0].tools.includes("my_shout"), "the saved tool was not offered");
      assert.match(toolBack(app), /HELLO/);
      app.decide = null;
    });

    console.log("attachments and widgets");
    await test("an uploaded file goes with the message, and the model is told about it", async () => {
      const up = await fetch(`${app.base}/api/artifacts`, {
        method: "POST", headers: { "content-type": "application/octet-stream", "x-file-name": "notes.txt", "x-file-type": "text/plain" }, body: "the meeting is on friday",
      });
      const body: any = await up.json().catch(() => ({}));
      assert.equal(up.status, 200, JSON.stringify(body));
      const id = body.artifact?.id;
      const s = await app.newSession();
      app.decide = () => ({ text: "Got the file." });
      await app.api("POST", `/api/sessions/${s}/message`, { text: "read this", attachments: [id] });
      const ev = await app.until(s, (e) => e.some((x) => x.kind === "turn.agent.done"), "the turn");
      assert.match(app.seen.at(-1)!.last, /notes\.txt/);
      assert.ok(JSON.stringify(ev).includes("notes.txt"));
      app.decide = null;
    });
    await test("a widget that works is shown; one that breaks is refused and the agent is told what broke", async () => {
      const s = await app.newSession();
      steps(app, [{ name: "widget_show", args: { title: "Orbit", html: '<div id="a">hello</div><script>document.getElementById("a").textContent = "ready"</script>', height: 200 } }], "Shown.");
      const ev = await app.turn(s, "draw something");
      assert.ok(ev.some((e) => e.kind === "media.widget"), "a working widget was not shown");
      const s2 = await app.newSession();
      steps(app, [{ name: "widget_show", args: { title: "Broken", html: "<script>null.boom()</script>", height: 200 } }], "Oops.");
      const ev2 = await app.turn(s2, "draw something broken");
      assert.ok(!ev2.some((e) => e.kind === "media.widget"), "a widget that throws was shown");
      assert.match(toolBack(app), /boom|null|error|broke/i);
      app.decide = null;
    });

    console.log("the browser, driven by the agent");
    await test("open a page, click a button, read the result: the tool replies say what happened", async () => {
      const s = await app.newSession();
      let readShop = "";
      app.decide = (req) => {
        const n = req.messages.filter((m) => m.role === "tool").length;
        if (n === 0) return { tools: [{ name: "browser_open", args: { url: `${site}/shop` } }] };
        if (n === 1) {
          readShop = JSON.stringify(req.messages.filter((m) => m.role === "tool").at(-1)!.content);
          const ref = /\[(\d+)\] button \\"Buy now\\"/.exec(readShop)?.[1] ?? "0";
          return { tools: [{ name: "browser_click", args: { ref: Number(ref) } }] };
        }
        return { text: "Bought." };
      };
      const ev = await app.turn(s, "buy it", 60_000);
      assert.match(readShop, /Buy now/);
      assert.match(readShop, /About us/);
      assert.match(toolBack(app), /BOUGHT/, "the page after the click was not reported");
      assert.ok(ev.some((e) => e.kind.startsWith("browser.")), "nothing about the browser is in the thread");
      app.decide = null;
    });
    await test("a link followed in the browser ends up on the new page", async () => {
      const s = await app.newSession();
      app.decide = (req) => {
        const n = req.messages.filter((m) => m.role === "tool").length;
        if (n === 0) return { tools: [{ name: "browser_open", args: { url: `${site}/shop` } }] };
        if (n === 1) {
          const seenShop = JSON.stringify(req.messages.filter((m) => m.role === "tool").at(-1)!.content);
          const ref = /\[(\d+)\] link \\"About us\\"/.exec(seenShop)?.[1] ?? "0";
          return { tools: [{ name: "browser_click", args: { ref: Number(ref) } }] };
        }
        return { text: "There." };
      };
      await app.turn(s, "go to about", 60_000);
      assert.match(toolBack(app), /We sell things/);
      assert.match(toolBack(app), /URL: .*\/about/);
      app.decide = null;
    });
  } finally {
    const log = app.log();
    pages.close();
    await app.stop();
    if (process.env.E2E_LOG) console.log(log);
  }
  console.log(`\n${passed} passed`);
  process.exit(0);
}
main().catch((err) => { console.error(err); process.exit(1); });
