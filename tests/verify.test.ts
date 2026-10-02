/**
 * The project check: what a setting may be, and what the agent is told.
 *
 *   npx tsx tests/verify.test.ts
 */
import assert from "node:assert/strict";
import { previewNote, previewProblems, checkLine, failedNote, mergeVerify, VERIFY_DEFAULTS } from "../server/verify";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

console.log("verify");

test("it is off until a command is set", () => {
  assert.equal(VERIFY_DEFAULTS.command, "");
});

test("a command is one trimmed line, and the number of runs is bounded", () => {
  const v = mergeVerify({ ...VERIFY_DEFAULTS }, { command: "  npm run lint\nrm -rf /  ", tries: 99 });
  assert.equal(v.command, "npm run lint rm -rf /");
  assert.equal(v.tries, 10);
  assert.equal(mergeVerify({ ...VERIFY_DEFAULTS }, { tries: 0 }).tries, 1);
  assert.equal(mergeVerify({ ...VERIFY_DEFAULTS }, { command: 5, tries: "x" }).command, "");
  assert.equal(mergeVerify({ ...VERIFY_DEFAULTS, command: "make" }, null).command, "make");
  assert.equal(mergeVerify({ ...VERIFY_DEFAULTS }, { command: "x".repeat(2000) }).command.length, 500);
});

test("a failure is told with the raw output, and how many runs are left", () => {
  const note = failedNote({ command: "npm test", exitCode: 1, ok: false, output: "1 failing: adds numbers" }, 1, 3);
  assert.match(note, /`npm test` exited 1/);
  assert.match(note, /1 failing: adds numbers/);
  assert.match(note, /2 more runs/);
  assert.match(note, /not yours/);
});

test("the last run says it is still failing and not to claim a pass", () => {
  const note = failedNote({ command: "npm test", exitCode: 2, ok: false, output: "" }, 3, 3);
  assert.match(note, /last run/);
  assert.match(note, /still failing/);
  assert.match(note, /\(no output\)/);
});

test("the thread line says what happened", () => {
  assert.match(checkLine({ command: "make", exitCode: 0, ok: true, output: "" }, 1, 3), /passed/);
  assert.match(checkLine({ command: "make", exitCode: 1, ok: false, output: "" }, 1, 3), /sent back to fix/);
  assert.match(checkLine({ command: "make", exitCode: 1, ok: false, output: "" }, 3, 3), /still failing after 3 runs/);
  assert.match(checkLine({ command: "make", exitCode: null, ok: false, output: "" }, 1, 3), /did not finish/);
});

test("only errors raised since the change count, once each, and warnings never", () => {
  const log = [
    { kind: "error" as const, text: "old failure", ts: 100 },
    { kind: "warn" as const, text: "deprecated", ts: 600 },
    { kind: "error" as const, text: "TypeError: x is not a function", ts: 600 },
    { kind: "error" as const, text: "TypeError:   x is not a function", ts: 700 },
  ];
  assert.deepEqual(previewProblems(log, 500), ["TypeError: x is not a function"]);
  assert.deepEqual(previewProblems(log, 900), []);
});

test("a dev server that stopped is a problem, and the note says how many looks are left", () => {
  const p = previewProblems([], 0, { exit: 1, last: "EADDRINUSE" });
  assert.match(p[0], /dev server stopped \(exit 1\).*EADDRINUSE/);
  assert.match(previewNote(["boom"], 1, 2), /1 more look this turn/);
  assert.match(previewNote(["boom"], 2, 2), /last look/);
});

console.log(`${passed} passed`);
