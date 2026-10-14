/**
 * Small talk: what is answered at once, and what is left to the full turn.
 *
 * The cases that matter are the ones that must NOT be quick: a word that can
 * mean "go ahead" has to start the work it is approving.
 *
 *   npx tsx tests/quick.test.ts
 */
import assert from "node:assert/strict";
import { isSmallTalk } from "../server/quick";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

test("greetings, thanks and tests are small talk", () => {
  for (const text of [
    "hi", "Hello!", "hey there", "Good morning", "how are you?", "what's up",
    "just saying hi", "thanks", "Thank you so much!", "this is just a test.", "test", "ping", "nvm",
  ]) assert.equal(isSmallTalk(text), true, text);
});

test("an @name does not change what the rest of the message is", () => {
  assert.equal(isSmallTalk("@Reggie just saying hi"), true);
  assert.equal(isSmallTalk("@Sabrina this is just a test."), true);
  assert.equal(isSmallTalk("@Reggie"), false, "a name alone says nothing");
  assert.equal(isSmallTalk("@Reggie check the ledger"), false);
});

test("anything that could be an instruction is not", () => {
  for (const text of [
    "ok", "yes", "sure", "great", "go ahead", "do it", "continue", "no",
    "hi, can you rename the files", "thanks, now fix the header", "test the login page",
    "hello world in python", "what's up with the build", "run the test suite",
  ]) assert.equal(isSmallTalk(text), false, text);
});

test("an empty or long message is not", () => {
  assert.equal(isSmallTalk(""), false);
  assert.equal(isSmallTalk("   "), false);
  assert.equal(isSmallTalk("hi ".repeat(40)), false);
});

console.log(`\n${passed} passed`);
