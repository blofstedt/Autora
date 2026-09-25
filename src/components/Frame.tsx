import { useEffect, useState, type ReactNode } from "react";

/** The last frame each card finished decoding, by src. A card that remounts
    (the thread regrouping its cells, a page coming back into view) starts
    from a picture it has already decoded instead of from nothing. */
const decoded = new Set<string>();

/**
 * One screencast frame, swapped in only once it can be drawn.
 *
 * Each new frame used to be a fresh <img> that started transparent and faded
 * in over the last one. Whenever there was no last one to sit on -- the first
 * frame, a card remounted, the live feed switching to a stored screenshot --
 * the stage behind it showed through, and the browser in the thread blinked
 * black. Now a frame is decoded off-screen first and the visible picture only
 * ever changes from one drawable frame to the next, so there is no moment
 * with nothing to show.
 *
 * Frames are content-addressed, so every src is immutable and cached forever --
 * scrubbing back and forth costs no network traffic after the first pass.
 */
export function Frame({
  src, alt, children,
}: {
  src: string;
  alt: string;
  /** Overlays positioned against the frame, e.g. the click marker. */
  children?: ReactNode;
}) {
  const [shown, setShown] = useState(src);

  useEffect(() => {
    if (src === shown) return;
    if (decoded.has(src)) { setShown(src); return; }
    let gone = false;
    const img = new Image();
    img.src = src;
    const swap = () => {
      if (gone) return;
      remember(src);
      setShown(src);
    };
    // A frame that fails to decode is still the newest word on the page; show
    // it rather than freezing on the one before.
    img.decode().then(swap, swap);
    return () => { gone = true; };
  }, [src, shown]);

  return (
    <div className="frame-wrap">
      <img
        className="frame"
        src={shown}
        alt={alt}
        onLoad={() => remember(shown)}
        draggable={false}
      />
      {children}
    </div>
  );
}

function remember(src: string) {
  decoded.add(src);
  // Live frames are data URLs of a few hundred kilobytes each: keep the last
  // handful, not the whole session.
  if (decoded.size > 24) {
    const oldest = decoded.values().next().value;
    if (oldest !== undefined) decoded.delete(oldest);
  }
}
