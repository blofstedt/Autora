/**
 * The spend bar's arithmetic.
 *
 * Two numbers, one bar: the month against the ceiling, and this session's
 * share of it at the right-hand end. The cases that matter are the ones that
 * look wrong when they are wrong -- a ceiling passed, no ceiling at all, a
 * session whose cost outlived the ledger it was counted in.
 *
 *   npm test
 */
import assert from "node:assert/strict";
import { spendView } from "../src/lib/spend";

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

const near = (got: number, want: number) =>
  assert.ok(Math.abs(got - want) < 1e-9, `${got} != ${want}`);

test("a month well under its ceiling fills the bar by its share", () => {
  const v = spendView({ spent: 4.5, session: 0.6, budget: 10 });
  near(v.used, 0.45);
  near(v.slice, 0.06);
  assert.equal(v.over, false);
  assert.equal(v.near, false);
  assert.equal(v.show, true);
});

test("the last fifth of a ceiling warns instead of shouting", () => {
  const v = spendView({ spent: 8.5, session: 0, budget: 10 });
  assert.equal(v.near, true);
  assert.equal(v.over, false);
});

test("exactly the ceiling is spent, not over it", () => {
  const v = spendView({ spent: 10, session: 0, budget: 10 });
  near(v.used, 1);
  assert.equal(v.over, false);
  assert.equal(v.near, true);
});

test("past the ceiling the bar stops at full and says so", () => {
  const v = spendView({ spent: 12.34, session: 1.5, budget: 10 });
  near(v.used, 1);
  near(v.slice, 0.15);
  assert.equal(v.over, true);
  assert.equal(v.near, false);
});

test("with no ceiling the bar is the month, and the session its share of it", () => {
  const v = spendView({ spent: 4, session: 1, budget: null });
  near(v.used, 1);
  near(v.slice, 0.25);
  assert.equal(v.cap, null);
  assert.equal(v.over, false);
  assert.equal(v.near, false);
});

test("a session that outlived the ledger cannot take more of the bar than the month has", () => {
  const v = spendView({ spent: 2, session: 9, budget: 10 });
  near(v.used, 0.2);
  near(v.slice, 0.2);
  assert.ok(v.slice <= v.used);
});

test("a budget of nothing is no budget, not a bar pinned to full", () => {
  for (const budget of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const v = spendView({ spent: 3, session: 1, budget });
    assert.equal(v.cap, null, `budget ${budget}`);
    near(v.used, 1);
    near(v.slice, 1 / 3);
  }
});

test("nothing spent and no ceiling is nothing to draw", () => {
  assert.equal(spendView({ spent: 0, session: 0, budget: null }).show, false);
});

test("a ceiling with a quiet month is still worth drawing", () => {
  assert.equal(spendView({ spent: 0, session: 0, budget: 10 }).show, true);
});

test("rubbish reads as nothing rather than as a number", () => {
  const v = spendView({ spent: Number.NaN, session: -1, budget: null });
  near(v.used, 0);
  near(v.slice, 0);
  assert.equal(v.show, false);
});

console.log(`${passed} passed`);
