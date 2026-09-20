import type { ReactNode } from "react";
import { IconChevron, IconFile, IconGlobe, IconMonitor, IconTerminal } from "./Icons";

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
 * This used to be a tab you switched to, which meant watching the work and
 * reading the reply were mutually exclusive -- and the work is most of what
 * there is to see. It is open by default and collapses to its bar, so the
 * screen can be given over to the thread without losing the handle.
 */
export function StageDock({
  stage, open, pinned, counts, hasDesktop,
  onStage, onToggle, onUnpin, children, scrubber,
}: {
  stage: Stage;
  open: boolean;
  pinned: boolean;
  counts: { files: number };
  hasDesktop: boolean;
  onStage: (stage: Stage) => void;
  onToggle: () => void;
  onUnpin: () => void;
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

        <div className="spacer" />
        {pinned && open && (
          <button className="btn ghost dock-follow" onClick={onUnpin}>Follow agent</button>
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
