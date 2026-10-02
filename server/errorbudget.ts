/**
 * Failures that say the same thing, however the arguments were varied.
 *
 * The loop watch counts a failure against the exact call that made it, so
 * `npm test -- a`, `npm test -- b` and `npm test -- c` all dying with the same
 * error never add up. This counts by what the error says instead, names what
 * was tried in the note the model reads, and stops the turn when varying the
 * attempt has plainly stopped helping.
 *
 * It counts *different* attempts, not repeats: the same command run again
 * after an edit is ordinary work (the loop watch deals with a call that
 * repeats and changes nothing). A success by the same tool halves what it has
 * counted against it, and what is kept between turns -- so "try again" does not
 * start from nothing -- is dropped after a few hours.
 */

export interface BudgetEntry {
  /** Failures with this error, repeats included. */
  n: number;
  /** The different attempts that met it. */
  tried: string[];
  /** When it last happened, ms. */
  at: number;
}

export type BudgetSnapshot = Record<string, BudgetEntry>;

/** An error this old says nothing about what is happening now. */
export const BUDGET_MAX_AGE_MS = 6 * 3600 * 1000;
const MAX_TRIED = 8;

export class ErrorBudget {
  private byKey = new Map<string, BudgetEntry>();

  constructor(
    private readonly warnAt = 3,
    private readonly stopAt = 6,
    seed: BudgetSnapshot = {},
    private readonly now: () => number = Date.now,
  ) {
    for (const [key, e] of Object.entries(seed)) {
      if (!e || typeof e.n !== "number" || !Array.isArray(e.tried)) continue;
      if (this.now() - e.at > BUDGET_MAX_AGE_MS) continue;
      this.byKey.set(key, { n: e.n, tried: e.tried.slice(-MAX_TRIED).map(String), at: e.at });
    }
  }

  /** The first line of an error, with the parts that vary taken out. */
  static signature(tool: string, result: string): string {
    const line = result.split("\n").find((l) => l.trim()) ?? "";
    const plain = line
      .replace(/(["'`]).*?\1/g, "<q>")
      .replace(/\/[\w./-]+/g, "<path>")
      .replace(/\d+/g, "#")
      .trim()
      .slice(0, 120);
    return `${tool}|${plain}`;
  }

  /**
   * What a stop taught, written as a memory the next chat can be told: the tool,
   * the error and what was tried that did not get past it. Null when the
   * error has no attempts on record (nothing worth keeping).
   */
  deadEnd(tool: string, result: string): { title: string; body: string; tags: string[] } | null {
    const key = ErrorBudget.signature(tool, result);
    const entry = this.byKey.get(key);
    if (!entry || entry.tried.length === 0) return null;
    const error = key.slice(tool.length + 1) || "an error";
    return {
      title: `Dead end: ${tool} fails with "${error}"`.slice(0, 200),
      body:
        `${tool} failed with this error (${error}) and ${entry.tried.length} different attempts did not get ` +
        `past it: ${entry.tried.slice(-5).join("; ")}. Do not try these again; find the cause or use another route.`,
      tags: ["dead-end", tool],
    };
  }

  /** What to keep between turns. */
  snapshot(): BudgetSnapshot {
    return Object.fromEntries(this.byKey);
  }

  /** One call has run. `attempt` is a short rendering of its arguments. */
  record(tool: string, attempt: string, ok: boolean, result: string):
    { note: string | null; stop: string | null } {
    if (ok) {
      // The tool works: what it was failing at counts for less.
      for (const [key, e] of this.byKey) {
        if (!key.startsWith(`${tool}|`)) continue;
        e.n = Math.floor(e.n / 2);
        e.tried = e.tried.slice(Math.floor(e.tried.length / 2));
        if (e.n === 0 || e.tried.length === 0) this.byKey.delete(key);
      }
      return { note: null, stop: null };
    }
    const key = ErrorBudget.signature(tool, result);
    const entry = this.byKey.get(key) ?? { n: 0, tried: [], at: 0 };
    entry.n += 1;
    entry.at = this.now();
    if (!entry.tried.includes(attempt)) entry.tried.push(attempt);
    entry.tried = entry.tried.slice(-MAX_TRIED);
    this.byKey.set(key, entry);
    const variations = entry.tried.length;
    if (variations >= this.stopAt) {
      return {
        note: null,
        stop:
          `Stopped: ${tool} failed with the same error across ${variations} different attempts ` +
          `(last: ${entry.tried.slice(-3).join("; ")}). ` +
          "Tell it what to try instead, or ask it to explain what is blocking it.",
      };
    }
    if (variations >= this.warnAt) {
      return {
        note:
          `[Error budget] ${tool} has failed ${entry.n} times with the same error, ` +
          `across ${variations} different attempts. Most recent:\n` +
          entry.tried.slice(-3).map((t) => `  - ${t}`).join("\n") +
          "\nThe arguments are not the problem. Discard this approach, step back, " +
          "and use a different tool or find the cause before another try. The " +
          `turn will be stopped after ${this.stopAt - variations} more different attempt(s).`,
        stop: null,
      };
    }
    return { note: null, stop: null };
  }
}
