/**
 * Not taking the agent's word that the work is done.
 *
 * A turn ends when the model stops asking for tools, so "done" has been
 * whatever the model said. When the person has named a check for their
 * project -- the linter, the tests, a build -- this runs it once the agent
 * says it is finished and has changed something, and puts the raw result in
 * front of the agent. The check is theirs and is plain code: it passes or it
 * does not, whatever the model believes. A failure sends the agent back to fix
 * it, up to a few runs a turn; after that the turn ends and says the check is
 * still failing rather than claiming a pass.
 *
 * Off until a command is set: Autora is not tied to any one kind of project.
 */

export interface VerifyConfig {
  /** The command to run in the terminal's directory. Empty means off. */
  command: string;
  /** Most runs of it in one turn. */
  tries: number;
}

export const VERIFY_DEFAULTS: VerifyConfig = { command: "", tries: 3 };

const MAX_COMMAND = 500;

/** A setting from the page or the file, made safe. */
export function mergeVerify(into: VerifyConfig, patch: any): VerifyConfig {
  if (patch && typeof patch === "object") {
    if (typeof patch.command === "string") {
      // One line: a newline would be a second command nobody read.
      into.command = patch.command.replace(/[\r\n]+/g, " ").trim().slice(0, MAX_COMMAND);
    }
    const n = Number(patch.tries);
    if (Number.isFinite(n)) into.tries = Math.min(10, Math.max(1, Math.round(n)));
  }
  return into;
}

export interface CheckResult {
  command: string;
  exitCode: number | null;
  ok: boolean;
  /** What it printed, already cut to a size the agent can read. */
  output: string;
}

const FAILURE_LINE = /\b(error|fail(?:ed|ure|ing)?|exception|assert\w*|expected|panic|cannot|unable|not found|undefined|TS\d{4})\b|✗|✘|×/i;
/** Output past this is cut down to what reports a failure. */
const FOCUS_OVER_CHARS = 4_000;
const FOCUS_MAX_LINES = 60;

/**
 * The part of a failing check's output worth reading: the lines that report a
 * failure with one line of context either side, in order. A passing test's
 * name or a progress bar carries nothing, and a long run of them buries the
 * one line that matters. Short output is returned as it is, and so is long
 * output that names no failure (cutting it would leave nothing).
 */
export function focusOutput(output: string): string {
  if (output.length <= FOCUS_OVER_CHARS) return output;
  const lines = output.split("\n");
  const keep = new Set<number>();
  let hits = 0;
  for (let i = 0; i < lines.length && hits < FOCUS_MAX_LINES; i += 1) {
    if (!FAILURE_LINE.test(lines[i])) continue;
    hits += 1;
    for (const j of [i - 1, i, i + 1]) if (j >= 0 && j < lines.length) keep.add(j);
  }
  if (keep.size === 0) return output;
  const out: string[] = [];
  let last = -2;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (i > last + 1) out.push("...");
    out.push(lines[i]);
    last = i;
  }
  if (last < lines.length - 1) out.push("...");
  return `(${lines.length} lines of output; the ones reporting a failure:)\n${out.join("\n")}`;
}

/** The failure lines of an output, as a set, so one run can be compared with the next. */
export function failureKey(output: string): string {
  return output.split("\n").filter((l) => FAILURE_LINE.test(l))
    .map((l) => l.replace(/\d+/g, "#").replace(/\s+/g, " ").trim()).sort().join("\n");
}

/** What the agent is told when the check failed. `previous` is the failing
    output of the run before, when there was one: a run that fails exactly as
    the last did is told so in a line, not shown the same wall of text again. */
export function failedNote(r: CheckResult, run: number, tries: number, previous?: string): string {
  const left = tries - run;
  const unchanged = previous !== undefined && previous.trim() !== "" &&
    failureKey(previous) !== "" && failureKey(previous) === failureKey(r.output);
  const shown = unchanged
    ? "It fails exactly as it did on the last run: nothing you changed since has affected these failures. " +
      "Look at what you changed against what it reports, rather than repeating the fix."
    : focusOutput(r.output).trim() || "(no output)";
  return [
    `(Autora ran the project's check after your changes: \`${r.command}\` ` +
      `${r.exitCode === null ? "did not finish" : `exited ${r.exitCode}`}, so it did not pass. Its output:`,
    shown,
    left > 0
      ? `Fix what it reports and carry on; the check will run again when you are done (${left} more run${left === 1 ? "" : "s"} this turn). ` +
        "Do not say the work is finished while it is failing. If it fails for a reason that is not yours -- something already broken, " +
        "or an environment problem -- say so plainly rather than working around it.)"
      : "That was the last run this turn. Say plainly that it is still failing and what you could not fix; do not say the work is done.)",
  ].join("\n");
}

/** What the agent is told when the check was run because it just finished an item. */
export function itemCheckNote(r: CheckResult, previous?: string): string {
  if (r.ok) return `(Autora ran the project's check after you finished that item: \`${r.command}\` passed.)`;
  const unchanged = previous !== undefined && failureKey(previous) !== "" && failureKey(previous) === failureKey(r.output);
  return [
    `(Autora ran the project's check after you marked that item done: \`${r.command}\` ` +
      `${r.exitCode === null ? "did not finish" : `exited ${r.exitCode}`}, so it did not pass.`,
    unchanged
      ? "It fails exactly as it did last time; what you changed since has not affected it."
      : focusOutput(r.output).trim() || "(no output)",
    "That item is not finished while this fails. Fix it now, while the change is fresh, and reopen the item if you marked it done. " +
      "If it fails for a reason that is not yours -- already broken, or the environment -- say so plainly.)",
  ].join("\n");
}

/** What the thread says in a line. */
export function checkLine(r: CheckResult, run: number, tries: number): string {
  if (r.ok) return `The project's check passed (${r.command}).`;
  const how = r.exitCode === null ? "did not finish" : `failed (exit ${r.exitCode})`;
  return run < tries
    ? `The project's check ${how}; the agent was sent back to fix it (${r.command}).`
    : `The project's check is still failing after ${tries} runs (${r.command}).`;
}

/** An entry of the app window's console, as the browser keeps it. */
export interface ConsoleEntry {
  kind: "error" | "warn";
  text: string;
  ts: number;
}

/**
 * What the running app says is wrong, once the agent says it has finished.
 *
 * Needs no setting: when the app window is open and the code changed, the page's
 * own console is the check -- an uncaught exception or a failed request after
 * the change is something the agent has not seen, because it wrote code and
 * did not run it. Only errors raised since the change count (an old one is the
 * last version's), the same message once, and warnings are left out. A dev
 * server that has stopped is a problem too.
 */
export function previewProblems(log: readonly ConsoleEntry[], sinceMs: number, serverDown?: { exit?: number | null; last?: string } | null): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const e of log) {
    if (e.kind !== "error" || e.ts < sinceMs) continue;
    const text = e.text.replace(/\s+/g, " ").trim().slice(0, 300);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  if (serverDown) {
    out.push(`The dev server stopped (exit ${serverDown.exit ?? "unknown"})${serverDown.last ? `; it last said: ${serverDown.last}` : ""}.`);
  }
  return out.slice(0, 8);
}

/** What the agent is told when the app it built raised errors. */
export function previewNote(problems: readonly string[], run: number, tries: number): string {
  const left = tries - run;
  return [
    "(Autora looked at the app window after your changes, and the page reported errors:",
    ...problems.map((p) => `- ${p}`),
    left > 0
      ? `Fix them and carry on; it will be looked at again when you are done (${left} more look${left === 1 ? "" : "s"} this turn). ` +
        "Do not say the app works while it is raising errors. If one is not caused by your change, say so.)"
      : "That was the last look this turn. Say plainly that the page still reports errors; do not say the app works.)",
  ].join("\n");
}
