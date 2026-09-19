import { useEffect, useState, type ReactNode } from "react";

/**
 * One screencast frame, crossfaded onto the last one.
 *
 * Swapping an <img src> directly leaves a blank beat while the new blob
 * decodes, which reads as a slideshow. Holding the previous frame underneath
 * and fading the new one in over it means the stage never goes empty, and a
 * 4fps screencast starts to read as video.
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
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const [under, setUnder] = useState<string | null>(null);
  const loaded = loadedSrc === src;

  // The moment a new frame arrives, whatever was last fully decoded becomes the
  // backdrop.
  //
  // Doing this on a timer instead looks right and is wrong: a live screencast
  // emits a frame on every paint, so the next src lands before the timer fires,
  // the timer is cancelled, and the backdrop is never set at all. Every frame
  // then fades in over nothing and the stage strobes black. Deriving it from
  // the src change has no window to miss.
  useEffect(() => {
    if (loadedSrc && loadedSrc !== src) setUnder(loadedSrc);
  }, [src, loadedSrc]);

  return (
    <div className="frame-wrap">
      {under && under !== src && (
        <img className="frame frame-under" src={under} alt="" aria-hidden="true" />
      )}
      <img
        // Keyed so each frame is its own element and starts transparent; without
        // it React mutates src in place and the fade never runs.
        key={src}
        className={`frame frame-over ${loaded ? "is-loaded" : ""}`}
        src={src}
        alt={alt}
        onLoad={() => setLoadedSrc(src)}
      />
      {children}
    </div>
  );
}
