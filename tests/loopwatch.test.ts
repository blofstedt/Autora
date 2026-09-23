/**
 * The loop watch: repeats get a note, ignoring the notes stops the turn, and
 * work that is actually moving is left alone.
 *
 *   npx tsx tests/loopwatch.test.ts
 */
import assert from "node:assert/strict";
import { LoopWatch } from "../server/loopwatch";

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
    stop = watch.record("terminal", { command: "curl x" }, false, "Connection refused").stop;
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
  const watch = new LoopWatch();
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

console.log(`\n${passed} passed`);
