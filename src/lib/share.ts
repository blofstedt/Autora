/**
 * Keep what did not change.
 *
 * `derive` folds the whole event log from scratch on every update, which is
 * cheap (a couple of milliseconds for twenty thousand events) and keeps it a
 * pure function of the log. But every card it returns is a new object, so
 * React could never tell an unchanged card from a changed one and redrew the
 * entire conversation -- every reply's Markdown, every terminal -- for each
 * streamed word. On a long thread that held the page at 100% CPU and a few
 * frames a second for as long as the agent was typing.
 *
 * This walks the new result beside the previous one and hands back the
 * previous object wherever the two are equal, all the way down. An unchanged
 * card is then literally the same object as last time, so the memoised
 * components in Thread.tsx skip it, and only the card that is growing is
 * drawn again.
 *
 * Plain objects and arrays are compared by content. Anything else -- a Map,
 * a Date, a class instance -- is taken from `next` unless it is the very
 * same object, since there is no telling what equality would mean for it.
 */
export function share<T>(prev: unknown, next: T): T {
  return keep(prev, next, 0) as T;
}

/** Deeper than any derived structure; past it, `next` is taken as it is. */
const MAX_DEPTH = 64;

function plain(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const own = Object.prototype.hasOwnProperty;

/* Written for the common case, which is "nothing changed here": no copy is
   made until the first difference, so an unchanged subtree costs a walk and
   no allocation. This runs on every update of a long thread. */
function keep(prev: unknown, next: unknown, depth: number): unknown {
  if (Object.is(prev, next)) return prev;
  if (depth > MAX_DEPTH) return next;

  if (Array.isArray(prev) && Array.isArray(next)) {
    const length = next.length;
    let out: unknown[] | null = null;
    for (let i = 0; i < length; i++) {
      const kept = keep(prev[i], next[i], depth + 1);
      if (out) {
        out[i] = kept;
      } else if (kept !== prev[i] || i >= prev.length) {
        out = prev.slice(0, i);
        out[i] = kept;
      }
    }
    if (out) return out;
    // Every element the same: the same array, or the front of it.
    return prev.length === length ? prev : prev.slice(0, length);
  }

  if (plain(prev) && plain(next)) {
    const keys = Object.keys(next);
    let out: Record<string, unknown> | null = null;
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const kept = keep(prev[key], next[key], depth + 1);
      if (out) {
        out[key] = kept;
      } else if (kept !== prev[key] || !own.call(prev, key)) {
        out = {};
        for (let j = 0; j < i; j++) out[keys[j]] = prev[keys[j]];
        out[key] = kept;
      }
    }
    if (out) return out;
    // Every key of `next` the same: `prev` itself, unless it has more.
    let prevCount = 0;
    for (const key in prev) if (own.call(prev, key)) prevCount++;
    if (prevCount === keys.length) return prev;
    const trimmed: Record<string, unknown> = {};
    for (const key of keys) trimmed[key] = prev[key];
    return trimmed;
  }

  return next;
}
