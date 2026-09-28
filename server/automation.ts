/**
 * What automated runs are allowed to cost.
 *
 * A scheduled job or watcher runs in a session of its own, and a session of
 * its own loads the whole prompt, the tool list and the memory that goes with
 * it before the job has done anything at all. That is a fixed cost per
 * firing, and a watcher pointed at something that changes often -- a release,
 * a build, a feed -- pays it again every single time. Left unmeasured that is
 * how a quiet background job becomes the largest line on the bill: nothing
 * was watching the watchers.
 *
 * So automation has a budget apart from what the person spends talking to the
 * agent, checked twice:
 *
 *  - before a job is allowed to start: what all automated runs have cost
 *    today, against the day's budget;
 *  - every round of a run that is already going: what this one run has cost,
 *    against the per-run budget, so a single job that has begun to chew
 *    through a session is stopped rather than left to finish.
 *
 * Neither check ever deletes or disables a job. A job that has run out of
 * budget keeps its cron, its next time and its place: it is the spending that
 * is stopped, not the schedule, and the person is told once when it happens.
 */

export interface AutomationBudget {
  /** Whether the budget is enforced at all. */
  enabled: boolean;
  /** What all automated runs together may cost in a day, in USD. */
  dailyUsd: number;
  /** What one automated run may cost, in USD, before it is stopped. */
  runUsd: number;
}

export const AUTOMATION_DEFAULTS: AutomationBudget = {
  enabled: true,
  dailyUsd: 1,
  runUsd: 0.25,
};

/** Sane ranges, so a mistyped number cannot switch the guard off by accident
    or stop every job on its first round. */
const LIMITS = {
  dailyUsd: [0.05, 50] as const,
  runUsd: [0.01, 10] as const,
};

export function mergeAutomation(into: AutomationBudget, patch: any): AutomationBudget {
  if (typeof patch?.enabled === "boolean") into.enabled = patch.enabled;
  for (const key of ["dailyUsd", "runUsd"] as const) {
    const [low, high] = LIMITS[key];
    const n = Number(patch?.[key]);
    if (Number.isFinite(n)) into[key] = Math.min(high, Math.max(low, n));
  }
  return into;
}

/** What automated runs have spent, by day. */
export interface AutomationLedger {
  /** The day this counts for, as billing's day key. */
  day: string;
  /** What runs have cost today. */
  usd: number;
  /** How many runs finished today. */
  runs: number;
  /** How many runs were stopped part-way by the per-run budget. */
  stopped: number;
  /** How many jobs were not started because the day's budget was spent. */
  skipped: number;
}

export function blankLedger(day: string): AutomationLedger {
  return { day, usd: 0, runs: 0, stopped: 0, skipped: 0 };
}

/** The ledger for a given day: yesterday's totals do not spend today's
    budget, and a restart mid-day keeps what has already been spent. */
export function rollLedger(ledger: AutomationLedger | null | undefined, day: string): AutomationLedger {
  if (!ledger || typeof ledger !== "object" || ledger.day !== day) return blankLedger(day);
  return {
    day,
    usd: Number(ledger.usd) || 0,
    runs: Number(ledger.runs) || 0,
    stopped: Number(ledger.stopped) || 0,
    skipped: Number(ledger.skipped) || 0,
  };
}

/** Put one run's cost on the ledger. */
export function addSpend(ledger: AutomationLedger, usd: number): AutomationLedger {
  ledger.usd += Number.isFinite(usd) && usd > 0 ? usd : 0;
  ledger.runs += 1;
  return ledger;
}

/** Whether the day's automation budget is spent. */
export function overDay(budget: AutomationBudget, ledger: AutomationLedger): boolean {
  return budget.enabled && ledger.usd >= budget.dailyUsd;
}

/** Whether this one run has had its share. */
export function overRun(budget: AutomationBudget, spent: number): boolean {
  return budget.enabled && spent >= budget.runUsd;
}

/** Why a job was not started, phrased for the job's own run list. */
export function skipReason(jobName: string, budget: AutomationBudget): string {
  return (
    `Today's automation budget ($${budget.dailyUsd.toFixed(2)}) is spent, so "${jobName}" was ` +
    "not started. The job keeps its schedule and runs again after midnight."
  );
}

/** Why a run was stopped part-way. */
export function stopReason(budget: AutomationBudget, spent: number): string {
  return (
    `This run has cost $${spent.toFixed(2)}, past its own budget of ` +
    `$${budget.runUsd.toFixed(2)}, so it was stopped here. The job keeps its schedule and runs ` +
    "again at its next time."
  );
}

/** One line for the person about what automation has spent today. */
export function budgetLine(budget: AutomationBudget, ledger: AutomationLedger): string {
  const spent = `$${ledger.usd.toFixed(2)}`;
  if (!budget.enabled) return `Automation budget off: ${spent} spent today over ${ledger.runs} runs.`;
  const left = Math.max(0, budget.dailyUsd - ledger.usd);
  const tail =
    ledger.skipped > 0
      ? `, ${ledger.skipped} not started because the day's budget was spent`
      : "";
  return `${spent} of $${budget.dailyUsd.toFixed(2)} spent today over ${ledger.runs} runs, $${left.toFixed(2)} left${tail}.`;
}
