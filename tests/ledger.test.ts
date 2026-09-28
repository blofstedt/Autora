/**
 * The spend ledger when it turns over.
 *
 * The ledger keeps the last few thousand calls and folds what falls off the
 * end into running totals. Those totals used to be a lump sum with no dates
 * in them, so "this month" and "today" -- the two figures the page actually
 * shows -- dropped the spend that had aged out, and read low against the
 * vendor's own bill. What is checked here is that a day's spend survives
 * falling off the end, and lands back on the day it happened on.
 *
 *   npx tsx tests/ledger.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AUTORA_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autora-ledger-"));

const { recordUsage, clearUsage, carriedTotals, carriedDays } = await import("../server/state");
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
  assert.ok(Math.abs(got - want) < 1e-6, `${got} != ${want}`);

const DAY = 86400;
const now = Math.floor(Date.now() / 1000);
const EACH = 0.002;

function call(ts: number) {
  recordUsage({
    ts, session: "t", provider: "deepseek", model: "deepseek-flash",
    input: 1000, output: 100, cost: EACH, priced: true, estimated: false,
  });
}

test("spend that falls off the ledger is still in today and this month", () => {
  clearUsage();
  /* Yesterday's three go first, so they are what the ledger drops when
     today's calls push past the end of it. */
  for (let i = 0; i < 3; i += 1) call(now - DAY);
  for (let i = 0; i < 5000; i += 1) call(now);

  const carried = carriedTotals();
  near(carried.cost, EACH * 3);
  assert.equal(carried.turns, 3);

  const b = billingSummary();
  near(b.lifetime.cost, EACH * 5003);
  /* Before the fix this read EACH * 5000: the three that aged out were in
     the lifetime figure and nowhere else. */
  near(b.month.cost, EACH * 5003);
  near(b.today.cost, EACH * 5000);
  near(b.budget.spent, EACH * 5003);

  const today = b.daily[b.daily.length - 1];
  near(today.cost, EACH * 5000);
});

test("the dated copy is what the month figure reads", () => {
  const days = carriedDays();
  assert.deepEqual(Object.keys(days), [dayKeyOf(now - DAY)]);
  near(days[dayKeyOf(now - DAY)].cost, EACH * 3);
});

test("a day past the keeping window stops being counted", () => {
  clearUsage();
  near(billingSummary().month.cost, 0);
  near(carriedTotals().cost, 0);
  assert.deepEqual(Object.keys(carriedDays()), []);
});

function dayKeyOf(ts: number) {
  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

console.log(`\nledger: ${passed} passed`);
