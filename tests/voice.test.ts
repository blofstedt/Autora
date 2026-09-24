/**
 * Dictation hands each spoken word over once, however the engine reports it.
 *
 *   npx tsx tests/voice.test.ts
 */
import assert from "node:assert/strict";
import { commit, newLedger, turnPause } from "../src/lib/voice";

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

/** Feed finals through one ledger, `gap` ms apart, and join what went out. */
function run(finals: string[], gap = 300): string {
  const ledger = newLedger();
  let now = 1_000_000;
  const out: string[] = [];
  for (const text of finals) {
    now += gap;
    const fresh = commit(ledger, text, now);
    if (fresh) out.push(fresh);
  }
  return out.join(" ");
}

test("Android staircase: each step holds the whole utterance so far", () => {
  assert.equal(
    run(["this", "this is", "this is", "this is a", "this is a test",
      "this is a test to see", "this is a test to see what you can do"]),
    "this is a test to see what you can do",
  );
});

test("a final that re-punctuates what went out adds only the new words", () => {
  assert.equal(run(["this is just", "This is just a test."]), "this is just a test.");
});

test("a word walked back and restated is not said twice", () => {
  assert.equal(run(["testing 1 2", "testing 1", "testing 1 2 3"]), "testing 1 2 3");
});

test("a restart replaying the utterance from the top adds nothing", () => {
  assert.equal(run(["open the file", "open the file"]), "open the file");
});

test("two requests that start alike both go out whole", () => {
  assert.equal(run(["Open the file", "Open the folder"], 2500), "Open the file Open the folder");
});

test("separate phrases are kept", () => {
  assert.equal(run(["hello there", "how are you"], 2000), "hello there how are you");
});

test("the same word said again later is not swallowed", () => {
  assert.equal(run(["yes", "yes"], 6000), "yes yes");
});

test("live chat waits through a normal breath before sending", () => {
  assert.ok(turnPause("open my email", true) >= 2000);
  assert.ok(turnPause("open my email", false) > turnPause("open my email", true));
});

test("a sentence left hanging waits longer", () => {
  assert.ok(turnPause("open my email and", true) > turnPause("open my email", true));
  assert.ok(turnPause("find the", false) > turnPause("find it", false));
  assert.ok(turnPause("so first, um", true) > turnPause("so first done", true));
  assert.ok(turnPause("check the calendar,", true) > turnPause("check the calendar", true));
});

console.log(`voice: ${passed} passed`);
