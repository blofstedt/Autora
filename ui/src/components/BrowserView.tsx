import type { Derived } from "../lib/derive";

/**
 * The live browser feed.
 *
 * Frames are content-addressed, so the <img> src is immutable and the browser
 * caches it forever. Scrubbing the timeline back and forth therefore costs no
 * network traffic after the first pass, which is what makes review feel instant.
 */
export function BrowserView({
  sessionId,
  frame,
  url,
  lastAction,
}: {
  sessionId: string;
  frame: Derived["frame"];
  url: string | null;
  lastAction: Derived["lastAction"];
}) {
  if (!frame) {
    return (
      <div className="stage-empty">
        <p>No browser activity yet.</p>
        <p className="dim">
          When the agent opens a page, its live screencast appears here.
        </p>
      </div>
    );
  }

  // Show the click marker only while it is fresh. The marker is also painted
  // into the page itself (so it survives into the recording); this overlay is
  // the crisper version for whoever is watching now.
  const showMarker =
    lastAction?.x != null &&
    lastAction?.y != null &&
    frame.seq - lastAction.seq < 12 &&
    frame.seq >= lastAction.seq;

  return (
    <div className="browser-view">
      <div className="browser-chrome">
        <span className="dot" />
        <span className="url">{url ?? "(no url)"}</span>
      </div>
      <div className="browser-frame-wrap">
        <img
          className="browser-frame"
          src={`/api/sessions/${sessionId}/blobs/${frame.blob}`}
          alt="agent browser view"
        />
        {showMarker && (
          <span
            className="click-marker"
            style={{
              // Frames are rendered at the element's width, so marker
              // coordinates are expressed as percentages of the 1280x800
              // viewport the harness captures.
              left: `${((lastAction!.x as number) / 1280) * 100}%`,
              top: `${((lastAction!.y as number) / 800) * 100}%`,
            }}
          />
        )}
      </div>
    </div>
  );
}
