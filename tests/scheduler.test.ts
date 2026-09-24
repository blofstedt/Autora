/**
 * Scheduled jobs and watchers: cron is read the way cron reads it, due jobs
 * run once, and a watcher runs only when what it sees changes.
 *
 *   npx tsx tests/scheduler.test.ts
 */
import assert from "node:assert/strict";
import { Scheduler, describeChange, nextRun, parseCron, type Job, type JobRun } from "../server/scheduler";

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

const at = (s: string) => new Date(s);
const iso = (d: Date | null) => {
  if (!d) return null;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

console.log("scheduler");

await test("cron fields: lists, ranges, steps, names", () => {
  const c = parseCron("*/15 9-17 * jan-mar mon-fri");
  assert.deepEqual([...c.minute.values], [0, 15, 30, 45]);
  assert.deepEqual([...c.hour.values].length, 9);
  assert.deepEqual([...c.month.values], [1, 2, 3]);
  assert.deepEqual([...c.dow.values], [1, 2, 3, 4, 5]);
  assert.deepEqual([...parseCron("0 0 * * 7").dow.values], [0]);
  assert.throws(() => parseCron("0 8 * *"), /five fields/);
  assert.throws(() => parseCron("61 * * * *"), /outside/);
});

await test("the next run is the next matching minute", () => {
  assert.equal(iso(nextRun("0 8 * * *", at("2026-03-10T07:59:30"))), "2026-03-10 08:00");
  assert.equal(iso(nextRun("0 8 * * *", at("2026-03-10T08:00:00"))), "2026-03-11 08:00");
  assert.equal(iso(nextRun("30 * * * *", at("2026-03-10T10:31:00"))), "2026-03-10 11:30");
  // Friday the 13th of March 2026 -> next weekday morning is Monday the 16th.
  assert.equal(iso(nextRun("0 8 * * 1-5", at("2026-03-13T09:00:00"))), "2026-03-16 08:00");
  assert.equal(iso(nextRun("@monthly", at("2026-03-10T00:00:00"))), "2026-04-01 00:00");
  // Day-of-month and weekday both set: either matches, as in cron.
  assert.equal(iso(nextRun("0 0 1 * 0", at("2026-03-10T00:00:00"))), "2026-03-15 00:00");
});

await test("a change is described as lines new and lines gone", () => {
  const text = describeChange("price: 10\nstock: yes", "price: 12\nstock: yes");
  assert.match(text, /\+ price: 12/);
  assert.match(text, /- price: 10/);
  assert.doesNotMatch(text, /stock/);
});

function job(extra: Partial<Job> = {}): Job {
  return {
    id: "j1", name: "test", cron: "* * * * *", prompt: "do it", enabled: true, created: 0,
    last_run: null, last_session: null, last_error: null, next_run: null, cron_error: null, ...extra,
  };
}

function harness(jobs: Job[], seen: string[] = []) {
  let clock = at("2026-03-10T08:00:10").getTime();
  const fired: { prompt: string; reason: string }[] = [];
  const finished: JobRun[] = [];
  let finish: (v: { ok: boolean; error: string | null; reply: string }) => void = () => undefined;
  const s = new Scheduler(jobs, {
    now: () => clock,
    save: () => undefined,
    notify: (_job, run) => finished.push(run),
    observe: async () => seen.shift() ?? "",
    run: async (_job, prompt, reason) => {
      fired.push({ prompt, reason });
      return { session: `s${fired.length}`, done: new Promise((r) => { finish = r; }) };
    },
  });
  return {
    s, fired, finished,
    advance: (ms: number) => { clock += ms; },
    finish: (v: { ok: boolean; error: string | null; reply: string }) => finish(v),
  };
}

await test("a due job runs once, is planned again, and records how it went", async () => {
  const j = job();
  const h = harness([j]);
  h.s.plan(j);
  await h.s.tick();
  assert.equal(h.fired.length, 0, "not due yet");
  h.advance(60_000);
  await h.s.tick();
  await h.s.tick();
  assert.equal(h.fired.length, 1, "fired once, not once per tick");
  assert.equal(j.last_session, "s1");
  assert.ok(h.s.running(j.id));
  h.finish({ ok: true, error: null, reply: "All good." });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(h.finished.length, 1);
  assert.equal(j.runs?.[0].summary, "All good.");
  assert.equal(j.runs?.[0].ok, true);
  assert.ok(!h.s.running(j.id));
});

await test("a disabled job or a broken cron never runs", async () => {
  const off = job({ id: "off", enabled: false });
  const bad = job({ id: "bad", cron: "every day" });
  const h = harness([off, bad]);
  h.s.plan(off);
  h.s.plan(bad);
  assert.ok(bad.cron_error);
  h.advance(3600_000);
  await h.s.tick();
  assert.equal(h.fired.length, 0);
});

await test("a watcher runs only when what it sees changed", async () => {
  const j = job({ watch: { kind: "page", target: "https://example.com" } });
  const h = harness([j], ["price: 10", "price: 10", "price: 12"]);
  assert.equal(await h.s.check(j), "baseline");
  assert.equal(await h.s.check(j), "same");
  assert.equal(h.fired.length, 0);
  assert.equal(await h.s.check(j), "changed");
  assert.equal(h.fired.length, 1);
  assert.equal(h.fired[0].reason, "change");
  assert.match(h.fired[0].prompt, /\+ price: 12/);
});

console.log(`${passed} passed`);
