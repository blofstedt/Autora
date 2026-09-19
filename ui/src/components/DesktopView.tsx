import type { Derived } from "../lib/derive";
import { Frame } from "./Frame";
import { IconMonitor } from "./Icons";

/**
 * Live desktop feed from the relay running on the controlled machine.
 *
 * Same content-addressed blobs and same crossfade as the browser stage, so the
 * two feeds behave identically -- there is one screencast, pointed at different
 * things.
 */
export function DesktopView({
  sessionId, desktopFrame,
}: {
  sessionId: string;
  desktopFrame: Derived["desktopFrame"];
}) {
  if (!desktopFrame) {
    return (
      <div className="empty">
        <span className="empty-ring"><IconMonitor size={20} /></span>
        <h3>No desktop relay</h3>
        <p>On the machine you want to control, run:</p>
        <pre className="code-hint">
          pip install websockets mss pyautogui pillow{"\n"}
          python -m autora.relay ws://THIS_SERVER:PORT
        </pre>
        <p className="empty-note">
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
        <Frame
          src={`/api/sessions/${sessionId}/blobs/${desktopFrame.blob}`}
          alt="agent desktop view"
        />
      </div>
    </div>
  );
}
