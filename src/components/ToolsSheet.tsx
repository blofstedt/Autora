/**
 * The toolbox in the composer: Autora Widgets.
 *
 * Tapping the wrench opens this. A widget needs something to explain, so tapping it does not open an empty window: it
 * starts the message ("Make an interactive widget that shows ...") in the box for the person to finish. The other windows
 * are opened by the agent when the work needs them (and by the tabs beside the chat); they are not listed here.
 *
 * Switched off on the Tools page, the row is shown greyed rather than hidden, so a missing tool reads as off.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { IconSparkle, IconWrench, IconX } from "./Icons";

export function ToolsSheet({ onClose, onAsk }: {
  onClose: () => void;
  /** Put this at the start of the message, for the person to finish. */
  onAsk: (text: string) => void;
}) {
  /* Whether widgets are on, from the same settings the Tools page writes. Held as null while it loads: unknown is not
     the same as off. */
  const [on, setOn] = useState<Record<string, { enabled?: boolean } | undefined> | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/settings")
      .then((r) => r.json())
      .then((s) => { if (live) setOn(s?.tools?.config ?? {}); })
      .catch(() => { if (live) setOn({}); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const off = on !== null && on.widgets?.enabled === false;

  return createPortal(
    <div className="scrim tools-scrim" onClick={onClose} role="presentation">
      <div
        className="modal tools-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Tools"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-top">
          <IconWrench size={14} />
          <b>Tools</b>
          <div className="spacer" />
          <button className="btn icon ghost" onClick={onClose} aria-label="Close">
            <IconX size={14} />
          </button>
        </div>
        <div className="modal-body tools-body">
          <div className="tool-tiles">
            <button
              type="button"
              className={`tool-tile${off ? " is-off" : ""}`}
              disabled={off}
              title={off ? "Autora Widgets is switched off on the Tools page" : "Ask for an interactive widget"}
              onClick={() => { onAsk("Make an interactive widget that shows "); onClose(); }}
            >
              <span className="tool-tile-icon"><IconSparkle size={20} /></span>
              <span className="tool-tile-main">
                <b>Autora Widgets</b>
                <em>{off ? "switched off on the Tools page" : "An interactive explainer, in the chat"}</em>
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
