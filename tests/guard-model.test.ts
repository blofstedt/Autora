/**
 * The model's judgement of a risky call: asked once, and only ever able to
 * stop a call when it is sure. The cases that matter are the failures -- a
 * reply that is not JSON, half an answer, a model that errors or never
 * answers -- each of which has to let the work run, because a guard that
 * stops work whenever it is unsure is one people learn to click through.
 *
 *   npx tsx tests/guard-model.test.ts
 */
import assert from "node:assert/strict";
import {
  JUDGE_SYSTEM, declined, judgeAction, judgePrompt, matchesAskRule, parseApproval, parseAskRule, parseJudgement, shouldHold,
} from "../server/guard";

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    throw err;
  }
}

const input = { request: "clean up the old build output", reason: "removing dist", tool: "terminal", rendered: "rm -rf dist" };
const says = (text: string) => async () => text;

await test("only destructive and not asked for holds a call", () => {
  assert.equal(shouldHold({ destructive: true, requested: false }), true);
  assert.equal(shouldHold({ destructive: true, requested: true }), false, "the person asked for it");
  assert.equal(shouldHold({ destructive: false, requested: false }), false, "routine work");
  assert.equal(shouldHold({ destructive: false, requested: true }), false);
  assert.equal(shouldHold(null), false, "not knowing is not a hold");
});

await test("a reply is read out of whatever it comes wrapped in", () => {
  const want = { destructive: true, requested: false };
  assert.deepEqual(parseJudgement('{"destructive": true, "requested": false}'), want);
  assert.deepEqual(parseJudgement('```json\n{"destructive":true,"requested":false}\n```'), want);
  assert.deepEqual(parseJudgement('Here is my answer: {"destructive": "yes", "requested": "No"} done'), want);
});

await test("half an answer, or none, or nonsense, is not a judgement", () => {
  for (const bad of ["", "I think it is fine", "{}", '{"destructive": true}', '{"destructive": "maybe", "requested": false}',
    "{not json}", "[true,false]", '{"destructive": 1, "requested": 0}']) {
    assert.equal(parseJudgement(bad), null, bad);
  }
});

await test("the model is asked with the request, the reason and the exact action, cut to size", () => {
  const prompt = judgePrompt({ ...input, request: "x".repeat(5000) });
  assert.match(prompt, /clean up the old build output|xxx/);
  assert.match(prompt, /removing dist/);
  assert.match(prompt, /\(terminal\):\nrm -rf dist/);
  assert.ok(prompt.length < 4000);
  assert.match(JUDGE_SYSTEM, /JSON only/);
  assert.match(JUDGE_SYSTEM, /When unsure, answer destructive false/);
});

await test("judging: a sure destructive-and-unrequested reply holds; everything else does not", async () => {
  assert.equal(shouldHold(await judgeAction(says('{"destructive":true,"requested":false}'), input)), true);
  assert.equal(shouldHold(await judgeAction(says('{"destructive":true,"requested":true}'), input)), false);
  assert.equal(shouldHold(await judgeAction(says('{"destructive":false,"requested":false}'), input)), false);
});

await test("a model that errors, or says nothing usable, lets the call run", async () => {
  const boom = async () => { throw new Error("429 rate limited"); };
  assert.equal(await judgeAction(boom, input), null);
  assert.equal(shouldHold(await judgeAction(boom, input)), false);
  assert.equal(await judgeAction(says("Sure! I'd be happy to help."), input), null);
});

await test("a model that never answers is given up on, in time", async () => {
  const never = () => new Promise<string>(() => undefined);
  const started = Date.now();
  assert.equal(await judgeAction(never, input, 40), null);
  assert.ok(Date.now() - started < 1500);
});

await test("the person's answer: only a clear no is a decline", async () => {
  assert.equal(parseApproval('{"approved": false}'), false);
  assert.equal(parseApproval('{"approved": true}'), true);
  assert.equal(parseApproval("no idea"), null);
  assert.equal(await declined(says('{"approved":false}'), "rm -rf dist", "no, don't"), true);
  assert.equal(await declined(says('{"approved":true}'), "rm -rf dist", "yes go"), false);
  assert.equal(await declined(says("hmm"), "rm -rf dist", "maybe"), false, "ambiguous is not a refusal");
  assert.equal(await declined(async () => { throw new Error("down"); }, "rm -rf dist", "no"), false, "an error is not a refusal");
});

await test("the person's words for when to ask: only a clear 'unrelated' lets a call through", async () => {
  const call = { rules: "deleting files", tool: "terminal", rendered: "rm -rf dist" };
  assert.equal(parseAskRule('{"ask": false}'), false);
  assert.equal(parseAskRule('{"ask": "yes"}'), true);
  assert.equal(parseAskRule("who knows"), null);
  assert.equal(await matchesAskRule(says('{"ask": true}'), call), true);
  assert.equal(await matchesAskRule(says('{"ask": false}'), call), false);
  assert.equal(await matchesAskRule(says("hmm"), call), true, "an unreadable answer asks the person");
  assert.equal(await matchesAskRule(async () => { throw new Error("down"); }, call), true, "an error asks the person");
  assert.equal(await matchesAskRule(() => new Promise<string>(() => undefined), call, 30), true, "a model that never answers asks the person");
});

console.log(`\n${passed} guard-model cases passed.`);
