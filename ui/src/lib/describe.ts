import { Kind, type AutoraEvent } from "./types";

/**
 * How an event describes itself.
 *
 * Extracted from the timeline because the scrubber's hover preview needs the
 * same words: two different descriptions of the same event -- one in the rail,
 * one under the cursor -- would be a bug you could see.
 */

/** Streaming kinds the timeline folds away; the transcript and stage render
    them instead. A timeline with 6000 frame rows is not a timeline. */
export const HIDDEN_KINDS = new Set<string>([
  Kind.AgentText, Kind.AgentThinking, Kind.PtyOutput, Kind.BrowserFrame,
  Kind.DesktopFrame, Kind.Log,
]);

export const LABELS: Record<string, string> = {
  [Kind.SessionStarted]: "session",
  [Kind.SessionEnded]: "ended",
  [Kind.UserMessage]: "you",
  [Kind.AgentDone]: "complete",
  [Kind.ToolCall]: "tool",
  [Kind.ToolResult]: "result",
  [Kind.ToolError]: "failed",
  [Kind.PolicyRequest]: "approval",
  [Kind.PolicyDecision]: "decision",
  [Kind.PtyExit]: "exit",
  [Kind.BrowserNav]: "navigated",
  [Kind.BrowserAction]: "browser",
  [Kind.DesktopAction]: "desktop",
  [Kind.ContextNote]: "context",
  [Kind.FileEdit]: "edited",
  [Kind.Error]: "error",
};

export const labelFor = (event: AutoraEvent) => LABELS[event.kind] ?? event.kind;

export type Tone = "bad" | "warn" | "good" | "you" | "";

export function toneOf(event: AutoraEvent): Tone {
  if (event.kind === Kind.ToolError || event.kind === Kind.Error) return "bad";
  if (event.kind === Kind.PolicyRequest) return "warn";
  if (event.kind === Kind.PolicyDecision && event.payload.decision === "deny") return "bad";
  if (event.kind === Kind.UserMessage) return "you";
  if (event.kind === Kind.FileEdit) return "good";
  return "";
}

export const basename = (path: string) => path.split("/").filter(Boolean).pop() ?? path;

function describeArgs(args: Record<string, any>): string {
  if (typeof args.command === "string") return args.command;
  if (typeof args.path === "string") return args.path;
  if (typeof args.action === "string") return `${args.action} ${args.selector ?? args.url ?? ""}`;
  return Object.entries(args).map(([k, v]) => `${k}=${String(v).slice(0, 30)}`).join(" ");
}

export function summarize(event: AutoraEvent): string {
  const p = event.payload;
  switch (event.kind) {
    case Kind.UserMessage: return p.text ?? "";
    case Kind.ToolCall: return `${p.name} · ${describeArgs(p.args ?? {})}`;
    case Kind.ToolResult: return p.ok === false ? `not ok — ${p.preview ?? ""}` : (p.preview || "ok");
    case Kind.ToolError: return p.error ?? p.reason ?? "failed";
    case Kind.PolicyRequest: return p.rendered ?? p.tool ?? "";
    case Kind.PolicyDecision: return `${p.decision}${p.by ? ` · ${p.by}` : ""}`;
    case Kind.PtyExit: return p.interrupted ? "interrupted" : `exit ${p.exit_code}`;
    case Kind.BrowserNav: return p.url ?? "";
    case Kind.BrowserAction: return `${p.action} ${p.selector ?? p.url ?? ""}`;
    case Kind.DesktopAction: return `${p.action ?? ""} ${p.key ?? p.text ?? ""}`.trim();
    case Kind.ContextNote: return p.text ?? "";
    case Kind.FileEdit: return `${basename(p.path ?? "")} +${p.added} −${p.removed}`;
    case Kind.AgentDone: return p.stop_reason ?? "";
    case Kind.SessionStarted: return basename(p.workdir ?? "");
    case Kind.SessionEnded: return `${p.events ?? 0} events`;
    // Which endpoint and model were in play is half of what makes a provider
    // failure diagnosable, and it is not otherwise visible anywhere in the UI.
    case Kind.Error:
      return p.endpoint
        ? `${p.error ?? ""}\n${p.model ?? "?"} @ ${p.endpoint}`
        : (p.error ?? "");
    default: return JSON.stringify(p).slice(0, 110);
  }
}

/**
 * Elapsed time since the session opened, as `0:07` or `12:41` or `1:04:12`.
 *
 * Relative rather than absolute: what you want from a timeline is the pace and
 * the gaps, and "+2:14" says that where "14:32:09" makes you do arithmetic.
 */
export function elapsed(ts: number, start: number): string {
  const total = Math.max(0, Math.round(ts - start));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
