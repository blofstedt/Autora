/**
 * When the console may start a turn by itself: a background job finished, and
 * the agent said it would look. Every refusal has its own sentence and its own
 * place in the order, so the cases pin the order -- the person's switch and
 * hours before money, money before rate -- and that a job is woken for once.
 *
 *   npx tsx tests/proactive.test.ts
 */
import assert from "node:assert/strict";
import {
  DEFAULT_WAKE_POLICY, WAKE_MAX_AGE_MS, WAKE_MAX_PER_HOUR, mayWake, wakePrompt, wakesWanted,
  type WakeCandidate, type WakePolicy,
} from "../server/proactive";

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

const job = (over: Partial<WakeCandidate> = {}): WakeCandidate => ({
  id: "bg-1", note: "the build", command: "npm run build", exit: 0, session: "s1", finished: 1000, state: "finished", ...over,
});
const policy = (over: Partial<WakePolicy> = {}): WakePolicy => ({
  ...DEFAULT_WAKE_POLICY, enabled: true, spentToday: 0, recentWakes: 0, ageMs: 1000, busy: false, sessionExists: true, ...over,
});

test("by default a wake never happens", () => {
  assert.deepEqual(mayWake(job(), { ...policy(), enabled: DEFAULT_WAKE_POLICY.enabled }), { wake: false, why: "proactivity is off" });
});

test("a finished job in a quiet session, on budget, is worth a wake", () => {
  assert.deepEqual(mayWake(job(), policy()), { wake: true });
  assert.deepEqual(mayWake(job({ exit: 2, state: "failed" }), policy()), { wake: true });
});

test("each refusal says why, in the order a person would ask", () => {
  const why = (c: Partial<WakeCandidate>, p: Partial<WakePolicy>) => {
    const d = mayWake(job(c), policy(p));
    return d.wake ? "wake" : d.why;
  };
  assert.equal(why({}, { quiet: true, spentToday: 99 }), "quiet hours");
  assert.equal(why({ exit: null, state: "running" }, {}), "the job has not stopped");
  assert.equal(why({ state: "gone" }, {}), "the job has not stopped");
  assert.equal(why({}, { sessionExists: false, busy: true }), "its session is gone");
  assert.equal(why({}, { busy: true, ageMs: 1e12 }), "its session is already working");
  assert.match(why({}, { ageMs: WAKE_MAX_AGE_MS + 1, recentWakes: 9 }), /too long ago/);
  assert.equal(why({}, { recentWakes: WAKE_MAX_PER_HOUR, spentToday: 99 }), `already ${WAKE_MAX_PER_HOUR} wakes this hour`);
  assert.equal(why({}, { spentToday: 1, dailyUsd: 1 }), "today's automation budget is spent");
  assert.equal(why({}, { ageMs: WAKE_MAX_AGE_MS }), "wake");
});

test("newest first, once per job, never more than the limit", () => {
  const jobs = [job({ id: "a", finished: 1 }), job({ id: "b", finished: 4 }), job({ id: "c", finished: 3 }), job({ id: "d", finished: 2 })];
  const picked = wakesWanted(jobs, new Set(["c"]), () => policy(), 2);
  assert.deepEqual(picked.map((j) => j.id), ["b", "d"]);
  assert.deepEqual(wakesWanted(jobs, new Set(), () => policy({ enabled: false })), []);
  assert.deepEqual(jobs.map((j) => j.id), ["a", "b", "c", "d"], "the caller's list is left as it was");
});

test("each job is judged on its own policy", () => {
  const jobs = [job({ id: "a", session: "gone" }), job({ id: "b", session: "s1" })];
  const picked = wakesWanted(jobs, new Set(), (c) => policy({ sessionExists: c.session !== "gone" }));
  assert.deepEqual(picked.map((j) => j.id), ["b"]);
});

test("the prompt is an instruction to report, names the job and its command, and forbids new work", () => {
  const ok = wakePrompt(job());
  assert.match(ok, /finished successfully/);
  assert.match(ok, /bg-1 -- "the build"/);
  assert.match(ok, /npm run build/);
  assert.match(ok, /this turn is to report, not to act/);
  assert.match(wakePrompt(job({ exit: 137 })), /stopped with exit code 137/);
  assert.doesNotMatch(wakePrompt(job({ note: "" })), / -- ""/);
});
console.log(`\n${passed} proactive cases passed.`);
