import { Kind, type AutoraEvent } from "../lib/types";
import { HIDDEN_KINDS, elapsed, labelFor, summarize, toneOf } from "../lib/describe";
import {
  IconCheck, IconFile, IconFlag, IconGlobe, IconMonitor, IconPlay,
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
 * moves the scrubber to that moment. Each carries its offset from the start of
 * the session, which is what makes the pace -- and the long silent gaps -- legible.
 */
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
    case Kind.DesktopAction: return <IconMonitor size={13} />;
    case Kind.PtyExit: return <IconPlay size={13} />;
    default: return <IconSpark size={13} />;
  }
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
    .filter(({ event }) => !HIDDEN_KINDS.has(event.kind));

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

  const start = events[0]?.ts ?? 0;

  return (
    <div className="timeline">
      {rows.map(({ event, index }) => {
        const tone = toneOf(event);
        const current = index === currentIndex;
        return (
          <button
            key={event.seq}
            className={`tl-row ${tone ? `tone-${tone}` : ""} ${current ? "is-current" : ""} ${
              index > cursor ? "is-future" : ""
            }`}
            onClick={() => onSeek(index)}
            title={`seq ${event.seq}`}
            aria-current={current ? "true" : undefined}
          >
            <span className="tl-icon">{iconFor(event)}</span>
            <span className="tl-body">
              <span className="tl-head">
                <span className="tl-label">{labelFor(event)}</span>
                <span className="tl-at">+{elapsed(event.ts, start)}</span>
              </span>
              <span className="tl-text">{summarize(event)}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
