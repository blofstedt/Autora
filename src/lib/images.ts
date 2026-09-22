/**
 * Pictures inside prose.
 *
 * When the agent answers with an image it almost never announces it as an
 * image -- it writes a markdown link, or pastes the address, in the middle of
 * a sentence. Left alone that renders as what it literally is: a line of URL
 * where a picture should be, which reads as the app failing to load something
 * rather than as the app never having tried.
 *
 * So the reply is split into prose and pictures, and the pictures are drawn
 * where they were written. The split runs over the whole accumulated text on
 * every render rather than over each streamed chunk, which matters more than
 * it sounds: a markdown image arrives in three or four deltas, and a parser
 * that saw only the deltas would never see a whole one.
 */

export type Piece =
  | { kind: "text"; text: string }
  | { kind: "image"; url: string; alt: string };

/** `![alt](url)` and `![alt](url "title")`, the way every model writes one. */
const MARKDOWN = /!\[([^\]\n]*)\]\(\s*<?([^()\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g;

/** A bare address that ends in a picture. Deliberately narrow: a link to a
    page about an image is a link, and only an address that is itself the file
    is safe to draw without asking. */
const BARE = /\bhttps?:\/\/[^\s<>"')\]]+\.(?:png|jpe?g|gif|webp|avif|svg)(?:\?[^\s<>"')\]]*)?/gi;

/** A whole image written into the text. The server lifts these out into their
    own cards before they ever reach here, but a reply from an older session
    can still carry one, and a page of base64 in the transcript is worse than
    a picture of anything. */
const DATA_URL = /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi;

type Hit = { start: number; end: number; url: string; alt: string };

/**
 * Split a reply into what to read and what to look at.
 *
 * Returns a single text piece when there is nothing to draw, which is the
 * common case and the one worth not allocating around.
 */
export function splitImages(text: string): Piece[] {
  if (!text) return [];
  if (!text.includes("![") && !/https?:\/\//.test(text) && !text.includes("data:image/")) {
    return [{ kind: "text", text }];
  }

  const hits: Hit[] = [];
  for (const m of text.matchAll(MARKDOWN)) {
    hits.push({
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
      url: m[2],
      alt: m[1] || "image",
    });
  }
  for (const pattern of [BARE, DATA_URL]) {
    for (const m of text.matchAll(pattern)) {
      const start = m.index ?? 0;
      // Skip anything already claimed by the markdown form, whose own URL
      // would otherwise match the bare pattern and be drawn twice.
      if (hits.some((h) => start >= h.start && start < h.end)) continue;
      hits.push({ start, end: start + m[0].length, url: m[0], alt: "image" });
    }
  }
  if (hits.length === 0) return [{ kind: "text", text }];

  hits.sort((a, b) => a.start - b.start);

  const pieces: Piece[] = [];
  let at = 0;
  for (const hit of hits) {
    if (hit.start > at) pieces.push({ kind: "text", text: text.slice(at, hit.start) });
    pieces.push({ kind: "image", url: hit.url, alt: hit.alt });
    at = hit.end;
  }
  if (at < text.length) pieces.push({ kind: "text", text: text.slice(at) });

  // A sentence that was only ever an image link leaves an empty shell behind;
  // drop those so the prose does not gain blank lines it never had.
  return pieces.filter((p) => p.kind !== "text" || p.text.trim() !== "" || p.text.includes("\n\n"));
}

/** Does this reply contain anything to draw? Cheap enough to ask before
    committing to the split. */
export function hasImages(text: string): boolean {
  return splitImages(text).some((p) => p.kind === "image");
}
