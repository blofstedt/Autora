/**
 * The memory graph: what the agent knows between sessions, and how it keeps
 * that knowledge from rotting.
 *
 * Three things this has to get right that a list of notes does not:
 *
 *  1. Recall by meaning, not by luck. Memories are ranked against the request
 *     (BM25 over title, tags and body), with a lift for ones that have been
 *     useful before, so a memory written yesterday is found as readily as one
 *     the app shipped with.
 *  2. No pile of near-copies. Writing something close to what is already
 *     there updates it instead of adding a second, slightly different one.
 *  3. Learned is not the same as known. What the agent works out for itself
 *     is `provisional` until it is confirmed -- by the person, or by working
 *     again -- and a provisional change to a confirmed memory is a new record
 *     that only replaces the old one once it is confirmed.
 *
 * The class holds the arrays and nothing else; the server owns saving them.
 */

export type MemoryKind = "fact" | "preference" | "procedure" | "skill";
export const MEMORY_KINDS: MemoryKind[] = ["preference", "procedure", "fact", "skill"];

export interface MemoryRecord {
  id: string;
  kind: MemoryKind;
  scope: string;
  title: string;
  body: string;
  tags: string[];
  status: "provisional" | "confirmed";
  pinned: boolean;
  source_session: string | null;
  source_seq: number | null;
  created: number;
  updated: number;
  /** Times it was put in front of the model. */
  uses: number;
  last_used: number | null;
  superseded_by: string | null;
  /** Times a turn that used it went well. Drives confirming and promoting. */
  worked?: number;
  /** A provisional rewrite of this record, which replaces it on confirm. */
  replaces?: string | null;
}

export interface MemoryLink {
  src: string;
  dst: string;
  rel: string;
}

export interface Recalled {
  record: MemoryRecord;
  score: number;
  /** Why it was picked, in words for the chip's tooltip. */
  reason: string;
}

/** A provisional memory that has worked this many times is confirmed. */
export const CONFIRM_AFTER = 2;
/** A confirmed procedure that has worked this many times is marked proven,
    which ranks it higher whenever it matches. It is not pinned: see reinforce. */
export const PROMOTE_AFTER = 3;
/** Unconfirmed, unused memories older than this are dropped by consolidate. */
const STALE_PROVISIONAL_S = 30 * 24 * 3600;

// ------------------------------------------------------------------ text --

const STOP = new Set(
  ("a an and are as at be but by can do does for from has have how i if in into is it its " +
    "me my of on or our so that the their them then there these this to use was we what " +
    "when where which who why will with you your please just also should would could about " +
    "all any some get got make made want need").split(" "),
);

/** Lowercase words, stop words out, crude plural and tense endings off. */
export function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9_.-]*[a-z0-9]|[a-z0-9]/g) ?? [])
    .filter((w) => !STOP.has(w))
    .map(stem);
}

function stem(word: string): string {
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith("es")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/** Overlap of two texts' vocabularies, 0..1. */
export function similarity(a: string, b: string): number {
  const x = new Set(tokens(a));
  const y = new Set(tokens(b));
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared += 1;
  return shared / (x.size + y.size - shared);
}

const now = () => Math.floor(Date.now() / 1000);
const GENERIC_TAGS = new Set(["skill", "agent-authored", "learned", "unconfirmed", "proven"]);

/**
 * Whether a memory that shares `hits` of the request's `asked` words is about
 * the request rather than merely mentioning one of them.
 *
 * One shared word is enough only when it is what the memory is about (in its
 * title or tags) or the request is a word or two long. Otherwise a memory has
 * to share two words with it -- a single "file" or "page" in a long body is
 * how unrelated skills used to ride along on every turn.
 */
function relevant(hits: number, headHits: number, asked: number): boolean {
  if (hits >= 2) return true;
  return headHits >= 1 || asked <= 2;
}

// ----------------------------------------------------------------- graph --

export class MemoryGraph {
  constructor(
    public readonly records: MemoryRecord[],
    public readonly links: MemoryLink[],
    private readonly changed: () => void = () => undefined,
  ) {
    /* Proven procedures used to be pinned, and so put in front of the model
       on every turn whatever it was asked -- a pile of unrelated skills on a
       question about the weather. Undo that for the ones promoted before. */
    let unpinned = 0;
    for (const r of records) {
      if (r.pinned && r.kind === "procedure" && r.tags.includes("proven")) {
        r.pinned = false;
        unpinned += 1;
      }
    }
    if (unpinned) this.changed();
  }

  /** Everything still current: superseded records are history. */
  active(): MemoryRecord[] {
    return this.records.filter((r) => !r.superseded_by);
  }

  get(id: string): MemoryRecord | undefined {
    return this.records.find((r) => r.id === id);
  }

  /**
   * The memories that bear on `query`, best first.
   *
   * Pinned memories -- only ever pinned by the person -- are always included
   * unless `withPinned` is false. The rest must be about the query, not just
   * share a word with it: see `relevant`. `limit` caps how many come back.
   */
  recall(query: string, limit = 6, withPinned = true): Recalled[] {
    const pool = this.active();
    const want = [...new Set(tokens(query))];
    const docs = pool.map((r) => {
      // Bookkeeping tags ("skill", "learned") say how a memory came to be,
      // not what it is about; matched, they would recall every skill at once.
      const topical = r.tags.filter((t) => !GENERIC_TAGS.has(t)).flatMap((t) => tokens(t));
      const head = new Set([...tokens(r.title), ...topical]);
      // Title and tags count double: they are what the memory is about.
      const words = [...tokens(r.title), ...tokens(r.title), ...topical.flatMap((t) => [t, t]), ...tokens(r.body)];
      // Counted once here rather than by scanning every word of every memory
      // for every word of the query, which is what recall did on each turn.
      const tf = new Map<string, number>();
      for (const w of words) tf.set(w, (tf.get(w) ?? 0) + 1);
      return { record: r, head, words, tf };
    });
    const avg = docs.reduce((n, d) => n + d.words.length, 0) / Math.max(docs.length, 1) || 1;
    const df = new Map<string, number>();
    for (const d of docs) for (const w of d.tf.keys()) df.set(w, (df.get(w) ?? 0) + 1);

    const scored: Recalled[] = [];
    for (const d of docs) {
      let score = 0;
      const hit: string[] = [];
      let headHits = 0;
      for (const w of want) {
        const tf = d.tf.get(w) ?? 0;
        if (!tf) continue;
        hit.push(w);
        if (d.head.has(w)) headHits += 1;
        const idf = Math.log(1 + (docs.length - (df.get(w) ?? 0) + 0.5) / ((df.get(w) ?? 0) + 0.5));
        score += idf * ((tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (d.words.length / avg))));
      }
      if (score > 0 && relevant(hit.length, headHits, want.length)) {
        const r = d.record;
        score *= 1 + 0.1 * Math.log1p(r.uses) + 0.15 * Math.log1p(r.worked ?? 0);
        if (r.tags.includes("proven")) score *= 1.2;
        if (r.status === "provisional") score *= 0.8;
        scored.push({ record: r, score, reason: `matched ${hit.slice(0, 4).join(", ")}` });
      }
    }
    scored.sort((a, b) => b.score - a.score);

    const out: Recalled[] = pool
      .filter((r) => withPinned && r.pinned)
      .map((record) => ({ record, score: Infinity, reason: "pinned: always recalled" }));
    const pinned = out.length;
    // A long tail of weak matches is noise: keep what scores within reach
    // of the best.
    const floor = (scored[0]?.score ?? 0) * 0.4;
    for (const s of scored) {
      if (out.length >= pinned + limit || s.score < floor) break;
      if (!out.some((o) => o.record.id === s.record.id)) out.push(s);
    }
    return out;
  }

  /** Counted as used: it was put in front of the model. */
  touch(ids: string[]) {
    const t = now();
    for (const id of ids) {
      const r = this.get(id);
      if (!r) continue;
      r.uses += 1;
      r.last_used = t;
    }
    if (ids.length) this.changed();
  }

  /** The existing memory this would be a near-copy of, if any. */
  findDuplicate(title: string, body: string, kind: MemoryKind): MemoryRecord | null {
    const norm = (s: string) => tokens(s).join(" ");
    let best: MemoryRecord | null = null;
    let bestSim = 0;
    for (const r of this.active()) {
      if (r.kind !== kind) continue;
      if (norm(r.title) && norm(r.title) === norm(title)) return r;
      const sim = similarity(`${r.title} ${r.body}`, `${title} ${body}`);
      if (sim > bestSim) { bestSim = sim; best = r; }
    }
    return bestSim >= 0.55 ? best : null;
  }

  /**
   * Write something down.
   *
   * `confirmed` writes (the agent's own memory_write, or the person) update a
   * near-duplicate in place. `provisional` ones (learned after a turn) never
   * overwrite a confirmed memory: they become a candidate that replaces it
   * only when confirmed, and one that says the same thing again only counts
   * as the old one having worked.
   */
  write(input: {
    title: string;
    body: string;
    kind?: string;
    tags?: string[];
    status?: "confirmed" | "provisional";
    source_session?: string | null;
    source_seq?: number | null;
  }): { record: MemoryRecord; action: "added" | "merged" | "reinforced" | "proposed" } {
    const kind: MemoryKind = MEMORY_KINDS.includes(input.kind as MemoryKind) ? (input.kind as MemoryKind) : "fact";
    const status = input.status ?? "confirmed";
    const title = input.title.trim().slice(0, 200);
    const body = input.body.trim();
    const tags = [...new Set((input.tags ?? []).map((t) => String(t).trim().toLowerCase()).filter(Boolean))];
    const t = now();

    const dup = this.findDuplicate(title, body, kind);
    if (dup && (status === "confirmed" || dup.status === "provisional")) {
      dup.title = title || dup.title;
      dup.body = body || dup.body;
      dup.tags = [...new Set([...dup.tags, ...tags])];
      dup.updated = t;
      if (status === "confirmed") this.confirm(dup.id, false);
      this.changed();
      return { record: dup, action: "merged" };
    }
    if (dup && similarity(dup.body, body) >= 0.8) {
      this.reinforce(dup.id);
      return { record: dup, action: "reinforced" };
    }

    const record: MemoryRecord = {
      id: `mem-${t.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      kind,
      scope: "workspace",
      title,
      body,
      tags: status === "provisional" ? [...new Set([...tags, "learned"])] : tags,
      status,
      pinned: false,
      source_session: input.source_session ?? null,
      source_seq: input.source_seq ?? null,
      created: t,
      updated: t,
      uses: 0,
      last_used: null,
      superseded_by: null,
      worked: 0,
      replaces: dup ? dup.id : null,
    };
    this.records.push(record);
    if (dup) this.links.push({ src: record.id, dst: dup.id, rel: "revises" });
    this.linkRelated(record);
    this.changed();
    return { record, action: dup ? "proposed" : "added" };
  }

  /** Tie a new memory to the few it most resembles, so the graph grows. */
  linkRelated(record: MemoryRecord, max = 3) {
    const mine = new Set(record.tags.filter((t) => !GENERIC_TAGS.has(t)));
    const candidates = this.active()
      .filter((r) => r.id !== record.id && r.id !== record.replaces)
      .map((r) => {
        const sharedTags = r.tags.filter((t) => mine.has(t)).length;
        const sim = similarity(`${r.title} ${r.body}`, `${record.title} ${record.body}`);
        return { r, weight: sim + 0.15 * sharedTags };
      })
      .filter((c) => c.weight >= 0.18)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, max);
    for (const { r } of candidates) {
      if (this.links.some((l) => (l.src === record.id && l.dst === r.id) || (l.src === r.id && l.dst === record.id))) continue;
      this.links.push({ src: record.id, dst: r.id, rel: "related" });
    }
  }

  update(id: string, patch: { title?: string; body?: string; kind?: string; tags?: string[]; pinned?: boolean }): MemoryRecord | null {
    const r = this.get(id);
    if (!r) return null;
    if (typeof patch.title === "string" && patch.title.trim()) r.title = patch.title.trim();
    if (typeof patch.body === "string" && patch.body.trim()) r.body = patch.body.trim();
    if (MEMORY_KINDS.includes(patch.kind as MemoryKind)) r.kind = patch.kind as MemoryKind;
    if (Array.isArray(patch.tags)) r.tags = patch.tags.map((t) => String(t).trim()).filter(Boolean);
    if (typeof patch.pinned === "boolean") r.pinned = patch.pinned;
    r.updated = now();
    this.changed();
    return r;
  }

  /** Retire a memory: replaced by another if one is named, else removed. */
  forget(id: string, replacedBy?: string | null): boolean {
    const r = this.get(id);
    if (!r) return false;
    // A replacement that does not exist is a mistake, not a request to delete.
    if (replacedBy && (!this.get(replacedBy) || replacedBy === id)) return false;
    if (replacedBy) {
      r.superseded_by = replacedBy;
      r.pinned = false;
      r.updated = now();
    } else {
      this.records.splice(this.records.indexOf(r), 1);
      for (let i = this.links.length - 1; i >= 0; i -= 1) {
        if (this.links[i].src === id || this.links[i].dst === id) this.links.splice(i, 1);
      }
      for (const other of this.records) if (other.replaces === id) other.replaces = null;
    }
    this.changed();
    return true;
  }

  /** Make a provisional memory known; a rewrite then retires what it rewrote. */
  confirm(id: string, save = true): MemoryRecord | null {
    const r = this.get(id);
    if (!r) return null;
    r.status = "confirmed";
    r.tags = r.tags.filter((t) => t !== "learned" && t !== "unconfirmed");
    if (r.replaces) {
      const old = this.get(r.replaces);
      if (old && !old.superseded_by) {
        old.superseded_by = r.id;
        if (old.pinned) r.pinned = true;
        old.pinned = false;
      }
      r.replaces = null;
    }
    r.updated = now();
    if (save) this.changed();
    return r;
  }

  /**
   * A turn that used this memory went well.
   *
   * Enough of those confirm a provisional memory without anyone having to,
   * and mark a confirmed procedure proven, which ranks it higher when it is
   * relevant. It is never pinned for it: always-recalled is for what the
   * person pins, since a skill that worked for one job is noise on every
   * other.
   * Returns what changed, for the thread.
   */
  reinforce(id: string): "confirmed" | "promoted" | null {
    const r = this.get(id);
    if (!r || r.superseded_by) return null;
    r.worked = (r.worked ?? 0) + 1;
    let change: "confirmed" | "promoted" | null = null;
    if (r.status === "provisional" && r.worked >= CONFIRM_AFTER) {
      this.confirm(r.id, false);
      change = "confirmed";
    } else if (
      r.status === "confirmed" && r.kind === "procedure" && !r.tags.includes("proven") &&
      r.worked >= PROMOTE_AFTER
    ) {
      r.tags = [...new Set([...r.tags, "proven"])];
      change = "promoted";
    }
    this.changed();
    return change;
  }

  /**
   * Housekeeping, run daily: merge near-copies that slipped in, drop learned
   * guesses nobody confirmed or used within a month, and drop links to
   * records that are gone.
   */
  consolidate(at = now()): { merged: number; dropped: number; unlinked: number } {
    let merged = 0;
    let dropped = 0;
    const current = this.active();
    for (let i = 0; i < current.length; i += 1) {
      const a = current[i];
      if (a.superseded_by) continue;
      for (let j = i + 1; j < current.length; j += 1) {
        const b = current[j];
        if (b.superseded_by || a.kind !== b.kind || a.status !== b.status) continue;
        if (similarity(`${a.title} ${a.body}`, `${b.title} ${b.body}`) < 0.8) continue;
        const [keep, old] = a.updated >= b.updated ? [a, b] : [b, a];
        keep.uses += old.uses;
        keep.worked = (keep.worked ?? 0) + (old.worked ?? 0);
        keep.pinned = keep.pinned || old.pinned;
        keep.tags = [...new Set([...keep.tags, ...old.tags])];
        old.superseded_by = keep.id;
        old.pinned = false;
        merged += 1;
      }
    }
    for (const r of [...this.records]) {
      if (
        r.status === "provisional" && !r.pinned && (r.worked ?? 0) === 0 && r.uses <= 1 &&
        at - r.created > STALE_PROVISIONAL_S
      ) {
        this.records.splice(this.records.indexOf(r), 1);
        dropped += 1;
      }
    }
    const ids = new Set(this.records.map((r) => r.id));
    const before = this.links.length;
    for (let i = this.links.length - 1; i >= 0; i -= 1) {
      if (!ids.has(this.links[i].src) || !ids.has(this.links[i].dst)) this.links.splice(i, 1);
    }
    const unlinked = before - this.links.length;
    if (merged || dropped || unlinked) this.changed();
    return { merged, dropped, unlinked };
  }
}
