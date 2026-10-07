/**
 * The proactive side of the console: a turn it starts by itself.
 *
 * Everything else here is reactive. A schedule runs because a time came, a
 * watcher fires because something changed, a background job is read when the
 * next turn happens to look -- and "the next turn" means the person said
 * something first. So the last step of a piece of work is the one nobody
 * takes: the build finished at 02:40, the result is sitting in the job's log,
 * and nothing looks at it until somebody thinks to ask.
 *
 * This is the module that decides whether the console may take that step by
 * itself -- start a turn in the session that owns a finished job, read the
 * output and report it -- and what that turn is told. It is a decision, not a
 * timer: the switch, the quiet hours, the automation budget, a ceiling on how
 * often it may happen and whether anybody is already working in that session
 * are all read here, in one function, so the answer can be tested without a
 * machine, a model or a bill.
 *
 * What it deliberately will not do:
 *
 *  - wake during quiet hours. Not "wake and stay quiet": the person's quiet
 *    window means the console does nothing they did not ask for, and a
 *    finished job is not urgent. The briefing note still arrives on the next
 *    turn they take, exactly as before.
 *  - wake for a job nobody is waiting on. Old work (see maxAgeMs) is
 *    history: its log is still there to read on request, and reading a week
 *    of finished jobs back into the conversation is not proactivity, it is a
 *    backlog.
 *  - spend what the automation budget has not got. A turn is a whole prompt
 *    and a whole tool list before it has done anything, so a wake is billed
 *    like any other automated run and counted against the same day.
 *  - wake a session that is busy, or one that has been deleted.
 */

export interface WakeCandidate {
  /** The background job's id, which is also what a wake is deduplicated on. */
  id: string;
  /** What the person called it when they started it. */
  note: string;
  /** The command line, shortened, for the prompt. */
  command: string;
  /** Its exit code: null when it was still finishing, which does not wake. */
  exit: number | null;
  /** Which session started it, and therefore which one is woken. */
  session: string;
  /** When it stopped, in milliseconds since the epoch. */
  finished: number;
  state: "running" | "finished" | "failed" | "gone";
}

export interface WakePolicy {
  /** The switch in Settings. Off means a wake never happens. */
  enabled: boolean;
  /** Inside the person's quiet hours: held, not dropped. */
  quiet: boolean;
  /** What automated runs have cost today, in USD, and what they may cost. */
  spentToday: number;
  dailyUsd: number;
  /** Wakes already started in the last hour, and the ceiling. */
  recentWakes: number;
  maxPerHour: number;
  /** Whether the session that would be woken is working on something already. */
  busy: boolean;
  /** How long ago the job stopped, and how old is too old. */
  ageMs: number;
  maxAgeMs: number;
  /** Whether the job's session still exists. */
  sessionExists: boolean;
}

/** How long after a job stops it is still worth waking for, and how many
    wakes an hour are allowed whatever else is true. */
export const WAKE_MAX_AGE_MS = 15 * 60_000;
export const WAKE_MAX_PER_HOUR = 3;

export const DEFAULT_WAKE_POLICY: Omit<WakePolicy, "spentToday" | "recentWakes" | "ageMs" | "busy" | "sessionExists"> = {
  enabled: false,
  quiet: false,
  dailyUsd: 1,
  maxPerHour: WAKE_MAX_PER_HOUR,
  maxAgeMs: WAKE_MAX_AGE_MS,
};

type WakeDecision = { wake: true } | { wake: false; why: string };

/**
 * May the console start a turn by itself, for this job, now?
 *
 * Ordered by what a person would want to know first: the switch they set, the
 * hours they set, then the money, the rate and the state of the session. The
 * sentence for a refusal is the same sentence that goes in the log, so what
 * happened is legible afterwards without guessing.
 */
export function mayWake(c: WakeCandidate, p: WakePolicy): WakeDecision {
  if (!p.enabled) return { wake: false, why: "proactivity is off" };
  if (p.quiet) return { wake: false, why: "quiet hours" };
  if (c.exit === null || (c.state !== "finished" && c.state !== "failed")) {
    return { wake: false, why: "the job has not stopped" };
  }
  if (!p.sessionExists) return { wake: false, why: "its session is gone" };
  if (p.busy) return { wake: false, why: "its session is already working" };
  if (p.ageMs > p.maxAgeMs) return { wake: false, why: "it finished too long ago to be worth interrupting for" };
  if (p.recentWakes >= p.maxPerHour) return { wake: false, why: `already ${p.recentWakes} wakes this hour` };
  if (p.spentToday >= p.dailyUsd) return { wake: false, why: "today's automation budget is spent" };
  return { wake: true };
}

/**
 * Which of the jobs that have stopped are worth a wake, in the order they
 * stop being worth it.
 *
 * `woken` is what has already been woken for -- in this process's memory and,
 * across restarts, the job's own id: a wake is once per job, because the
 * second turn about the same build has nothing new to say.
 */
export function wakesWanted(
  candidates: WakeCandidate[],
  woken: Set<string>,
  police: (c: WakeCandidate) => WakePolicy,
  limit = WAKE_MAX_PER_HOUR,
): WakeCandidate[] {
  const out: WakeCandidate[] = [];
  for (const c of [...candidates].sort((a, b) => b.finished - a.finished)) {
    if (out.length >= limit) break;
    if (woken.has(c.id)) continue;
    if (mayWake(c, police(c)).wake) out.push(c);
  }
  return out;
}

/** The turn's first message. Written as an instruction to the agent, because
    that is what it is: nobody is in this turn to be asked anything. */
export function wakePrompt(c: WakeCandidate): string {
  const ended = c.exit === 0
    ? "finished successfully"
    : `stopped with exit code ${c.exit}`;
  return [
    `[Autora: nobody asked for this turn. The background job you started ${ended}, and you said you would look at it when it did.]`,
    ``,
    `The job: ${c.id}${c.note ? ` -- "${c.note}"` : ""}`,
    `It ran: ${c.command}`,
    ``,
    `Read its output (background_output with that id), work out what it means, and say it in a few lines -- what happened, and what you would do next. If it finished cleanly and there is nothing to say, say that in one line: a silent wake is worse than no wake.`,
    `Do not start anything new without asking: this turn is to report, not to act. Anything you do start, say why in one line first.`,
  ].join("\n");
}
