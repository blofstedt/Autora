/**
 * The paid-in total must not be inflated by a reading gone wrong, a payment
 * the console works out for itself can be seen and taken back, and the month
 * is the vendor's own arithmetic.
 *
 *   npx tsx tests/vendor-money-guard.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AUTORA_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autora-vendor-guard-"));

const { refreshVendorMoney, vendorMoneyFor, setTopUp, undoAutoTopUp } = await import("../server/vendor-money");
const { state } = await import("../server/state");
const { billingSummary } = await import("../server/billing");

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    throw err;
  }
}

const near = (got: number | null | undefined, want: number) =>
  assert.ok(typeof got === "number" && Math.abs(got - want) < 1e-9, `${got} != ${want}`);

/* A clock the test moves, and a till that says whatever the test says. */
let clock = new Date(2026, 9, 7, 12, 0, 0).getTime();
Date.now = () => clock;
const minutes = (n: number) => { clock += n * 60_000; };
let till: string | null = null;
globalThis.fetch = (async () => ({
  ok: true,
  json: async () => ({
    balance_infos: till === null ? [] : [{ currency: "USD", total_balance: till, topped_up_balance: till }],
  }),
})) as unknown as typeof fetch;

function fresh(balance: string, paidIn: number | null) {
  for (const table of [state.balances, state.balanceAts, state.topUps, state.pendingReadings, state.autoTopUps, state.monthBases]) {
    for (const key of Object.keys(table)) delete (table as Record<string, unknown>)[key];
  }
  state.keys.deepseek = "test-key";
  state.provider = "deepseek";
  till = balance;
  return refreshVendorMoney("deepseek").then(() => {
    if (paidIn !== null) setTopUp("deepseek", paidIn);
  });
}

await test("a rise is not a payment until a later reading agrees", async () => {
  await fresh("2.20", 30);
  till = "25.00"; // a reading gone wrong, or a real payment: not known yet
  minutes(10);
  await refreshVendorMoney("deepseek");
  near(state.topUps.deepseek, 30);
  near(vendorMoneyFor("deepseek")?.balance_usd, 2.2); // the last believed reading stays

  till = "2.20"; // it was a blip
  minutes(10);
  await refreshVendorMoney("deepseek");
  near(state.topUps.deepseek, 30);
  assert.equal(state.pendingReadings.deepseek, undefined);
  near(vendorMoneyFor("deepseek")?.lifetime_usd, 27.8);
});

await test("a drop to nothing waits for confirmation too", async () => {
  await fresh("25.00", 30);
  till = "0.00";
  minutes(10);
  await refreshVendorMoney("deepseek");
  near(vendorMoneyFor("deepseek")?.balance_usd, 25);
  till = "24.00"; // the glitch passed
  minutes(10);
  await refreshVendorMoney("deepseek");
  near(vendorMoneyFor("deepseek")?.balance_usd, 24);
  assert.equal((state.autoTopUps.deepseek ?? []).length, 0);
  near(state.topUps.deepseek, 30);
});

await test("a payment that stays is counted, logged, and can be taken back", async () => {
  await fresh("2.20", 30);
  till = "32.20";
  minutes(10);
  await refreshVendorMoney("deepseek");
  near(state.topUps.deepseek, 30); // seen once
  minutes(10);
  await refreshVendorMoney("deepseek");
  near(state.topUps.deepseek, 60);
  near(vendorMoneyFor("deepseek")?.lifetime_usd, 27.8); // a payment spends nothing
  const log = vendorMoneyFor("deepseek")?.auto_top_ups ?? [];
  assert.equal(log.length, 1);
  near(log[0].usd, 30);

  assert.equal(undoAutoTopUp("deepseek", log[0].at), true);
  near(state.topUps.deepseek, 30);
  assert.equal(undoAutoTopUp("deepseek", log[0].at), false); // already gone
});

await test("two readings in quick succession are not a confirmation", async () => {
  await fresh("2.20", 30);
  till = "25.00";
  minutes(10);
  await refreshVendorMoney("deepseek");
  await refreshVendorMoney("deepseek"); // same instant
  near(state.topUps.deepseek, 30);
});

await test("the month is the vendor's own spend since the month began", async () => {
  await fresh("20.00", 30); // 10 spent by Oct 7
  near(vendorMoneyFor("deepseek")?.month_real_usd, 0);
  till = "15.00";
  minutes(10);
  await refreshVendorMoney("deepseek");
  near(vendorMoneyFor("deepseek")?.month_real_usd, 5);

  /* Into November: the last October reading is where November began. */
  clock = new Date(2026, 10, 2, 9, 0, 0).getTime();
  till = "12.00";
  await refreshVendorMoney("deepseek");
  near(vendorMoneyFor("deepseek")?.lifetime_usd, 18);
  near(vendorMoneyFor("deepseek")?.month_real_usd, 3); // 18 - 15
});

await test("correcting the paid-in total does not move the month", async () => {
  await fresh("20.00", 53.35);
  till = "15.00";
  minutes(10);
  await refreshVendorMoney("deepseek");
  const before = vendorMoneyFor("deepseek")?.month_real_usd;
  near(before, 5);
  setTopUp("deepseek", 29.99);
  near(vendorMoneyFor("deepseek")?.month_real_usd, 5);
  near(vendorMoneyFor("deepseek")?.lifetime_usd, 14.99);
});

await test("the month tile takes the vendor's own month", async () => {
  await fresh("20.00", 30);
  till = "15.00";
  minutes(10);
  await refreshVendorMoney("deepseek");
  const b = billingSummary();
  near(b.month.cost, 5);
});

console.log(`\n${passed} passed`);
