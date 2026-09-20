import type { ReactNode } from "react";
import { IconChevron, IconFile, IconGlobe, IconMonitor, IconStop, IconTerminal } from "./Icons";

export type Stage = "terminal" | "browser" | "files" | "desktop";

export const STAGES: { id: Stage; label: string; icon: typeof IconTerminal }[] = [
  { id: "terminal", label: "Terminal", icon: IconTerminal },
  { id: "browser", label: "Browser", icon: IconGlobe },
  { id: "desktop", label: "Desktop", icon: IconMonitor },
  { id: "files", label: "Files", icon: IconFile },
];

/**
 * What the agent is looking at, docked under the conversation.
 *
 * Every pane keeps its name at every width. Hiding the labels of all but the
 * selected tab made them fit and made the row unreadable -- an icon you have
 * to tap to identify is not a label. The buttons share the row equally and
 * shrink instead, which is the thing that is actually allowed to give.
 *
 * Stop lives here rather than in the header: it belongs with the live
 * controls, and the header should not carry a button that exists only
 * sometimes.
 */
export function StageDock({
  stage, open, counts, hasDesktop, running,
  onStage, onToggle, onStop, children, scrubber,
}: {
  stage: Stage;
  open: boolean;
  counts: { files: number };
  hasDesktop: boolean;
  running: boolean;
  onStage: (stage: Stage) => void;
  onToggle: () => void;
  onStop: () => void;
  children: ReactNode;
  scrubber: ReactNode;
}) {
  return (
    <section className={`dock ${open ? "on" : ""}`} aria-label="Stage">
      <div className="dock-bar">
        <button
          className="dock-grip"
          onClick={onToggle}
          aria-expanded={open}
          aria-label={open ? "Collapse the stage" : "Expand the stage"}
        >
          <IconChevron size={12} />
        </button>

        <div className="segmented" role="tablist" aria-label="Stage">
          {STAGES.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              role="tab"
              id={`tab-${id}`}
              aria-controls={`pane-${id}`}
              aria-selected={stage === id}
              className={`seg ${stage === id ? "on" : ""}`}
              // Choosing a pane while collapsed means "show me this", so it
              // opens rather than silently selecting something out of sight.
              onClick={() => { onStage(id); if (!open) onToggle(); }}
            >
              <Icon size={14} />
              <span className="seg-label">{label}</span>
              {id === "files" && counts.files > 0 && <em className="count">{counts.files}</em>}
              {id === "desktop" && hasDesktop && <em className="count">●</em>}
            </button>
          ))}
        </div>

        {running && (
          <button className="btn danger dock-stop" onClick={onStop} title="Stop"
                  aria-label="Stop the agent">
            <IconStop size={13} />
          </button>
        )}
      </div>

      {/* Kept mounted while collapsed: xterm replays its whole buffer on
          remount, and the browser pane would lose its last frame. */}
      <div className="dock-body">
        <div className="stage">{children}</div>
        {scrubber}
      </div>
    </section>
  );
}
