/**
 * Failures with the same error add up even when the arguments differ.
 *
 *   npx tsx tests/errorbudget.test.ts
 */
import assert from "node:assert/strict";
import { BUDGET_MAX_AGE_MS, ErrorBudget } from "../server/errorbudget";

console.log("error budget");
const err = (n: number) => `Error: cannot find module './x${n}' at line ${n}\n stack`;

const b = new ErrorBudget();
assert.equal(b.record("terminal", "npm test a", false, err(1)).note, null);
assert.equal(b.record("terminal", "npm test b", false, err(2)).note, null);
const third = b.record("terminal", "npm test c", false, err(3));
assert.match(third.note ?? "", /3 times.*3 different/s);
assert.match(third.note ?? "", /npm test c/);
b.record("terminal", "d", false, err(4));
b.record("terminal", "e", false, err(5));
assert.match(b.record("terminal", "f", false, err(6)).stop ?? "", /6 different attempts/);
console.log("  ok  varied retries add up and stop");

const c = new ErrorBudget();
for (let i = 0; i < 10; i += 1) {
  const v = c.record("terminal", `cmd ${i}`, i % 2 === 0, i % 2 === 0 ? "fine" : `different problem ${"x".repeat(i)}`);
  assert.equal(v.stop, null);
}
console.log("  ok  successes and different errors are left alone");

{
  const d = new ErrorBudget();
  for (let i = 0; i < 12; i += 1) {
    const v = d.record("terminal", "npm test", false, "FAIL one test");
    assert.equal(v.stop, null, "the same command run again after an edit is work, not a loop");
  }
  console.log("  ok  repeats of one attempt are not variations");
}

{
  const a = new ErrorBudget();
  a.record("terminal", "x1", false, err(1));
  a.record("terminal", "x2", false, err(2));
  const b = new ErrorBudget(3, 6, a.snapshot());
  assert.match(b.record("terminal", "x3", false, err(3)).note ?? "", /3 different/);
  console.log("  ok  what a chat has used carries into its next turn");
}

{
  let t = 1_000_000;
  const a = new ErrorBudget(3, 6, {}, () => t);
  a.record("terminal", "x1", false, err(1));
  a.record("terminal", "x2", false, err(2));
  t += BUDGET_MAX_AGE_MS + 1;
  const b = new ErrorBudget(3, 6, a.snapshot(), () => t);
  assert.equal(b.record("terminal", "x3", false, err(3)).note, null);
  assert.equal(Object.keys(b.snapshot()).length, 1, "the old error is forgotten");
  console.log("  ok  an old error is forgotten");
}

{
  const a = new ErrorBudget();
  a.record("terminal", "x1", false, err(1));
  a.record("terminal", "x2", false, err(2));
  a.record("terminal", "ok", true, "fine");
  assert.equal(a.record("terminal", "x3", false, err(3)).note, null, "a success counts against what it had failed at");
  console.log("  ok  a success by the same tool eases the count");
}
