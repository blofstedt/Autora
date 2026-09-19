import { Kind, type AutoraEvent } from "../lib/types";
import {
  IconCheck, IconFile, IconFlag, IconGlobe, IconPlay,
  IconShield, IconSpark, IconTerminal, IconUser, IconX,
} from "./Icons";

/**
 * The session timeline: one moment per row, threaded on a connector line.
 *
 * High-volume streaming kinds (text deltas, PTY bytes, frames) are folded out --
 * they are rendered by the transcript and stage instead. A timeline with 6000
 * frame rows is not a timeline.
 *
 * Rows are buttons because the rail is a seek control, not a log: clicking one
 * moves the scrubber to that moment.
 */
const HIDDEN = new Set<string>([
  Kind.AgentText, Kind.AgentThinking, Kind.PtyOutput, Kind.BrowserFrame, Kind.Log,
]);

const LABELS: Record<string, string> = {
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
  [Kind.FileEdit]: "edited",
  [Kind.Error]: "error",
};

function iconFor(event: AutoraEvent) {
  switch (event.kind) {
    case Kind.UserMessage: return <IconUser size={13} />;
    case Kind.SessionStarted: return <IconFlag size={13} />;
    case Kind.SessionEnded:
    case Kind.AgentDone: return <IconCheck size={13} />;
    case Kind.ToolCall:
      if (event.payload.name === "browser") return <IconGlobe size={13} />;
      if (String(event.payload.name ?? "").includes("file")) return <IconFile size={13} />;
      return <IconTerminal size={13} />;
    case Kind.ToolResult: return <IconCheck size={13} />;
    case Kind.ToolError:
    case Kind.Error: return <IconX size={13} />;
    case Kind.PolicyRequest: return <IconShield size={13} />;
    case Kind.PolicyDecision:
      return event.payload.decision === "allow" ? <IconCheck size={13} /> : <IconX size={13} />;
    case Kind.FileEdit: return <IconFile size={13} />;
    case Kind.BrowserNav:
    case Kind.BrowserAction: return <IconGlobe size={13} />;
    case Kind.PtyExit: return <IconPlay size={13} />;
    default: return <IconSpark size={13} />;
  }
}

function summarize(event: AutoraEvent): string {
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
    case Kind.FileEdit: return `${basename(p.path ?? "")} +${p.added} −${p.removed}`;
    case Kind.AgentDone: return p.stop_reason ?? "";
    case Kind.SessionStarted: return basename(p.workdir ?? "");
    case Kind.SessionEnded: return `${p.events ?? 0} events`;
    case Kind.Error: return p.error ?? "";
    default: return JSON.stringify(p).slice(0, 110);
  }
}

const basename = (path: string) => path.split("/").filter(Boolean).pop() ?? path;

function describeArgs(args: Record<string, any>): string {
  if (typeof args.command === "string") return args.command;
  if (typeof args.path === "string") return args.path;
  if (typeof args.action === "string") return `${args.action} ${args.selector ?? args.url ?? ""}`;
  return Object.entries(args).map(([k, v]) => `${k}=${String(v).slice(0, 30)}`).join(" ");
}

function toneFor(event: AutoraEvent): string {
  if (event.kind === Kind.ToolError || event.kind === Kind.Error) return "tone-bad";
  if (event.kind === Kind.PolicyRequest) return "tone-warn";
  if (event.kind === Kind.PolicyDecision && event.payload.decision === "deny") return "tone-bad";
  if (event.kind === Kind.UserMessage) return "tone-you";
  if (event.kind === Kind.FileEdit) return "tone-good";
  return "";
}

export function Timeline({
  events, cursor, onSeek,
}: {
  events: AutoraEvent[];
  cursor: number;
  onSeek: (index: number) => void;
}) {
  const rows = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => !HIDDEN.has(event.kind));

  // The current row is the last visible one at or before the cursor, so the
  // highlight tracks the scrubber even when the cursor sits on a hidden event.
  let currentIndex = -1;
  for (const row of rows) {
    if (row.index <= cursor) currentIndex = row.index;
    else break;
  }

  if (rows.length === 0) {
    return (
      <div className="empty">
        <span className="empty-ring"><IconSpark size={20} /></span>
        <h3>Nothing yet</h3>
        <p>Every action the agent takes will appear here as it happens.</p>
      </div>
    );
  }

  return (
    <div className="timeline">
      {rows.map(({ event, index }) => (
        <button
          key={event.seq}
          className={`tl-row ${toneFor(event)} ${index === currentIndex ? "is-current" : ""} ${
            index > cursor ? "is-future" : ""
          }`}
          onClick={() => onSeek(index)}
          title={`seq ${event.seq}`}
        >
          <span className="tl-icon">{iconFor(event)}</span>
          <span className="tl-body">
            <span className="tl-label">{LABELS[event.kind] ?? event.kind}</span>
            <span className="tl-text">{summarize(event)}</span>
          </span>
        </button>
      ))}
    </div>
  );
}