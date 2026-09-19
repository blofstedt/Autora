import type { Derived } from "../lib/derive";
import { Frame } from "./Frame";
import { IconGlobe } from "./Icons";

/** The live browser feed. */
export function BrowserView({
  sessionId, frame, url, lastAction,
}: {
  sessionId: string;
  frame: Derived["frame"];
  url: string | null;
  lastAction: Derived["lastAction"];
}) {
  if (!frame) {
    return (
      <div className="empty">
        <span className="empty-ring"><IconGlobe size={20} /></span>
        <h3>No browser activity</h3>
        <p>When the agent opens a page, its live screencast appears here.</p>
      </div>
    );
  }

  // Show the marker only while it is fresh. It is also painted into the page
  // itself so it survives into the recording; this is the crisper version for
  // whoever is watching live.
  const showMarker =
    lastAction?.x != null &&
    lastAction?.y != null &&
    frame.seq - lastAction.seq < 12 &&
    frame.seq >= lastAction.seq;

  return (
    <div className="browser">
      <div className="browser-bar">
        <span className="lights"><i /><i /><i /></span>
        <span className="omnibox" title={url ?? undefined}>{url ?? "about:blank"}</span>
      </div>
      <div className="browser-stage">
        <Frame src={`/api/sessions/${sessionId}/blobs/${frame.blob}`} alt="agent browser view">
          {showMarker && (
            <span
              className="marker"
              style={{
                // Coordinates are percentages of the 1280x800 viewport the
                // harness captures, so they survive the image being scaled.
                left: `${((lastAction!.x as number) / 1280) * 100}%`,
                top: `${((lastAction!.y as number) / 800) * 100}%`,
              }}
            />
          )}
        </Frame>
      </div>
    </div>
  );
}
