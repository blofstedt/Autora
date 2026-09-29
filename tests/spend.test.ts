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
import { creditTotal, spendView } from "../src/lib/spend";

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

test("paid-in credit is the meter: consumed of what was bought", () => {
  const v = spendView({ spent: 15.58, session: 0.42, budget: 20, lifetime: 15.58, credit: 30 });
  assert.equal(v.onCredit, true);
  near(v.meter, 30);
  near(v.drawn, 15.58);
  near(v.used, 15.58 / 30);
  near(v.slice, 0.42 / 30);
  assert.equal(v.paid, 30);
});

test("without a credit reading the bar stays the month it always was", () => {
  const v = spendView({ spent: 15.58, session: 0.42, budget: 20, lifetime: 15.58, credit: null });
  assert.equal(v.onCredit, false);
  near(v.meter, 20);
  near(v.drawn, 15.58);
  assert.equal(v.paid, null);
});

test("a credit reading with nothing consumed yet does not draw a full bar", () => {
  const v = spendView({ spent: 0, session: 0, budget: null, lifetime: 0, credit: 30 });
  assert.equal(v.onCredit, false);
  near(v.used, 0);
  assert.equal(v.show, true); // the credit is still worth saying
});

test("rubbish credit is no credit", () => {
  for (const credit of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const v = spendView({ spent: 3, session: 1, budget: 10, lifetime: 3, credit });
    assert.equal(v.onCredit, false, `credit ${credit}`);
    assert.equal(v.paid, null, `credit ${credit}`);
  }
});

test("paid in comes from the topped-up total when the vendor says it", () => {
  near(creditTotal({ topped_up_usd: 30, balance_usd: 14.42, lifetime_usd: 15.58 }) ?? NaN, 30);
});

test("with no topped-up total, what is left plus what has gone is what was paid in", () => {
  near(creditTotal({ balance_usd: 14.42, lifetime_usd: 15.58 }) ?? NaN, 30);
});

test("nothing to read is null rather than zero", () => {
  assert.equal(creditTotal(null), null);
  assert.equal(creditTotal(undefined), null);
  assert.equal(creditTotal({}), null);
  assert.equal(creditTotal({ topped_up_usd: 0, balance_usd: 0, lifetime_usd: 0 }), null);
});

console.log(`${passed} passed`);
