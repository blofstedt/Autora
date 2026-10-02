/**
 * The loop watch: repeats get a note, ignoring the notes stops the turn, and
 * work that is actually moving is left alone.
 *
 *   npx tsx tests/loopwatch.test.ts
 */
import assert from "node:assert/strict";
import { LOOP_DEFAULTS, LoopWatch } from "../server/loopwatch";
import { mergeLoop } from "../server/state";

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    throw err;
  }
}

console.log("loop watch");

test("new work is left alone", () => {
  const watch = new LoopWatch();
  for (let i = 0; i < 30; i += 1) {
    const v = watch.record("terminal", { command: `step ${i}` }, true, `output ${i}`);
    assert.equal(v.note, null);
    assert.equal(v.stop, null);
  }
});

test("the same call with the same result is called out on the third time", () => {
  const watch = new LoopWatch();
  assert.equal(watch.record("browser_read", {}, true, "Sign in").note, null);
  assert.equal(watch.record("browser_read", {}, true, "Sign in").note, null);
  const third = watch.record("browser_read", {}, true, "Sign in");
  assert.match(third.note ?? "", /3rd time/);
  assert.ok(third.log);
  // Said in the thread once, not on every repeat after.
  assert.equal(watch.record("browser_read", {}, true, "Sign in").log, null);
});

test("argument order and changing numbers do not hide a repeat", () => {
  const watch = new LoopWatch();
  watch.record("terminal", { command: "npm test", cwd: "/app" }, false, "failed after 1203ms (pid 44)");
  watch.record("terminal", { cwd: "/app", command: "npm test" }, false, "failed after 988ms (pid 51)");
  const v = watch.record("terminal", { command: "npm test", cwd: "/app" }, false, "failed after 1500ms (pid 60)");
  assert.match(v.note ?? "", /3rd time/);
});

test("the same call failing differently each time is told to step back", () => {
  const watch = new LoopWatch();
  watch.record("browser_click", { ref: 4 }, false, "element detached");
  watch.record("browser_click", { ref: 4 }, false, "timed out");
  const v = watch.record("browser_click", { ref: 4 }, false, "not visible");
  assert.match(v.note ?? "", /failed 3 times/);
});

test("repeating after the notes stops the turn", () => {
  const watch = new LoopWatch();
  let stop: string | null = null;
  for (let i = 0; i < 8 && !stop; i += 1) {
    stop = watch.record("read_file", { path: "x" }, true, "Connection refused").stop;
  }
  assert.match(stop ?? "", /8 times/);
});

test("two calls taking turns are caught as going in circles", () => {
  const watch = new LoopWatch({ warnAt: 99, stopAt: 99 });
  watch.record("browser_scroll", { dy: 500 }, true, "scrolled");
  watch.record("browser_read", {}, true, "same page");
  let note: string | null = null;
  for (let i = 0; i < 10 && !note; i += 1) {
    note = watch.record(i % 2 ? "browser_read" : "browser_scroll", i % 2 ? {} : { dy: 500 }, true,
      i % 2 ? "same page" : "scrolled").note;
  }
  assert.match(note ?? "", /going in circles/);
});

test("a checkpoint comes every twenty rounds, naming the repeats", () => {
  const watch = new LoopWatch({ stallAfter: 200 });
  for (let i = 0; i < 5; i += 1) watch.record("browser_read", {}, true, `page ${"x".repeat(i)}`);
  let checkpoint: string | null = null;
  for (let round = 1; round <= 20; round += 1) {
    const c = watch.endRound();
    if (round < 20) assert.equal(c, null);
    else checkpoint = c;
  }
  assert.match(checkpoint ?? "", /20 rounds/);
  assert.match(checkpoint ?? "", /browser_read \(x5\)/);
});


/* ---- the knobs are settings now ------------------------------------------

   They were constants in the source: a turn could be stopped by a rule the
   person could not see, let alone change. These are the same watches, run
   with the numbers the panel can set. */

test("a custom config is what the watch uses", () => {
  const watch = new LoopWatch({ warnAt: 2, stopAt: 4, staleAfter: 3, checkEvery: 5 });
  assert.equal(watch.record("browser_read", {}, true, "Sign in").note, null);
  assert.match(watch.record("browser_read", {}, true, "Sign in").note ?? "", /2nd time/);
});

test("posted numbers are clamped, and a stop always comes after a warning", () => {
  const loose = mergeLoop({ ...LOOP_DEFAULTS }, { warnAt: 5, stopAt: 2, staleAfter: 0, checkEvery: 9999 });
  assert.equal(loose.warnAt, 5);
  assert.ok(loose.stopAt > loose.warnAt);
  assert.equal(loose.staleAfter, 2);
  assert.equal(loose.checkEvery, 500);

  const nonsense = mergeLoop({ ...LOOP_DEFAULTS }, { warnAt: "lots", stopAt: null });
  assert.deepEqual(nonsense, LOOP_DEFAULTS);
});

test("a call that keeps failing the same way is stopped sooner than a read", () => {
  const failing = new LoopWatch();
  let stopped = 0;
  for (let i = 1; i <= LOOP_DEFAULTS.stopAt; i += 1) {
    if (failing.record("terminal", { command: "make" }, false, "make: *** error").stop) { stopped = i; break; }
  }
  assert.ok(stopped > 0 && stopped < LOOP_DEFAULTS.stopAt, `stopped at ${stopped}`);
  const reading = new LoopWatch();
  for (let i = 1; i < LOOP_DEFAULTS.stopAt; i += 1) assert.equal(reading.record("read_file", { path: "a" }, true, "same").stop, null);
});

test("a repeat made after the warning is refused, only that exact call, and refusals end in a stop", () => {
  const watch = new LoopWatch();
  for (let i = 0; i < LOOP_DEFAULTS.warnAt; i += 1) watch.record("read_file", { path: "a" }, true, "same");
  assert.deepEqual(watch.gate("read_file", { path: "a" }), { refuse: null, stop: null }, "the warning comes first");
  watch.record("read_file", { path: "a" }, true, "same"); // ignored the note
  const refused = watch.gate("read_file", { path: "a" });
  assert.match(refused.refuse ?? "", /Not run/);
  assert.equal(watch.gate("read_file", { path: "b" }).refuse, null, "a different call is the change asked for");
  let stop: string | null = null;
  for (let i = 0; i < 6 && !stop; i += 1) stop = watch.gate("read_file", { path: "a" }).stop;
  assert.match(stop ?? "", /kept calling/);
});

test("a refused call may be tried again once something has changed", () => {
  const watch = new LoopWatch();
  for (let i = 0; i <= LOOP_DEFAULTS.warnAt; i += 1) watch.record("terminal", { command: "npm test" }, false, "1 failing");
  assert.match(watch.gate("terminal", { command: "npm test" }).refuse ?? "", /Not run/);
  watch.advance(); // an edit happened
  assert.deepEqual(watch.gate("terminal", { command: "npm test" }), { refuse: null, stop: null });
});

test("rounds that change nothing earn a stall note, and a change resets the count", () => {
  const watch = new LoopWatch({ stallAfter: 3, checkEvery: 500 });
  assert.equal(watch.endRound(), null);
  assert.equal(watch.endRound(), null);
  assert.match(watch.endRound() ?? "", /\[Stall\].*3 rounds/);
  watch.advance();
  assert.equal(watch.endRound(), null);
  assert.equal(watch.endRound(), null);
  assert.equal(watch.endRound(), null, "the count started again from the change");
  assert.match(watch.endRound() ?? "", /\[Stall\]/);
});

test("the stall setting is clamped", () => {
  assert.equal(mergeLoop({ ...LOOP_DEFAULTS }, { stallAfter: 0 }).stallAfter, 3);
  assert.equal(mergeLoop({ ...LOOP_DEFAULTS }, { stallAfter: 9999 }).stallAfter, 200);
});

console.log(`\nloop watch: ${passed} passed`);
