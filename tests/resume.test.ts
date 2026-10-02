/**
 * Work that was cut off is picked up by the turn that follows.
 *
 *   npx tsx tests/resume.test.ts
 */
import assert from "node:assert/strict";
import { interruptedWork, resumeNote, type ResumeEvent } from "../server/resume";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const ev = (kind: string, payload: Record<string, any> = {}): ResumeEvent => ({ kind, payload });
const user = (text: string) => ev("turn.user", { text });
const call = (name = "terminal") => ev("tool.call", { name });
const done = (payload: Record<string, any> = {}) => ev("turn.agent.done", payload);
const todos = (...items: [string, string][]) =>
  ev("todo.update", { items: items.map(([title, status]) => ({ title, status })) });

console.log("interrupted work");

test("a turn that finished leaves nothing to resume", () => {
  assert.equal(interruptedWork([user("fix the build"), call(), done()]), null);
});

test("a turn the person stopped after it had begun work is carried on", () => {
  const w = interruptedWork([user("rename the helpers across the repo"), call(), call(), done({ stopped: true })]);
  assert.ok(w);
  assert.deepEqual(w!.requests, ["rename the helpers across the repo"]);
  assert.equal(w!.tools, 2);
  assert.equal(w!.cause, "stopped");
});

test("a turn stopped before it did anything is not worth resuming", () => {
  assert.equal(interruptedWork([user("hello"), done({ stopped: true })]), null);
});

test("open to-do items count even when no tool had run", () => {
  const w = interruptedWork([user("plan the migration"), todos(["write the plan", "completed"], ["run it", "not-started"]), done({ stopped: true })]);
  assert.ok(w);
  assert.deepEqual(w!.open.map((i) => i.title), ["run it"]);
});

test("a to-do list from earlier, finished work is not carried over", () => {
  const w = interruptedWork([
    user("old job"), todos(["step", "not-started"]), done(),
    user("new job"), call(), done({ stopped: true }),
  ]);
  assert.ok(w);
  assert.deepEqual(w!.open, []);
});

test("a restart is told as a restart", () => {
  const w = interruptedWork([user("deploy"), call(), done({ interrupted: true })]);
  assert.equal(w!.cause, "restart");
  assert.match(resumeNote(w!), /restarted/);
});

test("interrupting twice keeps the first task and lists what was said since", () => {
  const w = interruptedWork([
    user("migrate the database"), call(), done({ stopped: true }),
    user("also add an index on email"), call(), done({ stopped: true }),
  ]);
  assert.ok(w);
  assert.deepEqual(w!.requests, ["migrate the database", "also add an index on email"]);
  assert.equal(w!.tools, 2);
  const note = resumeNote(w!);
  assert.match(note, /first asked: "migrate the database"/);
  assert.match(note, /- "also add an index on email"/);
});

test("a finished turn in between ends the chain", () => {
  const w = interruptedWork([
    user("a"), call(), done({ stopped: true }),
    user("b"), call(), done(),
    user("c"), call(), done({ stopped: true }),
  ]);
  assert.deepEqual(w!.requests, ["c"]);
});

test("the note says to carry on, not start over, unless told to drop it", () => {
  const note = resumeNote(interruptedWork([user("write the report"), call(), done({ stopped: true })])!);
  assert.match(note, /carry on with the interrupted work/);
  assert.match(note, /do not start it over/);
  assert.match(note, /drop it/);
});

test("a long request is shortened, and a shown line is preferred", () => {
  const w = interruptedWork([ev("turn.user", { text: "x".repeat(2000), shown: "review the app" }), call(), done({ stopped: true })]);
  assert.deepEqual(w!.requests, ["review the app"]);
  const long = interruptedWork([user("y".repeat(2000)), call(), done({ stopped: true })]);
  assert.ok(long!.requests[0].length < 700);
});

test("a turn the loop watch ended says why, and not to repeat it", () => {
  const w = interruptedWork([user("fix the deploy"), call(), done({ stopped: true, reason: "Stopped: terminal failed with the same error across 6 different attempts." })]);
  assert.match(w!.reason ?? "", /6 different attempts/);
  const note = resumeNote(w!);
  assert.match(note, /going in circles/);
  assert.match(note, /Do not make those attempts again/);
});

console.log(`${passed} passed`);
