/**
 * Failures with the same error add up even when the arguments differ.
 *
 *   npx tsx tests/errorbudget.test.ts
 */
import assert from "node:assert/strict";
import { ErrorBudget } from "../server/errorbudget";

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
assert.match(b.record("terminal", "f", false, err(6)).stop ?? "", /6 times/);
console.log("  ok  varied retries add up and stop");

const c = new ErrorBudget();
for (let i = 0; i < 10; i += 1) {
  const v = c.record("terminal", `cmd ${i}`, i % 2 === 0, i % 2 === 0 ? "fine" : `different problem ${"x".repeat(i)}`);
  assert.equal(v.stop, null);
}
console.log("  ok  successes and different errors are left alone");
