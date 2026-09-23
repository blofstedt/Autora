/**
 * Catching an agent that is going round in circles.
 *
 * A turn has no cap on its rounds, so something has to notice when the work
 * has stopped moving: the same command failing the same way, the same page
 * read over and over, two calls taking turns. Asking the model whether it is
 * stuck does not work -- a model in a loop believes each try is the one that
 * will land -- so this watches what it actually does instead.
 *
 * Every call is fingerprinted with its arguments and what came back. A call
 * that has already been made with the same result is a repeat, and repeats
 * get a note appended to the result the model reads, which is the one place
 * it reliably looks. Ignore enough notes and the turn is stopped. Every so
 * many rounds it also gets a checkpoint asking it to measure itself against
 * the goal, with its most repeated calls in front of it.
 */

export interface LoopWatchConfig {
  /** The same call with the same result this many times earns a note. */
  warnAt: number;
  /** ...and this many times stops the turn. */
  stopAt: number;
  /** This many calls in a row with nothing new coming back earns a note. */
  staleAfter: number;
  /** A checkpoint every this many rounds. */
  checkEvery: number;
}

export const LOOP_DEFAULTS: LoopWatchConfig = {
  warnAt: 3,
  stopAt: 8,
  staleAfter: 10,
  checkEvery: 20,
};

export interface LoopVerdict {
  /** Appended to what the model reads back from this call. */
  note: string | null;
  /** Said in the thread, once per problem, so the person sees it too. */
  log: string | null;
  /** Set when the turn should end here, with the reason. */
  stop: string | null;
}

/** Key order is not meaning: {a, b} and {b, a} are the same call. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Two results that differ only in a timestamp, a duration or a process id
    are the same result. */
function sameness(ok: boolean, result: string): string {
  const body = result.replace(/\d+/g, "#").replace(/\s+/g, " ").trim().slice(0, 4000);
  return `${ok ? "ok" : "fail"}:${body}`;
}

/** What the person and the model see a call called: its name and a little of
    its arguments. */
function describe(name: string, args: unknown): string {
  const shown = stable(args);
  if (shown === "{}" || shown === "null") return name;
  return `${name} ${shown.length > 80 ? `${shown.slice(0, 77)}...` : shown}`;
}

export class LoopWatch {
  private readonly config: LoopWatchConfig;
  /** call + result -> how many times. */
  private seen = new Map<string, number>();
  /** call -> how many times it has failed, whatever it said. */
  private failures = new Map<string, number>();
  /** call -> how many times, for the checkpoint's list. */
  private calls = new Map<string, { label: string; count: number }>();
  /** Calls in a row that brought back nothing not already seen. */
  private stale = 0;
  private rounds = 0;
  /** Problems already said in the thread, so each is said once. */
  private logged = new Set<string>();

  constructor(config: Partial<LoopWatchConfig> = {}) {
    this.config = { ...LOOP_DEFAULTS, ...config };
  }

  /** One call has run. Says whether it is part of a loop. */
  record(name: string, args: unknown, ok: boolean, result: string): LoopVerdict {
    const { warnAt, stopAt, staleAfter } = this.config;
    const call = `${name}\u0000${stable(args)}`;
    const label = describe(name, args);
    const pair = `${call}\u0000${sameness(ok, result)}`;

    const times = (this.seen.get(pair) ?? 0) + 1;
    this.seen.set(pair, times);
    const tally = this.calls.get(call) ?? { label, count: 0 };
    tally.count += 1;
    this.calls.set(call, tally);
    const failed = ok ? 0 : (this.failures.get(call) ?? 0) + 1;
    if (!ok) this.failures.set(call, failed);
    this.stale = times === 1 ? 0 : this.stale + 1;

    const once = (key: string, message: string) => {
      if (this.logged.has(key)) return null;
      this.logged.add(key);
      return message;
    };

    if (times >= stopAt) {
      return {
        note: null,
        log: null,
        stop:
          `Stopped: the agent ran ${label} ${times} times and got the same ` +
          "result every time, after being told it was repeating itself. Tell " +
          "it what to try instead, or ask it to explain what is blocking it.",
      };
    }

    if (times >= warnAt) {
      return {
        note:
          `[Loop check] This is the ${ordinal(times)} time you have made this ` +
          "exact call and got the same result. Running it again will not " +
          "change the outcome. Do not repeat it. Work out why it is not " +
          "working and try something genuinely different, or stop and tell " +
          "the person what is blocking you and what you need from them. " +
          `The turn will be stopped if this call repeats ${stopAt - times} ` +
          "more time(s).",
        log: once(`repeat:${pair}`, `Loop check: ${label} has come back the same ${times} times; the agent was told to change approach.`),
        stop: null,
      };
    }

    if (failed >= warnAt) {
      return {
        note:
          `[Loop check] This call has now failed ${failed} times. Small ` +
          "variations of the same attempt are not working. Step back: read " +
          "the error, check your assumptions, and try a different approach, " +
          "or stop and tell the person what is blocking you.",
        log: once(`fail:${call}`, `Loop check: ${label} has failed ${failed} times; the agent was told to step back.`),
        stop: null,
      };
    }

    if (this.stale >= staleAfter) {
      this.stale = 0;
      return {
        note:
          `[Loop check] Your last ${staleAfter} calls all brought back ` +
          "results you had already seen. You are going in circles. Stop and " +
          "compare where you are with the goal. If there is a different way " +
          "forward, take it; if not, stop and tell the person what is " +
          "blocking you.",
        log: once(`stale:${this.seen.size}`, `Loop check: ${staleAfter} calls in a row brought back nothing new; the agent was told it is going in circles.`),
        stop: null,
      };
    }

    return { note: null, log: null, stop: null };
  }

  /** One round of calls is done. Every so often, a checkpoint. */
  endRound(): string | null {
    this.rounds += 1;
    if (this.rounds % this.config.checkEvery !== 0) return null;
    const repeated = [...this.calls.values()]
      .filter((c) => c.count >= 3)
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
      .map((c) => `${c.label} (x${c.count})`);
    return (
      `[Checkpoint] ${this.rounds} rounds of tool calls so far in this turn. ` +
      "Before the next call, check yourself against the person's request: " +
      "what is done, what is left, and whether the last few rounds actually " +
      "moved you forward. If they did not, change approach or stop and report." +
      (repeated.length > 0 ? ` Your most repeated calls: ${repeated.join(", ")}.` : "")
    );
  }
}

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}
