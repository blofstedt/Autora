/**
 * The agent's working notes: what it settled and found out, kept in the log.
 *
 *   npx tsx tests/notes.test.ts
 */
import assert from "node:assert/strict";
import { applyLedger, emptyLedger, latestLedger, ledgerBriefing, touched, type LedgerEvent } from "../server/ledger";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}
const ev = (kind: string, payload: Record<string, any> = {}): LedgerEvent => ({ kind, payload });

console.log("ledger");

test("an empty ledger reads back as empty and says nothing to the agent", () => {
  assert.match(applyLedger(emptyLedger(), {}).summary, /empty/);
  assert.equal(ledgerBriefing(emptyLedger(), []), null);
});

test("goal, decisions, facts and next steps are kept, and added to", () => {
  const a = applyLedger(emptyLedger(), { goal: "rename helpers", decided: ["snake_case, because the API is"], learned: ["helpers live in src/lib"], next: ["rename a", "rename b"] });
  assert.ok(a.ledger);
  const b = applyLedger(a.ledger!, { learned: ["tests are in tests/"], next: ["rename b"] });
  assert.equal(b.ledger!.goal, "rename helpers");
  assert.deepEqual(b.ledger!.facts, ["helpers live in src/lib", "tests are in tests/"]);
  assert.deepEqual(b.ledger!.next, ["rename b"], "next replaces");
  assert.deepEqual(b.ledger!.decisions.length, 1, "decisions stay");
});

test("the same line twice is one line, and a full list keeps the newest", () => {
  let l = emptyLedger();
  l = applyLedger(l, { learned: ["a", "A", "a "] }).ledger!;
  assert.deepEqual(l.facts, ["a"]);
  for (let i = 0; i < 30; i++) l = applyLedger(l, { learned: [`fact ${i}`] }).ledger!;
  assert.equal(l.facts.length, 20);
  assert.equal(l.facts[19], "fact 29");
});

test("forget drops matching lines; reset starts again", () => {
  let l = applyLedger(emptyLedger(), { goal: "g", decided: ["use redis"], learned: ["redis is on 6379", "api is v2"], next: ["start redis"] }).ledger!;
  l = applyLedger(l, { forget: ["redis"] }).ledger!;
  assert.deepEqual(l.decisions, []);
  assert.deepEqual(l.facts, ["api is v2"]);
  assert.deepEqual(l.next, []);
  assert.deepEqual(applyLedger(l, { reset: true }).ledger, emptyLedger());
});

test("long lines are cut, and a string is accepted where a list is meant", () => {
  const l = applyLedger(emptyLedger(), { learned: "one\ntwo", goal: "x".repeat(900) }).ledger!;
  assert.deepEqual(l.facts, ["one", "two"]);
  assert.ok(l.goal.length <= 240);
});

test("the ledger is the last one written in the log", () => {
  const log = [ev("ledger.update", { goal: "old", facts: ["a"] }), ev("tool.call"), ev("ledger.update", { goal: "new", facts: ["b"], next: ["c"] })];
  const l = latestLedger(log);
  assert.equal(l.goal, "new");
  assert.deepEqual(l.next, ["c"]);
  assert.deepEqual(latestLedger([]), emptyLedger());
});

test("what was touched is read off the calls, newest last, each once", () => {
  const log = [
    ev("tool.call", { name: "read_file", args: { path: "src/a.ts" } }),
    ev("tool.call", { name: "edit_file", args: { path: "src/b.ts" } }),
    ev("file.edit", { path: "src/a.ts", created: false }),
    ev("file.edit", { path: "src/c.ts", by: "person" }),
    ev("tool.call", { name: "browser_open", args: { url: "http://x.test/" } }),
    ev("tool.call", { name: "pdf_edit", args: { artifact: "art_1" } }),
    ev("tool.call", { name: "terminal", args: { command: "ls" } }),
  ];
  const t = touched(log);
  assert.deepEqual(t, ["src/b.ts (edited)", "src/a.ts (edited)", "src/c.ts (the person changed it)", "http://x.test/ (opened)", "art_1 (pdf_edit)"]);
});

test("the briefing carries both, and says to trust and keep them", () => {
  const l = applyLedger(emptyLedger(), { goal: "ship it", next: ["run tests"] }).ledger!;
  const b = ledgerBriefing(l, ["src/a.ts (edited)"])!;
  assert.match(b, /Goal: ship it/);
  assert.match(b, /1\. run tests/);
  assert.match(b, /src\/a\.ts \(edited\)/);
  assert.match(b, /ledger tool/);
  assert.ok(ledgerBriefing(emptyLedger(), ["x (read)"]), "touched alone is worth saying");
});

console.log(`${passed} passed`);
