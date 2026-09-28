/**
 * The real total: what has been paid in, less what the vendor says is left.
 *
 * The number this replaces is counted from token counts, and counting cannot
 * see a call that was charged without reporting what it used -- an answer
 * stopped mid-sentence, an attempt retried after a dropped connection. So the
 * counted figure is always the lower of the two and the gap is invisible,
 * which is the whole reason the balance is used instead.
 *
 * What is checked here is that arithmetic, and the rule it is built on: it
 * invents nothing. No balance read, nothing known to have been paid in, or a
 * balance sitting above what was paid in all mean "not known", and every
 * caller then falls back to counting.
 *
 *   npx tsx tests/vendor-money.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AUTORA_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autora-vendor-money-"));

const { realSpend, vendorMoney } = await import("../server/vendor-money");
const { recordUsage, clearUsage, state } = await import("../server/state");
const { billingSummary } = await import("../server/billing");

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

const DAY = 86400;
const now = Math.floor(Date.now() / 1000);

/** What the vendor is holding, and what has been paid in, as settings hold it. */
function vendor(balance: number | null, toppedUp: number | null) {
  state.balanceUsd = balance;
  state.topUpUsd = toppedUp;
  state.balanceAt = now;
}

function call(ts: number, cost: number) {
  recordUsage({
    ts, session: "t", provider: "deepseek", model: "deepseek-flash",
    input: 1000, output: 100, cost, priced: true, estimated: false,
  });
}

test("spend is what was paid in, less what is left", () => {
  near(realSpend(20.3, 30) ?? -1, 9.7);
  near(realSpend(0, 25) ?? -1, 25);
  /* Nothing paid in is nothing to spend from: a real figure of zero here
     would print "$0.00 spent" over an account that cannot have spent. */
  assert.equal(realSpend(20.3, 0), null);
});

test("an unreadable pair is not a guess", () => {
  assert.equal(realSpend(null, 30), null);
  assert.equal(realSpend(20.3, null), null);
  assert.equal(realSpend(Number.NaN, 30), null);
  /* A balance above what was paid in means one of the two is stale. */
  assert.equal(realSpend(35, 30), null);
});

test("vendorMoney says nothing until both figures are known", () => {
  vendor(null, null);
  assert.equal(vendorMoney(), null);
  vendor(20.3, null);
  assert.equal(vendorMoney(), null);

  vendor(20.3, 30);
  const money = vendorMoney();
  assert.ok(money);
  near(money.lifetime_usd, 9.7);
  near(money.balance_usd, 20.3);
  near(money.topped_up_usd, 30);
});

test("the all-time total is the vendor's, not the count", () => {
  clearUsage();
  vendor(20.3, 30);
  call(now, 0.1);

  const b = billingSummary();
  assert.ok(b.real);
  near(b.real.lifetime_usd, 9.7);
  near(b.real.counted_usd, 0.1);
  near(b.real.unaccounted_usd, 9.6);
  near(b.lifetime.cost, 9.7);
  /* Every turn on the ledger is in this month, so the month is the same money
     and carries the part counting cannot see. */
  near(b.month.cost, 9.7);
});

test("a ledger reaching into another month keeps the month counted", () => {
  clearUsage();
  /* Well outside this month, so the month figure and the lifetime are no
     longer the same money and the difference must not be pushed into it. */
  const longAgo = now - 60 * DAY;
  vendor(20.3, 30);
  call(longAgo, 0.1);

  const b = billingSummary();
  near(b.lifetime.cost, 9.7);
  near(b.month.cost, 0);
});

test("with no balance to read, the total goes back to counting", () => {
  clearUsage();
  vendor(null, null);
  call(now, 0.25);

  const b = billingSummary();
  assert.equal(b.real, null);
  near(b.lifetime.cost, 0.25);
  near(b.month.cost, 0.25);
});

console.log(`\n${passed} passed`);
