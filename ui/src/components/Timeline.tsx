import { Kind, type AutoraEvent } from "../lib/types";

/**
 * The event timeline: one row per meaningful thing that happened.
 *
 * High-volume streaming kinds (text deltas, PTY bytes, video frames) are folded
 * out -- they are rendered by the transcript and stage panes instead. A timeline
 * with 6000 frame rows is not a timeline.
 *
 * Clicking a row moves the scrubber there, which is the whole point: the
 * timeline is a seek bar over the session, not a log viewer.
 */
const HIDDEN = new Set<string>([
  Kind.AgentText,
  Kind.AgentThinking,
  Kind.PtyOutput,
  Kind.BrowserFrame,
  Kind.Log,
]);

const LABELS: Record<string, string> = {
  [Kind.SessionStarted]: "session started",
  [Kind.SessionEnded]: "session ended",
  [Kind.UserMessage]: "you",
  [Kind.AgentDone]: "turn complete",
  [Kind.ToolCall]: "tool",
  [Kind.ToolResult]: "result",
  [Kind.ToolError]: "failed",
  [Kind.PolicyRequest]: "approval requested",
  [Kind.PolicyDecision]: "decision",
  [Kind.PtyExit]: "exit",
  [Kind.BrowserNav]: "navigated",
  [Kind.BrowserAction]: "browser",
  [Kind.FileEdit]: "edited",
  [Kind.Error]: "error",
};

function summarize(event: AutoraEvent): string {
  const p = event.payload;
  switch (event.kind) {
    case Kind.UserMessage:
      return p.text ?? "";
    case Kind.ToolCall:
      return `${p.name} ${describeArgs(p.args ?? {})}`;
    case Kind.ToolResult:
      return p.ok === false ? `not ok — ${p.preview ?? ""}` : (p.preview ?? "ok");
    case Kind.ToolError:
      return p.error ?? p.reason ?? "failed";
    case Kind.PolicyRequest:
      return p.rendered ?? p.tool ?? "";
    case Kind.PolicyDecision:
      return `${p.decision}${p.by ? ` by ${p.by}` : ""} — ${p.reason ?? ""}`;
    case Kind.PtyExit:
      return p.interrupted ? "interrupted" : `exit ${p.exit_code}`;
    case Kind.BrowserNav:
      return p.url ?? "";
    case Kind.BrowserAction:
      return `${p.action} ${p.selector ?? p.url ?? ""}`;
    case Kind.FileEdit:
      return `${p.path} +${p.added} -${p.removed}`;
    case Kind.AgentDone:
      return p.stop_reason ?? "";
    case Kind.Error:
      return p.error ?? "";
    case Kind.SessionStarted:
      return p.workdir ?? "";
    case Kind.SessionEnded:
      return `${p.reason ?? ""} · ${p.events ?? 0} events`;
    default:
      return JSON.stringify(p).slice(0, 120);
  }
}

function describeArgs(args: Record<string, any>): string {
  if (typeof args.command === "string") return args.command;
  if (typeof args.path === "string") return args.path;
  if (typeof args.action === "string")
    return `${args.action} ${args.selector ?? args.url ?? ""}`;
  return Object.entries(args)
    .map(([k, v]) => `${k}=${String(v).slice(0, 40)}`)
    .join(" ");
}

function toneFor(kind: string): string {
  if (kind === Kind.ToolError || kind === Kind.Error) return "bad";
  if (kind === Kind.PolicyRequest) return "warn";
  if (kind === Kind.UserMessage) return "you";
  if (kind === Kind.FileEdit) return "good";
  return "";
}

export function Timeline({
  events,
  cursor,
  onSeek,
}: {
  events: AutoraEvent[];
  cursor: number;
  onSeek: (index: number) => void;
}) {
  const rows = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => !HIDDEN.has(event.kind));

  return (
    <div className="timeline">
      {rows.length === 0 && <p className="dim pad">Nothing yet.</p>}
      {rows.map(({ event, index }) => (
        <button
          key={event.seq}
          className={`row ${toneFor(event.kind)} ${index > cursor ? "future" : ""}`}
          onClick={() => onSeek(index)}
          title={`seq ${event.seq}`}
        >
          <span className="row-kind">{LABELS[event.kind] ?? event.kind}</span>
          <span className="row-text">{summarize(event)}</span>
        </button>
      ))}
    </div>
  );
}
