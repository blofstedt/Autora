import { useCallback, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Picture } from "../lib/derive";
import { IconImage, IconX } from "./Icons";

/**
 * Full size, over everything.
 *
 * Portalled to the body rather than rendered where it is used, and that is not
 * tidiness: every cell in the thread carries `animation: rise ... both`, whose
 * settled transform makes the cell a containing block for `position: fixed`.
 * A lightbox rendered inside one therefore covers the *card* and nothing else
 * -- it is on screen, the right size for the wrong box, and looks like a click
 * that did nothing.
 *
 * Dismissed by clicking anywhere or by escape. There is nothing to decide
 * here, so every way out is the same way out; escape is captured so it closes
 * this before it closes whatever is underneath.
 */
function Lightbox({
  src, alt, caption, onClose,
}: {
  src: string;
  alt: string;
  caption?: ReactNode;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return createPortal(
    <div className="pic-full" onClick={onClose} role="dialog" aria-modal="true">
      <button className="btn icon ghost pic-close" aria-label="Close image">
        <IconX size={15} />
      </button>
      <img src={src} alt={alt} onClick={(e) => e.stopPropagation()} />
      {caption && <p className="pic-full-cap">{caption}</p>}
    </div>,
    document.body,
  );
}

/**
 * Pictures the agent is showing you, in the conversation.
 *
 * An image is an answer, not an attachment: asked what a page looks like, or
 * for a chart, or for the crop it just made, the picture *is* the reply and
 * belongs where the reply is. Before this it was a URL in a sentence, or a
 * blob id in an event nothing rendered -- which is the same as not having
 * produced it.
 *
 * Inline at a readable size by default and full-screen on a tap, because a
 * conversation in which every picture is a screenful is a conversation you
 * cannot skim, and a thumbnail you cannot open is a picture you cannot see.
 */
export function ImageCell({
  sessionId,
  pictures,
}: {
  sessionId: string;
  pictures: Picture[];
}) {
  const [full, setFull] = useState<Picture | null>(null);

  const src = useCallback(
    (picture: Picture) =>
      picture.blob ? `/api/sessions/${sessionId}/blobs/${picture.blob}` : (picture.url ?? ""),
    [sessionId],
  );

  if (pictures.length === 0) return null;

  return (
    <section className={`cell pics ${pictures.length > 1 ? "is-sheet" : ""}`}>
      <header className="cell-top">
        <IconImage size={13} />
        <span className="shot-where">
          {pictures.length === 1
            ? (pictures[0].caption || pictures[0].alt || "image")
            : `${pictures.length} images`}
        </span>
      </header>

      <div className="pics-grid">
        {pictures.map((picture) => (
          <figure className="pic" key={`${picture.seq}-${picture.blob ?? picture.url}`}>
            <button
              className="pic-open"
              onClick={() => setFull(picture)}
              title="Open full size"
              aria-label={`Open ${picture.alt} full size`}
            >
              <img
                src={src(picture)}
                alt={picture.alt}
                loading="lazy"
                decoding="async"
                {...(picture.width ? { width: picture.width } : {})}
                {...(picture.height ? { height: picture.height } : {})}
              />
            </button>
            {picture.caption && <figcaption>{picture.caption}</figcaption>}
          </figure>
        ))}
      </div>

      {full && (
        <Lightbox
          src={src(full)}
          alt={full.alt}
          caption={full.caption || full.alt}
          onClose={() => setFull(null)}
        />
      )}
    </section>
  );
}

/**
 * One picture the agent wrote into a sentence.
 *
 * Kept deliberately small and quiet: this is a picture inside prose rather
 * than a card of its own, and it should read as part of the paragraph. A URL
 * that turns out not to be an image at all just disappears -- better a
 * sentence with a gap in it than a broken-image glyph, which reads as the app
 * being broken rather than the link being wrong.
 */
export function InlineImage({ url, alt }: { url: string; alt: string }) {
  const [broken, setBroken] = useState(false);
  const [open, setOpen] = useState(false);

  if (broken) {
    return (
      <a className="pic-fallback" href={url} target="_blank" rel="noreferrer">
        {alt || "image"}
      </a>
    );
  }

  return (
    <>
      <button className="pic-inline" onClick={() => setOpen(true)} title={alt || "Open full size"}>
        <img src={url} alt={alt} loading="lazy" decoding="async" onError={() => setBroken(true)} />
      </button>
      {open && (
        <Lightbox src={url} alt={alt} caption={alt} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
