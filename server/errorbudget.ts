/**
 * Failures that say the same thing, however the arguments were varied.
 *
 * The loop watch counts a failure against the exact call that made it, so
 * `npm test -- a`, `npm test -- b` and `npm test -- c` all dying with the same
 * error never add up. This counts by what the error says instead, names what
 * was tried in the note the model reads, and stops the turn when varying the
 * attempt has plainly stopped helping.
 */

export class ErrorBudget {
  private byKey = new Map<string, { n: number; tried: string[] }>();

  constructor(private readonly warnAt = 3, private readonly stopAt = 6) {}

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

  /** One call has run. `attempt` is a short rendering of its arguments. */
  record(tool: string, attempt: string, ok: boolean, result: string):
    { note: string | null; stop: string | null } {
    if (ok) return { note: null, stop: null };
    const key = ErrorBudget.signature(tool, result);
    const entry = this.byKey.get(key) ?? { n: 0, tried: [] };
    entry.n += 1;
    if (!entry.tried.includes(attempt)) entry.tried.push(attempt);
    this.byKey.set(key, entry);
    if (entry.n >= this.stopAt) {
      return {
        note: null,
        stop:
          `Stopped: ${tool} failed ${entry.n} times with the same error across ` +
          `${entry.tried.length} variations (last: ${entry.tried.slice(-3).join("; ")}). ` +
          "Tell it what to try instead, or ask it to explain what is blocking it.",
      };
    }
    if (entry.n >= this.warnAt) {
      return {
        note:
          `[Error budget] ${tool} has failed ${entry.n} times with the same error, ` +
          `with ${entry.tried.length} different arguments. Most recent:\n` +
          entry.tried.slice(-3).map((t) => `  - ${t}`).join("\n") +
          "\nThe arguments are not the problem. Discard this approach, step back, " +
          "and use a different tool or find the cause before another try. The " +
          `turn will be stopped after ${this.stopAt - entry.n} more.`,
        stop: null,
      };
    }
    return { note: null, stop: null };
  }
}
