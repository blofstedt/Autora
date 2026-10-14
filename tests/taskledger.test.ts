/**
 * What a task cost and whether it went well: the figures have to be right, or
 * they are worse than none.
 *
 * Checked here: a call is billed to the task that made it -- including when two
 * tasks interleave awaits, and for the look back after a turn has closed -- and
 * to nothing when no task is running; the kind of work comes from the tools
 * called, with ties broken the same way every time; "done well" is only the
 * person's mark, the project check, or an error, and a turn nothing speaks for
 * is unjudged rather than good; a task on an unpriced model is counted but
 * never priced; a price per good result appears only from five judged tasks
 * and counts the poor ones' money; an incognito chat leaves no record.
 *
 *   npx tsx tests/taskledger.test.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autora-taskledger-"));
process.env.AUTORA_STATE_DIR = dir;

const { recordUsage } = await import("../server/state");
const { flushStore, ephemeralId } = await import("../server/store");
const ledger = await import("../server/taskledger");
const {
  openTask, withTask, noteCall, noteCheck, closeTask, markTask, taskSummary, verdictOf,
  kindOfCall, kindOfTally, MIN_JUDGED,
} = ledger;

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

const spend = (session: string, cost: number, over: Record<string, unknown> = {}) =>
  recordUsage({
    ts: Math.floor(Date.now() / 1000), session, provider: "deepseek", model: "m", input: 100, output: 10,
    cost, priced: true, estimated: false, cached: 0, ...over,
  });

const open = (over: Record<string, unknown> = {}) => openTask({
  session: "s1", provider: "deepseek", model: "m", version: "1.0.0", automated: false, ...over,
} as Parameters<typeof openTask>[0]);

const only = (id: string | null) => {
  const row = taskSummary().recent.find((r) => r.id === id);
  assert.ok(row, "the task is on the books");
  return row;
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

await test("a call is billed to the task that made it, and only that one", async () => {
  const a = open();
  const b = open();
  const run = (id: string | null, costs: number[]) => withTask(id, async () => {
    for (const c of costs) { await wait(Math.random() * 5); spend("s1", c); }
  });
  /* Interleaved: if the scope leaked between them the sums would cross. */
  await Promise.all([run(a, [0.01, 0.02, 0.04]), run(b, [0.1, 0.2])]);
  spend("s1", 5); // no task running: nobody's
  closeTask(a, "finished", 10);
  closeTask(b, "finished", 10);
  assert.ok(Math.abs(only(a).cost - 0.07) < 1e-9);
  assert.ok(Math.abs(only(b).cost - 0.3) < 1e-9);
});

await test("the look back after the turn closes is still billed to it", async () => {
  const id = open();
  const done = withTask(id, () => Promise.resolve().then(() => spend("s1", 0.5)));
  await done;
  closeTask(id, "finished", 1);
  await withTask(id, async () => { await wait(2); spend("s1", 0.25); });
  assert.ok(Math.abs(only(id).cost - 0.75) < 1e-9);
});

await test("a closed task is not reopened or rewritten by a second close", () => {
  const id = open();
  closeTask(id, "failed", 1);
  closeTask(id, "finished", 1);
  assert.equal(only(id).outcome, "failed");
});

await test("an incognito chat leaves no record", () => {
  const before = taskSummary().tasks;
  const id = openTask({ session: ephemeralId(), provider: "deepseek", model: "m", version: "1", automated: false });
  assert.equal(id, null);
  withTask(id, () => { spend("x", 9); noteCall("terminal"); });
  assert.equal(taskSummary().tasks, before);
});

await test("the kind of work is read from the tools called", () => {
  assert.equal(kindOfCall("pdf_edit"), "pdf");
  assert.equal(kindOfCall("office_edit", { file: "Budget.XLSX" }), "spreadsheets");
  assert.equal(kindOfCall("office_create", { type: "pptx" }), "presentations");
  assert.equal(kindOfCall("office_create", { type: "docx" }), "documents");
  assert.equal(kindOfCall("office_guide", { domain: "sheets" }), "spreadsheets");
  assert.equal(kindOfCall("terminal"), "code");
  assert.equal(kindOfCall("browser_click"), "web");
  assert.equal(kindOfCall("mcp__github__create_issue"), "integrations");
  assert.equal(kindOfCall("memory_write"), null, "housekeeping says nothing about the work");
  assert.equal(kindOfCall("ask_user"), null);
  assert.equal(kindOfTally({}), "chat");
  assert.equal(kindOfTally({ code: 3, pdf: 1 }), "code", "the most calls wins");
  assert.equal(kindOfTally({ code: 2, pdf: 2 }), "pdf", "a tie goes to the deliverable, always");
});

await test("a turn takes its kind from what it did, as it did it", () => {
  const id = open();
  withTask(id, () => {
    noteCall("memory_write");
    noteCall("terminal"); noteCall("terminal");
    noteCall("office_create", { type: "xlsx" }); noteCall("office_edit", { file: "a.xlsx" }); noteCall("office_check", { file: "a.xlsx" });
  });
  closeTask(id, "finished", 1);
  assert.equal(only(id).kind, "spreadsheets");
});

await test("what says a task went well: the person, the check, an error -- nothing else", () => {
  const t = (over: object) => ({ mark: null, outcome: "finished", check: null, ...over }) as Parameters<typeof verdictOf>[0];
  assert.equal(verdictOf(t({})), null, "nothing said: unjudged, not good");
  assert.deepEqual(verdictOf(t({ check: "passed" })), { verdict: "good", source: "check" });
  assert.deepEqual(verdictOf(t({ check: "failed" })), { verdict: "poor", source: "check" });
  assert.deepEqual(verdictOf(t({ outcome: "failed" })), { verdict: "poor", source: "error" });
  assert.equal(verdictOf(t({ outcome: "stopped", check: "passed" })), null, "a stopped turn is not judged by a check it never finished");
  assert.deepEqual(verdictOf(t({ outcome: "failed", mark: "good" })), { verdict: "good", source: "rated" }, "the person's word wins");
  assert.deepEqual(verdictOf(t({ outcome: "stopped", mark: "poor" })), { verdict: "poor", source: "rated" });
});

await test("the last run of the project check stands", () => {
  const id = open();
  withTask(id, () => { noteCheck(false); noteCheck(true); });
  closeTask(id, "finished", 1);
  assert.equal(only(id).check, "passed");
});

await test("marking a task, and taking the mark back", () => {
  const id = open();
  closeTask(id, "finished", 1);
  assert.equal(only(id).verdict, null);
  assert.ok(markTask(id!, "good"));
  assert.equal(only(id).verdict, "good");
  assert.ok(markTask(id!, null));
  assert.equal(only(id).verdict, null);
  assert.equal(markTask("task-nope", "good"), false);
});

/* A clean slate for the arithmetic below: its own model, so nothing above is in it. */
const make = (model: string, cost: number, how: "good" | "poor" | "unjudged", over: Record<string, unknown> = {}) => {
  const id = open({ model, ...over });
  withTask(id, () => { noteCall("pdf_edit"); spend("s1", cost, over.priced === false ? { priced: false } : {}); });
  closeTask(id, "finished", 1);
  if (how !== "unjudged") markTask(id!, how);
  return id;
};
const cell = (model: string, version?: string) =>
  taskSummary({ version }).cells.find((c) => c.model === model && c.kind === "pdf");

await test("a price per good result needs five judged tasks, and counts the poor ones' money", () => {
  for (let i = 0; i < MIN_JUDGED - 1; i += 1) make("few", 1, "good");
  assert.equal(cell("few")!.perGood, null, "four judged tasks is an anecdote");
  assert.equal(cell("few")!.judged, 4);
  make("few", 1, "poor");
  const c = cell("few")!;
  assert.equal(c.judged, 5);
  /* $5 spent to get four good ones: $1.25 each, not the $1 a good one cost alone. */
  assert.ok(Math.abs(c.perGood! - 1.25) < 1e-9);
  assert.ok(Math.abs(c.goodRate! - 0.8) < 1e-9);
});

await test("no good result yet is no price, however much was spent", () => {
  for (let i = 0; i < MIN_JUDGED; i += 1) make("allbad", 2, "poor");
  assert.equal(cell("allbad")!.perGood, null);
  assert.equal(cell("allbad")!.good, 0);
  assert.equal(cell("allbad")!.goodRate, 0);
});

await test("a task nobody judged is counted, not guessed at", () => {
  for (let i = 0; i < 6; i += 1) make("quiet", 1, i < 5 ? "good" : "unjudged");
  const c = cell("quiet")!;
  assert.equal(c.tasks, 6);
  assert.equal(c.judged, 5);
  assert.equal(c.unjudged, 1);
  assert.ok(Math.abs(c.avgCost! - 1) < 1e-9);
  assert.ok(Math.abs(c.perGood! - 1) < 1e-9, "the unjudged task's dollar is not in the price of a good one");
});

await test("an unpriced model is counted and never priced", () => {
  for (let i = 0; i < 5; i += 1) make("free", 0, "good", { priced: false });
  const c = cell("free")!;
  assert.equal(c.tasks, 5);
  assert.equal(c.unpriced, 5);
  assert.equal(c.spend, 0);
  assert.equal(c.avgCost, null, "$0.00 would be a claim; unknown is the fact");
  assert.equal(c.perGood, null);
  assert.equal(c.judged, 0);
});

await test("a harness version can be asked for alone, and a mixed cell says so", () => {
  make("moving", 1, "good", { version: "1.0.0" });
  make("moving", 3, "good", { version: "1.0.10" });
  assert.deepEqual(cell("moving")!.versions, ["1.0.0", "1.0.10"], "ordered as numbers, not text");
  assert.equal(cell("moving", "1.0.10")!.tasks, 1);
  assert.ok(Math.abs(cell("moving", "1.0.10")!.spend - 3) < 1e-9);
  assert.equal(cell("moving", "9.9.9"), undefined);
});

await test("a task still running is not on the books yet", () => {
  const id = open({ model: "busy" });
  assert.equal(taskSummary().recent.find((r) => r.id === id), undefined);
  closeTask(id, "finished", 1);
});

await test("the books survive a restart, and a task cut off by one is not left running", async () => {
  const id = open({ model: "cut" });
  withTask(id, () => spend("s1", 0.4));
  flushStore();
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "tasks.json"), "utf8"));
  const rec = saved.tasks.find((r: { id: string }) => r.id === id);
  assert.ok(rec, "written to disk");
  assert.ok(Math.abs(rec.cost - 0.4) < 1e-9);
  assert.equal(rec.session, "s1");
  assert.equal(JSON.stringify(saved).includes("incognito"), false);
  assert.equal(rec.outcome, "running", "still open when written");

  /* A new process reading the same directory: the open task was cut short. */
  const script = path.join(os.tmpdir(), `autora-taskledger-${process.pid}.mts`);
  fs.writeFileSync(script, `const m = await import(${JSON.stringify(path.resolve("server/taskledger.ts"))});\n` +
    `const s = m.taskSummary();\nconsole.log(JSON.stringify({ n: s.tasks, row: s.recent.find((r) => r.id === ${JSON.stringify(id)}) }));\n`);
  const out = execFileSync("npx", ["tsx", script], { env: { ...process.env, AUTORA_STATE_DIR: dir }, encoding: "utf8" });
  fs.rmSync(script, { force: true });
  const back = JSON.parse(out.trim().split("\n").pop()!);
  assert.ok(back.n > 10, "the books came back");
  assert.equal(back.row.outcome, "stopped");
  assert.equal(back.row.verdict, null, "cut short is unjudged");
  assert.ok(Math.abs(back.row.cost - 0.4) < 1e-9);
});

console.log(`\n${passed} passed`);
