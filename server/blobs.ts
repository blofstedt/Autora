/**
 * The bytes behind a picture.
 *
 * Events carry a `blob` id and nothing else: a screenshot inlined as base64
 * into the event log would be re-sent on every reconnect, re-parsed on every
 * derive, and kept forever by a client that only ever shows the newest one.
 * So the log carries the id, the picture is fetched once over HTTP, and the
 * browser caches it -- ids are unique and never reused, so the response is
 * immutable and can say so.
 *
 * Held in memory rather than on disk, because this is what a session saw
 * rather than what it produced: it is worth exactly as long as the process
 * that can still show it. The cap is per session and evicts oldest-first, so
 * a long afternoon of browsing costs a bounded amount of RAM instead of
 * however much the afternoon happened to be.
 */

import crypto from "node:crypto";

export interface Blob {
  id: string;
  session: string;
  mime: string;
  data: Buffer;
  ts: number;
}

/** Per session. Roughly 250 frames at the sizes the screencast produces --
    enough that scrubbing back through a session's browsing is worth doing,
    small enough that a forgotten tab is not a leak. */
const MAX_BYTES_PER_SESSION = 64 * 1024 * 1024;

const blobs = new Map<string, Blob>();
/** Insertion order per session, so eviction is oldest-first without a sort. */
const order = new Map<string, string[]>();
const bytes = new Map<string, number>();

/** Extensions are decoration; what matters is that the browser is told the
    truth about what it is being handed. */
const KNOWN_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/svg+xml",
]);

export function putBlob(session: string, data: Buffer, mime: string): string {
  const id = crypto.randomUUID().replace(/-/g, "");
  const safe = KNOWN_MIME.has(mime) ? mime : "application/octet-stream";
  blobs.set(id, { id, session, mime: safe, data, ts: Date.now() });

  const ids = order.get(session) ?? [];
  ids.push(id);
  order.set(session, ids);
  bytes.set(session, (bytes.get(session) ?? 0) + data.byteLength);

  evict(session);
  return id;
}

/** Drop the oldest until the session is back under its ceiling. A blob that
    goes is gone: the card that referenced it shows a missing frame rather
    than a stale one, which is the honest outcome. */
function evict(session: string) {
  const ids = order.get(session);
  if (!ids) return;
  let total = bytes.get(session) ?? 0;
  while (total > MAX_BYTES_PER_SESSION && ids.length > 1) {
    const oldest = ids.shift();
    if (!oldest) break;
    const gone = blobs.get(oldest);
    if (gone) {
      total -= gone.data.byteLength;
      blobs.delete(oldest);
    }
  }
  bytes.set(session, total);
}

export function getBlob(id: string): Blob | null {
  return blobs.get(id) ?? null;
}

/** Everything a session ever showed, released at once. */
export function dropSession(session: string) {
  for (const id of order.get(session) ?? []) blobs.delete(id);
  order.delete(session);
  bytes.delete(session);
}

/** A data: URL, decoded into something storable. Returns null for anything
    that is not one, so callers can use it as the test as well as the parse. */
export function fromDataUrl(value: string): { data: Buffer; mime: string } | null {
  const match = /^data:([a-z0-9.+/-]+);base64,([\s\S]+)$/i.exec(value.trim());
  if (!match) return null;
  try {
    return { data: Buffer.from(match[2], "base64"), mime: match[1].toLowerCase() };
  } catch {
    return null;
  }
}
