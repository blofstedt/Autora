/**
 * The automation budget: the guard that has to work while nobody is looking.
 *
 * It is checked in two places -- before a job starts, and every round of a run
 * already going -- and its whole point is what it must never do: delete a job,
 * clear a cron, or stop a turn the person is having. So the tests are about
 * the arithmetic of the day rolling over, the clamps, and which of the two
 * questions each check answers.
 *
 *   npx tsx tests/automation.test.ts
 */
import assert from "node:assert/strict";

const auto = await import("../server/automation");
const {
  AUTOMATION_DEFAULTS, addSpend, blankLedger, budgetLine, mergeAutomation, overDay, overRun,
  rollLedger, skipReason, stopReason,
} = auto;
type AutomationBudget = import("../server/automation").AutomationBudget;
type AutomationLedger = import("../server/automation").AutomationLedger;

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

const budget = (over: Partial<AutomationBudget> = {}): AutomationBudget => ({
  ...AUTOMATION_DEFAULTS,
  ...over,
});

test("the defaults hold automation to a dollar a day and a run to a quarter", () => {
  assert.equal(AUTOMATION_DEFAULTS.enabled, true);
  assert.equal(AUTOMATION_DEFAULTS.dailyUsd, 1);
  assert.equal(AUTOMATION_DEFAULTS.runUsd, 0.25);
});

test("a fresh day does not spend yesterday's money", () => {
  let ledger = blankLedger("2026-09-28");
  ledger = addSpend(ledger, 0.6);
  assert.equal(ledger.usd, 0.6);
  assert.equal(overDay(budget({ dailyUsd: 0.5 }), ledger), true, "spent for the 28th");

  const monday = rollLedger(ledger, "2026-09-29");
  assert.equal(monday.usd, 0, "a new day starts at nothing");
  assert.equal(monday.runs, 0);
  assert.equal(overDay(budget({ dailyUsd: 0.5 }), monday), false, "and the jobs may run again");
});

test("a restart in the middle of the day keeps what has been spent", () => {
  const saved = addSpend(blankLedger("2026-09-29"), 0.8);
  const after = rollLedger(saved, "2026-09-29");
  assert.equal(after.usd, 0.8, "not handed a fresh budget");
  assert.equal(overDay(budget(), after), false, "20 cents left");
  assert.equal(overDay(budget(), addSpend(after, 0.2)), true, "and then it is spent");
});

test("a ledger that is missing or nonsense is a blank one, never a crash", () => {
  assert.equal(rollLedger(null, "2026-09-29").usd, 0);
  assert.equal(rollLedger(undefined, "2026-09-29").usd, 0);
  assert.equal(rollLedger({ day: "2026-09-29", usd: Number.NaN } as AutomationLedger, "2026-09-29").usd, 0);
});

test("turning the budget off lets everything through, and still counts", () => {
  const off = budget({ enabled: false });
  const spent = addSpend(blankLedger("2026-09-29"), 40);
  assert.equal(overDay(off, spent), false, "no daily stop");
  assert.equal(overRun(off, 40), false, "and no per-run stop");
  assert.equal(spent.usd, 40, "what it cost is still written down");
});

test("a run is stopped on its own budget, not the day's", () => {
  const b = budget();
  const ledger = addSpend(blankLedger("2026-09-29"), 0.9);
  assert.equal(overDay(b, ledger), false, "the day is not spent yet");
  assert.equal(overRun(b, 0.1), false, "a run well inside its own share carries on");
  assert.equal(overRun(b, 0.25), true, "a run at its limit is stopped");
  assert.equal(overDay(b, addSpend(ledger, 0.1)), true, "and so is the day when it lands");
});

test("the knobs are clamped, so a typo cannot switch the guard off", () => {
  const into = budget();
  mergeAutomation(into, { dailyUsd: -5, runUsd: 0 });
  assert.equal(into.dailyUsd, 0.05, "never zero, so it never means off");
  assert.equal(into.runUsd, 0.01);

  const high = budget();
  mergeAutomation(high, { dailyUsd: 10_000, runUsd: 10_000 });
  assert.equal(high.dailyUsd, 50);
  assert.equal(high.runUsd, 10);

  const bad = budget();
  mergeAutomation(bad, { dailyUsd: "lots", enabled: "yes" });
  assert.equal(bad.dailyUsd, AUTOMATION_DEFAULTS.dailyUsd, "a non-number changes nothing");
  assert.equal(bad.enabled, true, "and neither does a non-boolean");
});

test("a job held back is told its schedule is untouched", () => {
  const why = skipReason("Keep Umbrel's store clone up with main", budget());
  assert.match(why, /automation budget/);
  assert.match(why, /runs again after midnight/, "the job is not deleted, and it says so");
  assert.match(why, /Keep Umbrel/);
});

test("a run stopped part-way says what it cost and when it runs again", () => {
  const why = stopReason(budget({ runUsd: 0.25 }), 0.31);
  assert.match(why, /\$0\.31/);
  assert.match(why, /\$0\.25/);
  assert.match(why, /runs again at its next time/);
});

test("the line the person reads counts what is left, and what sat out", () => {
  const ledger = addSpend(blankLedger("2026-09-29"), 0.4);
  assert.match(budgetLine(budget(), ledger), /\$0\.40 of \$1\.00/);
  assert.match(budgetLine(budget(), ledger), /\$0\.60 left/);
  ledger.skipped = 3;
  assert.match(budgetLine(budget(), ledger), /3 not started/);
  assert.match(budgetLine(budget({ enabled: false }), ledger), /budget off/i);
});

console.log(`\n${passed} tests passed.`);
