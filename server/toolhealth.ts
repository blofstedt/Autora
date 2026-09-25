/**
 * How each tool has been going lately, and where.
 *
 * The model is told what its tools do, never how they have been behaving --
 * so it tried the browser on a site that had refused it all week, or a command
 * that had timed out the last five times, as though for the first time. This
 * keeps the last few outcomes per tool, on disk, and turns the ones that keep
 * failing into a line in the turn note.
 *
 * Keyed by tool *and* target, because a tool is not one thing: one hostile
 * site that refused four calls used to make the note say "browser: 4 of the
 * last 6 calls failed" for a week, which is both wrong about every other site
 * and useless to act on. "browser (shop.example.com): 4 of 5 failed" says
 * which site to stop using. Terminal calls are keyed by the command they ran,
 * so a command that keeps failing is named rather than left out.
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
/** A command that fails is usually the command's news, not the tool's, so a
    terminal entry has to fail this many times before it is worth a line. */
const MIN_TERMINAL_FAILURES = 3;
/** Outcomes older than this say nothing about today. */
const MAX_AGE_S = 7 * 24 * 3600;

const history: Record<string, Outcome[]> = readDoc<Record<string, Outcome[]>>("tool-health") ?? {};
const save = () => saveDoc("tool-health", () => history);

/** The host a URL points at, without the scheme or the path. */
function hostOf(url: string): string {
  const raw = String(url ?? "").trim();
  if (!raw) return "";
  try {
    return new URL(raw).host.replace(/^www\./, "");
  } catch {
    // A bare host, or something that is not a URL at all.
    return /^[a-z0-9.-]+\.[a-z]{2,}/i.exec(raw)?.[0] ?? "";
  }
}

/** The command a terminal call ran, short enough to read in a note. */
function commandOf(command: string): string {
  const first = String(command ?? "").trim().split(/\s+/).filter(Boolean);
  const head = first.slice(0, 2).join(" ").replace(/[()]/g, "");
  return head.slice(0, 40);
}

/**
 * What a call was aimed at: a site, a command, or nothing at all.
 * `page` is where the browser currently is, which is what a click or a read
 * with no URL of its own was actually acting on.
 */
export function targetOf(tool: string, args: Record<string, any>, page = ""): string {
  if (tool.startsWith("browser_")) return hostOf(args?.url ?? "") || hostOf(page);
  if (tool === "http_request" || tool === "web_search") return hostOf(args?.url ?? "");
  if (tool === "terminal") return commandOf(args?.command ?? "");
  return "";
}

function keyOf(tool: string, target: string): string {
  return target ? `${tool} (${target})` : tool;
}

/** A stored key back into its two halves. Keys written before this existed
    have no target, and read as the bare tool name. */
function split(key: string): { tool: string; target: string } {
  const found = /^(.*) \(([^()]*)\)$/.exec(key);
  return found ? { tool: found[1], target: found[2] } : { tool: key, target: "" };
}

export function recordOutcome(
  tool: string,
  ok: boolean,
  result: string,
  opts: { at?: number; target?: string } = {},
) {
  const at = opts.at ?? Math.floor(Date.now() / 1000);
  const error = ok ? null : firstLine(result);
  const key = keyOf(tool, opts.target ?? "");
  history[key] = [...(history[key] ?? []), { ts: at, ok, error }].slice(-KEEP);
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
  /** The site or command it was aimed at, "" when it is the same everywhere. */
  target: string;
  /** What to show and what to say: "browser_open (example.com)". */
  label: string;
  calls: number;
  failures: number;
  lastError: string | null;
  lastTs: number;
}

export function toolHealth(at = Math.floor(Date.now() / 1000)): ToolHealth[] {
  return Object.entries(history)
    .map(([key, all]) => {
      const recent = all.filter((o) => at - o.ts <= MAX_AGE_S);
      const failed = recent.filter((o) => !o.ok);
      const { tool, target } = split(key);
      return {
        tool,
        target,
        label: target ? `${tool} (${target})` : tool,
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
 * The turn-note line, or "" when nothing is going badly.
 *
 * A tool that failed is only news when it is the same tool in the same place:
 * the browser on one site, one command rather than every command. A terminal
 * entry is held to a higher bar, because a command exiting non-zero is
 * usually the command working as intended.
 */
export function troubled(at = Math.floor(Date.now() / 1000)): ToolHealth[] {
  return toolHealth(at).filter((h) => {
    if (h.calls < MIN_CALLS) return false;
    if (h.failures / h.calls < FAIL_SHARE) return false;
    if (h.tool === "terminal") return h.failures >= MIN_TERMINAL_FAILURES;
    return true;
  });
}

export function healthBriefing(at = Math.floor(Date.now() / 1000)): string {
  const failing = troubled(at);
  if (failing.length === 0) return "";
  return [
    "Tools that have been failing lately (last 7 days) -- expect the same unless something changed:",
    ...failing.map((h) =>
      `- ${h.label}: ${h.failures} of the last ${h.calls} calls failed${h.lastError ? `, most recently: ${h.lastError}` : ""}`),
  ].join("\n");
}
