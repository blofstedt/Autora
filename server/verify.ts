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

/** What the agent is told when the check failed. */
export function failedNote(r: CheckResult, run: number, tries: number): string {
  const left = tries - run;
  return [
    `(Autora ran the project's check after your changes: \`${r.command}\` ` +
      `${r.exitCode === null ? "did not finish" : `exited ${r.exitCode}`}, so it did not pass. Its output:`,
    r.output.trim() || "(no output)",
    left > 0
      ? `Fix what it reports and carry on; the check will run again when you are done (${left} more run${left === 1 ? "" : "s"} this turn). ` +
        "Do not say the work is finished while it is failing. If it fails for a reason that is not yours -- something already broken, " +
        "or an environment problem -- say so plainly rather than working around it.)"
      : "That was the last run this turn. Say plainly that it is still failing and what you could not fix; do not say the work is done.)",
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
