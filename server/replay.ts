/**
 * Replaying a recorded chat against the harness's rules.
 *
 * Tuning the loop watch, the error budget or the context settings by feel
 * leaves no way to say whether a change made the agent better or only
 * different. A chat's log already holds what happened -- every call, its
 * outcome, what each model call cost -- so this feeds the calls back through
 * fresh copies of the rules and reports what they would have done: where a
 * note or a stop would have landed, how many rounds followed it, and what the
 * rounds cost. Run it with the old settings and the new and compare.
 *
 * Pure: events in, a report out. The results in a log are previews, so
 * "the same result" is judged on what the log kept of it.
 */

import { ErrorBudget } from "./errorbudget";
import { LOOP_DEFAULTS, LoopWatch, describe, type LoopWatchConfig } from "./loopwatch";
import { buildTrace, type TraceEvent } from "./trace";

export interface ReplayStop {
  /** Index of the tool call in the replay, from 1. */
  call: number;
  by: "loop watch" | "error budget";
  reason: string;
}

export interface ReplayReport {
  calls: number;
  /** Calls the loop watch or budget would have added a note to. */
  notes: number;
  /** Repeats of a withheld call the gate would have refused. */
  refused: number;
  /** Rounds where the stall note would have been said. */
  stalls: number;
  /** The first stop the rules would have made, if any. */
  stop: ReplayStop | null;
  /** Calls that came after that stop in the log: work the rules would have saved. */
  callsAfterStop: number;
  /** Model calls and money, from the log itself. */
  rounds: number;
  costUsd: number;
  cacheRate: number;
}

interface Pending {
  name: string;
  args: unknown;
}

export function replay(
  events: readonly TraceEvent[],
  config: Partial<LoopWatchConfig> = {},
  budget: { warnAt?: number; stopAt?: number } = {},
  readOnly: (name: string, args: Record<string, any>) => boolean = () => false,
): ReplayReport {
  const watch = new LoopWatch({ ...LOOP_DEFAULTS, ...config });
  const errors = new ErrorBudget(budget.warnAt ?? 3, budget.stopAt ?? 6);
  const pending = new Map<string, Pending>();
  let calls = 0, notes = 0, refused = 0, stalls = 0;
  let stop: ReplayStop | null = null;
  let after = 0;

  const endRound = () => {
    if (watch.endRound()?.startsWith("[Stall]")) stalls += 1;
  };
  let openRound = false;

  for (const e of events) {
    const p = e.payload ?? {};
    if (e.kind === "usage.turn" && openRound) {
      endRound();
      openRound = false;
    }
    if (e.kind === "tool.call" && e.span) {
      pending.set(e.span, { name: String(p.name ?? "tool"), args: p.args ?? {} });
      continue;
    }
    if ((e.kind !== "tool.result" && e.kind !== "tool.error") || !e.span) continue;
    const call = pending.get(e.span);
    if (!call) continue;
    pending.delete(e.span);
    if (p.held) continue; // the person's work or a planning refusal: not the agent's loop
    if (stop) {
      after += 1;
      continue;
    }
    calls += 1;
    openRound = true;
    const ok = e.kind === "tool.result" && p.ok !== false;
    const text = String(p.preview ?? p.error ?? "");

    const gate = watch.gate(call.name, call.args);
    if (gate.stop) {
      stop = { call: calls, by: "loop watch", reason: gate.stop };
      continue;
    }
    if (gate.refuse) {
      refused += 1;
      continue;
    }
    if (ok && !readOnly(call.name, (call.args ?? {}) as Record<string, any>)) watch.advance();
    if (ok && (call.name === "todo" || call.name === "ledger" || call.name === "requirements")) watch.advance();
    const verdict = watch.record(call.name, call.args, ok, text);
    const spent = errors.record(call.name, describe(call.name, call.args), ok, text);
    if (verdict.note || spent.note) notes += 1;
    const why = verdict.stop ?? spent.stop;
    if (why) stop = { call: calls, by: verdict.stop ? "loop watch" : "error budget", reason: why };
  }
  if (openRound) endRound();

  const trace = buildTrace(events);
  return {
    calls, notes, refused, stalls, stop, callsAfterStop: after,
    rounds: trace.rounds, costUsd: trace.costUsd, cacheRate: trace.cacheRate,
  };
}

/** The report as text, for the command line. */
export function replayText(r: ReplayReport): string {
  const out = [
    `${r.calls} tool calls over ${r.rounds} model calls (${Math.round(r.cacheRate * 100)}% of input from cache` +
      `${r.costUsd > 0 ? `, about $${r.costUsd.toFixed(r.costUsd < 1 ? 3 : 2)}` : ""}).`,
    `The rules would have added ${r.notes} note${r.notes === 1 ? "" : "s"}, refused ${r.refused} repeat${r.refused === 1 ? "" : "s"}, ` +
      `and said the stall note ${r.stalls} time${r.stalls === 1 ? "" : "s"}.`,
  ];
  out.push(r.stop
    ? `Stopped at call ${r.stop.call} by the ${r.stop.by}; ${r.callsAfterStop} later call${r.callsAfterStop === 1 ? "" : "s"} in the log would not have run.\n  ${r.stop.reason}`
    : "Never stopped.");
  return out.join("\n");
}
