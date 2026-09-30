/**
 * The person's standing instructions against the console's own style rules.
 *
 * "Be brief" and "use bullet points" were in the prompt every turn and still
 * lost to "plain prose" and "give your final answer in full" above them, so
 * the cases are the collisions: a default that says it is a default, rules
 * that come last, and a short set that rides on the turn's own note.
 *
 *   npx tsx tests/prompt.test.ts
 */
import assert from "node:assert/strict";
import { REMINDER_LIMIT, replyStyle, standingBlock, standingReminder } from "../server/prompt";

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

const RULES = "Be concise. Answer in bullet points, three at most.";

test("with no standing instructions the defaults stand as they were", () => {
  const style = replyStyle(false).join("\n");
  assert.match(style, /plain prose/);
  assert.match(style, /final answer in full/);
  assert.doesNotMatch(style, /standing instructions/);
  assert.deepEqual(standingBlock(""), []);
  assert.equal(standingReminder(""), null);
});

test("with them, the defaults say they are defaults and give way by name", () => {
  const style = replyStyle(true).join("\n");
  assert.match(style, /defaults: the person's standing instructions/);
  assert.match(style, /decide length and format/);
  // The line that contradicted "be brief" is not there to be weighed against it.
  assert.doesNotMatch(style, /final answer in full/);
  assert.match(style, /as briefly or fully as their standing instructions ask/);
});

test("their block comes last and names length and format as theirs to decide", () => {
  const all = [...replyStyle(true), ...standingBlock(RULES)];
  const block = all.join("\n");
  assert.ok(block.trimEnd().endsWith("=== END STANDING INSTRUCTIONS ==="));
  assert.ok(block.indexOf(RULES) > block.indexOf("Answer as the console"));
  assert.match(block, /length, format and\ntone included/);
});

test("short rules are repeated whole on the turn's note", () => {
  const note = standingReminder(RULES)!;
  assert.ok(note.includes(RULES));
  assert.match(note, /length and format included/);
});

test("a long set is pointed at, not repeated on every round", () => {
  const long = "Rule. ".repeat(400);
  assert.ok(long.length > REMINDER_LIMIT);
  const note = standingReminder(long)!;
  assert.ok(!note.includes(long));
  assert.match(note, /Re-read them before you answer/);
});
console.log(`\n${passed} prompt cases passed.`);
