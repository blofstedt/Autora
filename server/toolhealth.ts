/**
 * How each tool has been going lately.
 *
 * The model is told what its tools do, never how they have been behaving --
 * so it tried the browser on a site that had refused it all week, or a
 * command that had timed out the last five times, as though for the first
 * time. This keeps the last few outcomes per tool, on disk, and turns the
 * ones that keep failing into a line in the turn note.
 */

import { readDoc, saveDoc } from "./store";

export interface Outcome {
  ts: number;
  ok: boolean;
  /** First line of what went wrong. */
  error: string | null;
}

const KEEP = 20;
/** A tool is worth mentioning once this share of its recent calls failed... */
const FAIL_SHARE = 0.4;
/** ...over at least this many calls. */
const MIN_CALLS = 3;
/** Outcomes older than this say nothing about today. */
const MAX_AGE_S = 7 * 24 * 3600;

const history: Record<string, Outcome[]> = readDoc<Record<string, Outcome[]>>("tool-health") ?? {};
const save = () => saveDoc("tool-health", () => history);

export function recordOutcome(tool: string, ok: boolean, result: string, at = Math.floor(Date.now() / 1000)) {
  const error = ok ? null : firstLine(result);
  history[tool] = [...(history[tool] ?? []), { ts: at, ok, error }].slice(-KEEP);
  save();
}

function firstLine(text: string): string {
  // A terminal result opens with "Exit code N"; the reason is the line after.
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const useful = lines.find((l) => !/^exit code \d+/i.test(l)) ?? lines[0] ?? "";
  return useful.slice(0, 160);
}

export interface ToolHealth {
  tool: string;
  calls: number;
  failures: number;
  lastError: string | null;
  lastTs: number;
}

export function toolHealth(at = Math.floor(Date.now() / 1000)): ToolHealth[] {
  return Object.entries(history)
    .map(([tool, all]) => {
      const recent = all.filter((o) => at - o.ts <= MAX_AGE_S);
      const failed = recent.filter((o) => !o.ok);
      return {
        tool,
        calls: recent.length,
        failures: failed.length,
        lastError: failed[failed.length - 1]?.error ?? null,
        lastTs: recent[recent.length - 1]?.ts ?? 0,
      };
    })
    .filter((h) => h.calls > 0)
    .sort((a, b) => b.lastTs - a.lastTs);
}

/**
 * The turn-note line, or "" when nothing is going badly. Terminal failures
 * are mostly commands exiting non-zero, which is the command's news rather
 * than the tool's, so the terminal is left out.
 */
export function healthBriefing(at = Math.floor(Date.now() / 1000)): string {
  const troubled = toolHealth(at).filter((h) =>
    h.tool !== "terminal" && h.calls >= MIN_CALLS && h.failures / h.calls >= FAIL_SHARE);
  if (troubled.length === 0) return "";
  return [
    "Tools that have been failing lately (last 7 days) -- expect the same unless something changed:",
    ...troubled.map((h) =>
      `- ${h.tool}: ${h.failures} of the last ${h.calls} calls failed${h.lastError ? `, most recently: ${h.lastError}` : ""}`),
  ].join("\n");
}
