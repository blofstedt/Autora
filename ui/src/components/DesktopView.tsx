import type { Derived } from "../lib/derive";
import { IconTerminal } from "./Icons";

/**
 * Live desktop feed from the relay running on the controlled machine.
 *
 * Frames are content-addressed blobs (same mechanism as BrowserView), so
 * scrubbing the timeline never re-fetches anything twice.
 */
export function DesktopView({
  sessionId,
  desktopFrame,
}: {
  sessionId: string;
  desktopFrame: Derived["desktopFrame"];
}) {
  if (!desktopFrame) {
    return (
      <div className="empty">
        <span className="empty-ring"><IconTerminal size={20} /></span>
        <h3>No desktop relay</h3>
        <p>
          On the machine you want to control, run:
        </p>
        <pre className="code-hint">
          pip install websockets mss pyautogui pillow{"\n"}
          python -m autora.relay ws://THIS_SERVER:PORT
        </pre>
        <p style={{ fontSize: "0.78rem", color: "var(--text-3)", marginTop: "0.5rem" }}>
          macOS: grant Accessibility in System Settings → Privacy &amp; Security → Accessibility
        </p>
      </div>
    );
  }

  return (
    <div className="browser">
      <div className="browser-bar">
        <span className="lights"><i /><i /><i /></span>
        <span className="omnibox">
          Desktop relay — {desktopFrame.w && desktopFrame.h
            ? `${desktopFrame.w}×${desktopFrame.h}`
            : "connected"}
        </span>
      </div>
      <div className="browser-stage">
        <div className="frame-wrap">
          <img
            className="frame"
            src={`/api/sessions/${sessionId}/blobs/${desktopFrame.blob}`}
            alt="agent desktop view"
          />
        </div>
      </div>
    </div>
  );
}
