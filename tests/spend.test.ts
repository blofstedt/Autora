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
import { barVendor, combineVendorViews, creditTotal, spendView, vendorSpendView } from "../src/lib/spend";

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

/* One bar per vendor. The complaint these answer: with money at two vendors,
   one bar drew the whole ledger against one ceiling and said 101.21 of $20.
   Each vendor's bar is now its own account's arithmetic, and nobody else's
   turns are in it. */

const vendor = (over: Partial<Parameters<typeof vendorSpendView>[0]> = {}) =>
  vendorSpendView({
    provider: "deepseek",
    label: "DeepSeek",
    spent: null,
    paid: null,
    balance: null,
    ...over,
  });

test("a vendor's bar measures its own credit consumed of its own paid-in", () => {
  const v = vendor({ spent: 26.96, paid: 30, balance: 3.04 });
  near(v.used, 26.96 / 30);
  assert.equal(v.paid, 30);
  assert.equal(v.remaining, false);
  assert.equal(v.over, false);
  assert.equal(v.near, true);
});

test("two vendors draw two bars, neither counting the other's money", () => {
  const deepseek = vendor({ spent: 26.96, paid: 30, balance: 3.04 });
  const orca = vendor({ provider: "orcarouter", label: "Orca Router", spent: 9.66, paid: 20.07, balance: 10.41 });
  near(deepseek.used, 26.96 / 30);
  near(orca.used, 9.66 / 20.07);
  assert.equal(deepseek.drawn, 26.96);
  assert.equal(orca.drawn, 9.66);
  assert.notEqual(deepseek.used, orca.used);
});

test("a vendor over its credit says over, and stops at full", () => {
  const v = vendor({ spent: 34, paid: 30, balance: 0 });
  near(v.used, 1);
  assert.equal(v.over, true);
  assert.equal(v.near, false);
});

test("a vendor that says what is left but not what was paid in draws that as remaining", () => {
  const v = vendor({ spent: null, paid: null, balance: 12.5 });
  assert.equal(v.remaining, true);
  near(v.drawn, 12.5);
  assert.equal(v.paid, null);
  near(v.used, 1);
  assert.equal(v.show, true);
});

test("credit bought and not yet touched is still worth a bar", () => {
  const v = vendor({ spent: 0, paid: 30, balance: 30 });
  near(v.used, 0);
  assert.equal(v.show, true);
});

test("a vendor with nothing readable at all is left out, not drawn as zero", () => {
  assert.equal(vendor().show, false);
});

test("a spend with no paid-in figure falls back to what is left with the vendor", () => {
  const v = vendor({ spent: 26.96, paid: null, balance: 3.04 });
  assert.equal(v.remaining, true);
  near(v.drawn, 3.04);
});

test("rubbish in a vendor's line reads as nothing rather than as a number", () => {
  const v = vendor({ spent: Number.NaN, paid: Number.NaN, balance: Number.NaN });
  assert.equal(v.show, false);
  near(v.used, 0);
});

/** The line of /api/usage the bar has to choose between, in the shape it
    actually arrives: the account in use, and another vendor whose turns are in
    the same ledger. */
function line(extra: Partial<{
  provider: string;
  label: string;
  topped_up_usd: number | null;
  balance_usd: number;
  lifetime_usd: number | null;
  headline: boolean;
  selected: boolean;
  month_usd: number;
}>) {
  return {
    provider: "deepseek",
    label: "DeepSeek",
    topped_up_usd: 30,
    balance_usd: 2.64,
    lifetime_usd: 27.36,
    headline: false,
    selected: true,
    month_usd: 3.2,
    ...extra,
  };
}

const other = line({
  provider: "orcarouter",
  label: "Orca Router",
  topped_up_usd: null,
  balance_usd: 0,
  lifetime_usd: null,
  selected: false,
  month_usd: 91.2,
});

test("the bar draws the account in use, not the ledger's mixed month", () => {
  const chosen = barVendor([line({}), other]);
  assert.equal(chosen?.provider, "deepseek");
  near(creditTotal(chosen ?? null) ?? -1, 30);

  /* What the bar does with it: the credit is the meter, the money consumed is
     the vendor's, and the vendor's own month is what sits beside it. */
  const v = spendView({
    spent: chosen?.month_usd ?? 0,
    session: 0.03,
    budget: 20,
    lifetime: chosen?.lifetime_usd ?? 0,
    credit: creditTotal(chosen ?? null) ?? undefined,
  });
  assert.equal(v.onCredit, true);
  near(v.drawn, 27.36);
  near(v.meter, 30);
  /* The $20 ceiling belongs to the ledger's month, not to another API's
     dollars: DeepSeek's own month is well under it and the bar is not "over". */
  assert.equal(v.over, false);
});

test("with no account marked, the headline line still draws the bar", () => {
  const headline = line({ provider: "openai", label: "OpenAI", selected: false, headline: true });
  assert.equal(barVendor([headline, other])?.provider, "openai");
});

test("one readable line is drawn even when it is not the headline", () => {
  const only = line({ provider: "openai", label: "OpenAI", selected: false, headline: false });
  assert.equal(barVendor([only, other])?.provider, "openai");
});

test("nothing readable is no bar at all, and the month keeps the slot", () => {
  const blind = line({ topped_up_usd: null, lifetime_usd: null, balance_usd: 0, selected: true });
  assert.equal(barVendor([blind]), null);
  assert.equal(barVendor(null), null);
  assert.equal(barVendor([]), null);
});

test("the combined bar adds each credited vendor and skips balance-only ones", () => {
  const a = vendorSpendView({ provider: "deepseek", label: "DeepSeek", spent: 6, paid: 10, balance: 4 });
  const b = vendorSpendView({ provider: "openai", label: "OpenAI", spent: 9, paid: 10, balance: 1 });
  const c = vendorSpendView({ provider: "gemini", label: "Gemini", spent: null, paid: null, balance: 7 });
  const total = combineVendorViews([a, b, c]);
  assert.equal(total.count, 2);
  assert.equal(total.drawn, 15);
  assert.equal(total.paid, 20);
  assert.equal(total.used, 0.75);
  assert.equal(total.near, false);
  assert.equal(total.show, true);
  assert.equal(combineVendorViews([c]).show, false);
});

console.log(`${passed} passed`);
