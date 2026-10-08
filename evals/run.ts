/**
 * Measure the agent on real tasks.
 *
 *   npm run eval -- --selftest             prove the checks work (no model, free)
 *   npm run eval                           every task once, on the saved model
 *   npm run eval -- fix work --runs 3      tasks whose id or area contains one of these
 *   npm run eval -- --out before.json      keep the results
 *   npm run eval -- --compare before.json  and show what changed against a kept run
 *
 * Each run starts the real server on an empty data directory and an empty
 * working folder, sends the task through the chat like a person, waits for the
 * turn to end, then reads the folder and the event log. Not part of `npm test`:
 * a real run costs money and varies, so it is run on purpose, before and after
 * a change to the prompt, the tools or the loop.
 *
 * Model: EVAL_PROVIDER and EVAL_MODEL (e.g. anthropic, claude-sonnet-5-5), with
 * the vendor's key in its usual variable (ANTHROPIC_API_KEY, ...).
 * Several runs per task (`--runs`) tell a real change from a lucky one.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startApp, type Ev, type Scripted } from "../tests/e2e-harness";
import { TASKS, type Check, type Run, type Task } from "./tasks";

interface Outcome {
  id: string;
  area: Task["area"];
  pass: boolean;
  checks: Check[];
  heavy: string[];
  run: Omit<Run, "dir" | "reply" | "log">;
  reply: string;
}

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const value = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const valued = new Set(["--runs", "--out", "--compare", "--timeout"]);
const filters = args.filter((a, i) => !a.startsWith("--") && !valued.has(args[i - 1] ?? ""));
const selftest = flag("selftest");
const runs = Math.max(1, Number(value("runs")) || 1);
const timeout = (Number(value("timeout")) || (selftest ? 60 : 420)) * 1000;

const chosen = TASKS.filter((t) => !filters.length || filters.some((f) => t.id.includes(f) || t.area === f));

const toRun = (events: Ev[], dir: string, ms: number, timedOut: boolean): Run => {
  const calls = events.filter((e) => e.kind === "tool.call").map((e) => ({ name: String(e.payload.name), args: e.payload.args ?? {} }));
  const usage = events.filter((e) => e.kind === "usage.turn");
  return {
    dir, ms, timedOut, calls,
    reply: events.filter((e) => e.kind === "turn.agent.text").map((e) => String(e.payload.text ?? "")).join(""),
    failed: events.filter((e) => e.kind === "tool.error").length,
    rounds: usage.length,
    input: usage.reduce((n, e) => n + (e.payload.input_tokens ?? 0), 0),
    output: usage.reduce((n, e) => n + (e.payload.output_tokens ?? 0), 0),
    costUsd: usage.reduce((n, e) => n + (e.payload.cost_usd ?? 0), 0),
    log: events.map((e) => JSON.stringify(e.payload)).join("\n"),
  };
};

/** One task, once, from nothing. `script` plays a scripted model instead of the real one. */
async function attempt(task: Task, script?: Scripted[]): Promise<Outcome> {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "autora-eval-")));
  await task.setup?.(dir);
  const app = await startApp({ env: { AUTORA_WORKDIR: dir } });
  try {
    if (script) app.script.push(...script);
    else {
      const provider = process.env.EVAL_PROVIDER, model = process.env.EVAL_MODEL;
      if (!provider || !model) throw new Error("Set EVAL_PROVIDER and EVAL_MODEL (and the vendor's API key), or use --selftest.");
      const set = await app.api("PATCH", "/api/settings", { provider, models: { [provider]: model } });
      if (set.status >= 300) throw new Error(`could not select ${provider}/${model}: ${JSON.stringify(set.body)}`);
    }
    const session = await app.newSession(task.id, task.mode ?? "build");
    const started = Date.now();
    // A model that asks the person something gets "you decide": the eval has no one to answer.
    const answering = setInterval(() => {
      void app.events(session).then((ev) => {
        const answered = new Set(ev.filter((e) => e.kind === "ask.answer").map((e) => e.payload.ask_id));
        for (const e of ev) {
          if (e.kind === "ask.request" && !answered.has(e.payload.ask_id)) {
            void app.api("POST", `/api/sessions/${session}/ask/${e.payload.ask_id}`, { text: "You decide.", choices: [] });
          }
        }
      }).catch(() => undefined);
    }, 1500);
    let events: Ev[] = [];
    let timedOut = false;
    try { events = await app.turn(session, task.prompt, timeout); }
    catch { timedOut = true; events = await app.events(session); }
    clearInterval(answering);
    // What the person is handed is the file card in the thread. Office files and
    // PDFs the agent makes live in the app's file store, not the folder, so each
    // card is fetched into the folder as the person would download it.
    for (const e of events.filter((x) => x.kind === "media.file")) {
      const res = await fetch(`${app.base}/api/artifacts/${e.payload.id}`).catch(() => null);
      if (res?.ok) fs.writeFileSync(path.join(dir, path.basename(String(e.payload.name))), Buffer.from(await res.arrayBuffer()));
    }
    const run = toRun(events, dir, Date.now() - started, timedOut);
    const checks = [
      ...(timedOut ? [{ name: "the turn ended in time", pass: false }] : []),
      ...await task.checks(run),
    ];
    const heavy: string[] = [];
    if (task.budget?.rounds && run.rounds > task.budget.rounds) heavy.push(`${run.rounds} rounds (budget ${task.budget.rounds})`);
    if (task.budget?.tokens && run.input + run.output > task.budget.tokens) heavy.push(`${run.input + run.output} tokens (budget ${task.budget.tokens})`);
    const { dir: _d, reply, log: _l, ...rest } = run;
    return { id: task.id, area: task.area, pass: checks.every((c) => c.pass), checks, heavy, run: rest, reply };
  } finally {
    await app.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const pct = (n: number, d: number) => `${Math.round((100 * n) / Math.max(d, 1))}%`;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1);

async function selfTest(): Promise<number> {
  let bad = 0;
  for (const task of chosen) {
    // A model that does nothing must fail: a check that passes on nothing measures nothing.
    const idle = await attempt(task, [{ text: "ok" }]);
    // Not every task can fail on nothing by design (a plain question has no folder to check).
    const idleOk = !idle.pass;
    if (!idleOk) { bad++; console.log(`  BAD   ${task.id}: passes when the agent does nothing`); }
    if (task.reference) {
      const good = await attempt(task, task.reference);
      if (!good.pass) {
        bad++;
        console.log(`  BAD   ${task.id}: its reference solution fails: ${good.checks.filter((c) => !c.pass).map((c) => `${c.name}${c.note ? ` (${c.note})` : ""}`).join("; ")}`);
      } else console.log(`  ok    ${task.id}: reference passes, doing nothing fails`);
    } else if (idleOk) console.log(`  ok    ${task.id}: doing nothing fails (no reference solution to try)`);
    if (task.violation) {
      const wrong = await attempt(task, task.violation);
      if (wrong.pass) { bad++; console.log(`  BAD   ${task.id}: a run that does what the task forbids still passes`); }
      else console.log(`  ok    ${task.id}: breaking the rule fails (${wrong.checks.filter((c) => !c.pass).map((c) => c.name).join("; ")})`);
    }
  }
  console.log(bad ? `\n${bad} problem(s) in the eval itself.` : `\nThe eval's checks tell good from nothing on all ${chosen.length} tasks.`);
  return bad ? 1 : 0;
}

async function main(): Promise<number> {
  if (!chosen.length) { console.error(`No task matches ${filters.join(", ")}.`); return 1; }
  if (selftest) return selfTest();

  const all: Outcome[] = [];
  for (const task of chosen) {
    for (let i = 0; i < runs; i++) {
      let o: Outcome;
      try { o = await attempt(task); }
      catch (err) { console.error(`\n${task.id}: could not run: ${(err as Error).message}`); return 1; }
      all.push(o);
      const failed = o.checks.filter((c) => !c.pass);
      console.log(`${o.pass ? "PASS" : "FAIL"}  ${task.area.padEnd(9)} ${task.id.padEnd(30)} ${String(o.run.rounds).padStart(2)} rounds ${String(o.run.calls.length).padStart(2)} calls ${String(o.run.input + o.run.output).padStart(7)} tok ${(o.run.ms / 1000).toFixed(0).padStart(3)}s${o.heavy.length ? `  HEAVY: ${o.heavy.join(", ")}` : ""}`);
      for (const c of failed) console.log(`        x ${c.name}${c.note ? ` (${c.note})` : ""}`);
      if (failed.length) console.log(`        said: ${o.reply.replace(/\s+/g, " ").slice(0, 160)}`);
    }
  }

  console.log("\nBy area (checks passed / tasks fully passed / mean tokens / mean cost)");
  for (const area of ["work", "guide", "safe", "honest", "efficient"] as const) {
    const rows = all.filter((o) => o.area === area);
    if (!rows.length) continue;
    const c = rows.flatMap((o) => o.checks);
    console.log(`  ${area.padEnd(10)} ${pct(c.filter((x) => x.pass).length, c.length).padStart(4)} checks  ${pct(rows.filter((o) => o.pass).length, rows.length).padStart(4)} tasks  ${Math.round(mean(rows.map((o) => o.run.input + o.run.output))).toString().padStart(7)} tok  $${mean(rows.map((o) => o.run.costUsd)).toFixed(3)}`);
  }
  console.log(`  total      ${pct(all.filter((o) => o.pass).length, all.length)} of ${all.length} runs fully passed; $${all.reduce((n, o) => n + o.run.costUsd, 0).toFixed(2)} spent`);

  const out = value("out");
  if (out) {
    fs.writeFileSync(out, JSON.stringify({ when: new Date().toISOString(), provider: process.env.EVAL_PROVIDER, model: process.env.EVAL_MODEL, runs, results: all }, null, 2));
    console.log(`kept in ${out}`);
  }
  const base = value("compare");
  if (base) compare(JSON.parse(fs.readFileSync(base, "utf8")).results as Outcome[], all);
  return all.every((o) => o.pass) ? 0 : 1;
}

/** Per task: pass rate then and now, and the change in tokens. Small samples are said to be small. */
function compare(then: Outcome[], now: Outcome[]) {
  console.log("\nAgainst the kept run");
  const ids = [...new Set(now.map((o) => o.id))];
  for (const id of ids) {
    const a = then.filter((o) => o.id === id), b = now.filter((o) => o.id === id);
    if (!a.length) { console.log(`  ${id.padEnd(30)} new`); continue; }
    const rate = (xs: Outcome[]) => xs.filter((o) => o.pass).length / xs.length;
    const tok = (xs: Outcome[]) => mean(xs.map((o) => o.run.input + o.run.output));
    const d = rate(b) - rate(a);
    const dt = tok(a) ? Math.round((100 * (tok(b) - tok(a))) / tok(a)) : 0;
    console.log(`  ${id.padEnd(30)} ${pct(a.filter((o) => o.pass).length, a.length).padStart(4)} -> ${pct(b.filter((o) => o.pass).length, b.length).padStart(4)}  ${d < 0 ? "WORSE " : d > 0 ? "better" : "same  "}  tokens ${dt >= 0 ? "+" : ""}${dt}%${Math.min(a.length, b.length) < 3 ? "  (under 3 runs each: a hint, not a result)" : ""}`);
  }
}

main().then((code) => process.exit(code), (err) => { console.error(err); process.exit(1); });
