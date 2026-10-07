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

import { siteOf } from "./site";
import { REFERENCE_FRESH_DAYS, referenceAgeDays } from "./mindrules";

export type MemoryKind = "fact" | "preference" | "procedure" | "skill" | "reference";
export const MEMORY_KINDS: MemoryKind[] = ["preference", "procedure", "fact", "skill", "reference"];

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
  /** When somebody last said this still holds. A memory written eight months
      ago and never checked is a different thing from one used this morning,
      and the note says so. Null on records written before this existed. */
  checked?: number | null;
  superseded_by: string | null;
  /** Times a turn that used it went well. Drives confirming and promoting. */
  worked?: number;
  /** A provisional rewrite of this record, which replaces it on confirm. */
  replaces?: string | null;
  /** What it is about, as filed (lowercase): the product, site or app. See mindrules.ts. */
  subject?: string;
  /** For knowledge about a product: interface, api, docs, workflow or quirk. */
  facet?: "interface" | "api" | "docs" | "workflow" | "quirk";
  /** For a reference: the page it was read from, when (seconds), and the version it described. */
  source?: string | null;
  fetched?: number | null;
  version?: string;
  /** Times a turn that used it found it wrong, since it last held. A
      confirmed memory is not deleted for one bad turn -- it may be the turn
      that was wrong -- but it ranks lower, and says so when it is recalled,
      until it is checked, rewritten or works again. */
  doubted?: number;
}

export interface MemoryLink {
  src: string;
  dst: string;
  rel: string;
}

interface Recalled {
  record: MemoryRecord;
  score: number;
  /** Why it was picked, in words for the chip's tooltip. */
  reason: string;
}

/** A provisional memory that has worked this many times is confirmed. */
const CONFIRM_AFTER = 2;
/** A confirmed procedure that has worked this many times is marked proven,
    which ranks it higher whenever it matches. It is not pinned: see reinforce. */
const PROMOTE_AFTER = 3;
/** Unconfirmed, unused memories older than this are dropped by consolidate. */
const STALE_PROVISIONAL_S = 30 * 24 * 3600;
/** A memory nobody has confirmed in this long speaks up about it. */
const STALE_CHECKED_S = 30 * 24 * 3600;

// ------------------------------------------------------------------ text --

const STOP = new Set(
  ("a an and are as at be but by can do does for from has have how i if in into is it its " +
    "me my of on or our so that the their them then there these this to use was we what " +
    "when where which who why will with you your please just also should would could about " +
    "all any some get got make made want need not no here now http https www").split(" "),
);

/** Parts of a dotted name that say nothing about what it names. */
const EMPTY_PARTS = new Set(["com", "org", "net", "edu", "gov", "www", "http", "https"]);

/* Letters and digits in any script. It was a-z only, so a memory written in
   Swedish or German lost every word with an accent in it ("portfölj" became
   "portf" and "lj"), and one in Greek or Cyrillic had no words at all and
   could never be recalled. */
const WORD = /[\p{L}\p{N}][\p{L}\p{N}_.-]*[\p{L}\p{N}]|[\p{L}\p{N}]/gu;

/** Lowercase words, stop words out, plural and tense endings off. */
export function tokens(text: string): string[] {
  const out: string[] = [];
  for (const word of text.toLowerCase().match(WORD) ?? []) {
    if (!/[_.-]/.test(word)) {
      if (!STOP.has(word)) out.push(stem(word));
      continue;
    }
    /* "docker-jellyfin", "server.ts", "github.com": the whole, as written,
       and each part, so a question about jellyfin finds the note about the
       docker-jellyfin container. */
    out.push(word);
    for (const part of word.split(/[_.-]+/)) {
      if (part.length >= 3 && /\p{L}/u.test(part) && !STOP.has(part) && !EMPTY_PARTS.has(part)) out.push(stem(part));
    }
  }
  return out;
}

/**
 * The same word in its different forms, as one.
 *
 * Not a real stemmer, and it does not need to be: it only has to turn the
 * forms of a word into the same string. The one it replaced cut "prices" to
 * "pric" and left "price" alone, so a note about share prices was not found
 * by a question about the price -- and the same for file and files, trade and
 * trading, update and updated. Here every form loses its ending and then its
 * silent e, so they meet: price, prices, priced, pricing are all "pric".
 */
function stem(word: string): string {
  if (word.length <= 3 || !/^[a-z]+$/.test(word)) return word;
  const vowel = /[aeiouy]/;
  let w = word;
  if (w.endsWith("ies") && w.length > 4) w = w.slice(0, -2);
  else if (w.endsWith("s") && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith("ing") && vowel.test(w.slice(0, -3))) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ed") && !w.endsWith("eed") && vowel.test(w.slice(0, -2))) w = w.slice(0, -2);
  // "runn(ing)" is "run", "stopp(ed)" is "stop".
  if (w !== word && /([b-df-hj-km-np-rtv-z])\1$/.test(w)) w = w.slice(0, -1);
  if (w.length > 3 && w.endsWith("e") && !w.endsWith("ee")) w = w.slice(0, -1);
  // "entry" and "entri(es)", "reply" and "repli(ed)".
  if (w.length > 3 && /[^aeiou]y$/.test(w)) w = `${w.slice(0, -1)}i`;
  return w;
}

/** Overlap of two texts' vocabularies, 0..1. */
export function similarity(a: string, b: string): number {
  return overlap(new Set(tokens(a)), new Set(tokens(b)));
}

/** Overlap of two vocabularies, 0..1. */
function overlap(x: ReadonlySet<string>, y: ReadonlySet<string>): number {
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

/** A request with this many words or fewer may be a follow-up whose subject
    is in the conversation before it. See recallForTurn. */
const FOLLOW_UP_WORDS = 6;
/** Words that point back at something said before. */
const REFERS = /\b(it|that|this|those|these|them|they|same|again|other|another|else|instead|retry|continue|carry on|go ahead|yes|yeah|yep|ok|okay|sure)\b/i;

/**
 * Whether a request leans on the conversation before it for what it is
 * about: "yes, do that", "try again", "and the other one?", or a single
 * word. "What's the weather in Paris" is short, and not one.
 */
function isFollowUp(request: string): boolean {
  const words = new Set(tokens(request)).size;
  return words <= 1 || (words <= FOLLOW_UP_WORDS && REFERS.test(request));
}

export { siteOf };

interface Indexed {
  /** Words of the title and topical tags: what the memory is about. */
  head: Set<string>;
  /** Words of the title and body, for telling near-copies apart. */
  vocab: Set<string>;
  /** The title's words in order: two titles that say the same thing. */
  titleKey: string;
  /** How many words in all, for BM25's length normalisation. */
  words: number;
  tf: Map<string, number>;
}

/* Each memory's words, kept until it changes. Recall ran the tokenizer over
   every memory, body and all, two or three times a turn (the turn's recall,
   the look back afterwards) -- with a few hundred memories
   that was most of the time a turn spent before its first word. */
const indexCache = new WeakMap<MemoryRecord, Indexed & { title: string; body: string; tags: string }>();

function indexOf(r: MemoryRecord): Indexed {
  const tags = [...r.tags, r.subject ?? "", r.facet ?? "", r.source ?? ""].join("\u0000");
  const hit = indexCache.get(r);
  if (hit && hit.title === r.title && hit.body === r.body && hit.tags === tags) return hit;
  // Bookkeeping tags ("skill", "learned") say how a memory came to be,
  // not what it is about; matched, they would recall every skill at once.
  const sourceSite = r.source ? siteOf(hostOf(r.source)) : "";
  const topical = [
    ...r.tags.filter((t) => !GENERIC_TAGS.has(t)),
    ...(r.subject ? [r.subject] : []),
    ...(r.facet ? [r.facet] : []),
    ...(sourceSite ? [sourceSite] : []),
  ].flatMap((t) => tokens(t));
  const title = tokens(r.title);
  const body = tokens(r.body);
  const tf = new Map<string, number>();
  // Title and tags count double: they are what the memory is about.
  for (const w of title) tf.set(w, (tf.get(w) ?? 0) + 2);
  for (const w of topical) tf.set(w, (tf.get(w) ?? 0) + 2);
  for (const w of body) tf.set(w, (tf.get(w) ?? 0) + 1);
  const entry = {
    head: new Set([...title, ...topical]),
    vocab: new Set([...title, ...body]),
    titleKey: title.join(" "),
    words: 2 * title.length + 2 * topical.length + body.length,
    tf, title: r.title, body: r.body, tags,
  };
  indexCache.set(r, entry);
  return entry;
}

function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return ""; }
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

  /** Saved after a change made to the records from outside (the tidy pass). */
  save() {
    this.changed();
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
    const docs = pool.map((r) => ({ record: r, ...indexOf(r) }));
    const avg = docs.reduce((n, d) => n + d.words, 0) / Math.max(docs.length, 1) || 1;
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
        score += idf * ((tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (d.words / avg))));
      }
      if (score > 0 && relevant(hit.length, headHits, want.length)) {
        const r = d.record;
        score *= 1 + 0.1 * Math.log1p(r.uses) + 0.15 * Math.log1p(r.worked ?? 0);
        if (r.tags.includes("proven")) score *= 1.2;
        if (r.status === "provisional") score *= 0.8;
        if (r.doubted) score *= 0.7 ** Math.min(r.doubted, 3);
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

  /**
   * The memories for a turn: what the request is about, and -- when the
   * request is a follow-up too short to say it -- what the conversation
   * before it was about.
   *
   * Recall on the request alone found nothing for "yes, do that", "try it
   * again" or "and the other server?": the words that say what "that" is are
   * in the previous exchange. A request that is not a follow-up (see
   * isFollowUp) is recalled on its own words alone, so the last subject does
   * not follow the person into a new one.
   */
  recallForTurn(request: string, conversation: string, limit = 6): Recalled[] {
    const direct = this.recall(request, limit);
    if (!conversation.trim() || !isFollowUp(request)) return direct;
    const found = direct.filter((r) => r.score !== Infinity).length;
    const room = Math.min(limit - found, 3);
    if (room <= 0) return direct;
    const more = this.recall(conversation, limit, false)
      .filter((r) => !direct.some((d) => d.record.id === r.record.id))
      .slice(0, room)
      .map((r) => ({ ...r, reason: `from the conversation so far: ${r.reason}` }));
    return [...direct, ...more];
  }

  /**
   * What is written down about a website, for the moment the agent gets there.
   *
   * The turn's recall is made from the person's words, before anything has
   * run -- so the note that says this shop's login needs the second form, or
   * that this site's API wants a header, was only found if the person
   * happened to name the site. This finds it when the browser does.
   *
   * `host` is matched on the site it belongs to (shop.example.com is
   * example.com) anywhere in a memory, and on the site's name ("github")
   * as a whole word in its title or tags.
   */
  aboutSite(host: string, exclude: ReadonlySet<string> = new Set(), limit = 3): MemoryRecord[] {
    const site = siteOf(host);
    if (!site) return [];
    const name = site.split(".")[0];
    const inText = new RegExp(`(^|[^a-z0-9-])${site.replace(/\./g, "\\.")}($|[^a-z0-9-])`, "i");
    const byName = name.length >= 4 ? new RegExp(`(^|[^\\p{L}\\p{N}])${name}($|[^\\p{L}\\p{N}])`, "iu") : null;
    const rank = (r: MemoryRecord) =>
      (r.pinned ? 8 : 0) + (r.tags.includes("proven") ? 4 : 0) + (r.status === "confirmed" ? 2 : 0) -
      (r.doubted ?? 0) * 2 + Math.log1p(r.worked ?? 0) + 0.1 * Math.log1p(r.uses);
    // What was read from the site's own documentation comes first: it is the most reliable thing held about it.
    const refs = this.referencesFor(host).filter((r) => !exclude.has(r.id));
    const have = new Set(refs.map((r) => r.id));
    const others = this.active()
      .filter((r) => !exclude.has(r.id) && !have.has(r.id))
      .filter((r) =>
        inText.test(r.title) || inText.test(r.body) || r.tags.some((t) => inText.test(t)) ||
        (byName !== null && (byName.test(r.title) || r.tags.some((t) => byName.test(t)))))
      .sort((a, b) => rank(b) - rank(a) || b.updated - a.updated);
    return [...refs, ...others].slice(0, limit);
  }

  /**
   * The references held for a site or product, newest first. A reference
   * belongs to a site when it was read from it, or is filed under its name
   * ("github" for github.com), so a note read from docs.github.com and one
   * about "GitHub" are found together.
   */
  referencesFor(host: string): MemoryRecord[] {
    const site = siteOf(host);
    if (!site) return [];
    const name = site.split(".")[0];
    return this.active()
      .filter((r) => r.kind === "reference")
      .filter((r) => (r.source ? siteOf(hostOf(r.source)) === site : false) || r.subject === name)
      .sort((a, b) => Math.max(b.fetched ?? 0, b.checked ?? 0) - Math.max(a.fetched ?? 0, a.checked ?? 0));
  }

  /** What is held about a site and how current: none, only old, or fresh. */
  groundingOf(host: string, at = now()): "none" | "stale" | "fresh" {
    const found = this.referencesFor(host);
    if (found.length === 0) return "none";
    return found.some((r) => referenceAgeDays(r, at) <= REFERENCE_FRESH_DAYS[r.facet ?? "docs"]) ? "fresh" : "stale";
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
    const wanted = tokens(title).join(" ");
    const vocab = new Set(tokens(`${title} ${body}`));
    let best: MemoryRecord | null = null;
    let bestSim = 0;
    for (const r of this.active()) {
      if (r.kind !== kind) continue;
      const known = indexOf(r);
      if (wanted && known.titleKey === wanted) return r;
      // Two references to the same page are one record, however the body was reworded.
      const sim = overlap(known.vocab, vocab);
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
    subject?: string;
    facet?: MemoryRecord["facet"];
    /** For a reference: the page it was read from. */
    source?: string;
    version?: string;
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
      if (input.subject) dup.subject = input.subject;
      if (input.facet) dup.facet = input.facet;
      if (input.source) { dup.source = input.source; dup.fetched = t; }
      if (input.version) dup.version = input.version;
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
      ...(input.subject ? { subject: input.subject } : {}),
      ...(input.facet ? { facet: input.facet } : {}),
      ...(input.source ? { source: input.source, fetched: t } : {}),
      ...(input.version ? { version: input.version } : {}),
    };
    this.records.push(record);
    if (dup) this.links.push({ src: record.id, dst: dup.id, rel: "revises" });
    this.linkRelated(record);
    this.changed();
    return { record, action: dup ? "proposed" : "added" };
  }

  /** Tie a new memory to the few it most resembles, so the graph grows. */
  linkRelated(record: MemoryRecord, max = 3) {
    const topics = new Set(record.tags.filter((t) => !GENERIC_TAGS.has(t)));
    const mine = indexOf(record);
    const candidates = this.active()
      .filter((r) => r.id !== record.id && r.id !== record.replaces)
      .map((r) => {
        const sharedTags = r.tags.filter((t) => topics.has(t)).length;
        const sim = overlap(indexOf(r).vocab, mine.vocab);
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

  update(id: string, patch: {
    title?: string; body?: string; kind?: string; tags?: string[]; pinned?: boolean;
    subject?: string; facet?: MemoryRecord["facet"]; source?: string; version?: string;
  }): MemoryRecord | null {
    const r = this.get(id);
    if (!r) return null;
    if (typeof patch.title === "string" && patch.title.trim()) r.title = patch.title.trim().slice(0, 200);
    if (typeof patch.body === "string" && patch.body.trim() && patch.body.trim() !== r.body) {
      r.body = patch.body.trim();
      // Rewritten, it is a different claim from the one that was doubted.
      r.doubted = 0;
    }
    if (MEMORY_KINDS.includes(patch.kind as MemoryKind)) r.kind = patch.kind as MemoryKind;
    if (Array.isArray(patch.tags)) {
      /* Lowercased as write() does, or "Jellyfin" and "jellyfin" were two
         tags. The bookkeeping ones ride along: a new list of topics is not a
         request to forget that the memory is unconfirmed, or proven. */
      const kept = r.tags.filter((t) => t === "learned" || t === "proven");
      r.tags = [...new Set([...patch.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean), ...kept])];
    }
    if (typeof patch.pinned === "boolean") r.pinned = patch.pinned;
    if (typeof patch.subject === "string" && patch.subject.trim()) r.subject = patch.subject.trim().toLowerCase().slice(0, 60);
    if (patch.facet) r.facet = patch.facet;
    if (typeof patch.version === "string") r.version = patch.version.trim().slice(0, 40) || undefined;
    if (typeof patch.source === "string" && patch.source.trim()) {
      r.source = patch.source.trim();
      r.fetched = now();
    } else if (r.kind === "reference" && r.source && typeof patch.body === "string" && patch.body.trim()) {
      // Rewritten from its source: read again today.
      r.fetched = now();
    }
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
    r.checked = now();
    r.doubted = 0;
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
   * Somebody used this and found it still true.
   *
   * Not the same as reinforcing it: that says a memory helped, which happens
   * without anyone checking it. This says the world still matches it -- the
   * path is still there, the command still works, the release still goes that
   * way -- and stamps the date, so a memory nobody has confirmed in months
   * announces itself as such instead of reading like this morning's news.
   * A note is added to the body when what was found differs in detail.
   */
  recheck(id: string, note?: string, save = true): MemoryRecord | null {
    const r = this.get(id);
    if (!r) return null;
    const said = String(note ?? "").trim();
    if (said) {
      const stamp = new Date().toISOString().slice(0, 10);
      r.body = `${r.body.trim()}\n\nChecked ${stamp}: ${said}`.slice(0, 4000);
    }
    r.checked = now();
    r.updated = now();
    r.doubted = 0;
    if (save) this.changed();
    return r;
  }

  /**
   * A turn that used this memory found it wrong.
   *
   * An unconfirmed guess is simply dropped for it (see reflect in server.ts).
   * A confirmed memory is not: one turn is not proof, and the memory may be
   * right where the turn went wrong. It ranks lower, and when it is recalled
   * it says it was found wrong, so the next turn checks it rather than
   * trusting it -- and either fixes it or confirms it, which clears this.
   */
  doubt(id: string): MemoryRecord | null {
    const r = this.get(id);
    if (!r || r.superseded_by) return null;
    r.doubted = (r.doubted ?? 0) + 1;
    this.changed();
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
    r.doubted = 0;
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
        // From each memory's cached words: tokenising both texts for every
        // pair made this quadratic in the tokenizer, daily.
        if (overlap(indexOf(a).vocab, indexOf(b).vocab) < 0.8) continue;
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

/**
 * How a memory's age reads in the note, or null when it is recent enough not
 * to need saying. Kept next to the records rather than in the prompt builder
 * so the rule for when a memory counts as fresh is in one place.
 */
export function freshness(r: MemoryRecord, at = now()): string | null {
  if (r.kind === "reference") {
    const age = referenceAgeDays(r, at);
    if (age <= REFERENCE_FRESH_DAYS[r.facet ?? "docs"]) return null;
    return `read from its source ${age} days ago and ${r.facet === "interface" ? "interfaces change often" : "may have changed"}: ` +
      "open the source again and confirm it before relying on it";
  }
  const when = r.checked ?? r.updated;
  if (!when) return null;
  const days = Math.floor((at - when) / 86400);
  if (days < STALE_CHECKED_S / 86400) return null;
  const ago = days < 60 ? `${days} days` : `${Math.round(days / 30)} months`;
  return r.checked ? `last checked ${ago} ago` : `written ${ago} ago and never checked since`;
}

/** What the note says about a memory a recent turn found wrong, or null. */
export function doubtNote(r: MemoryRecord): string | null {
  if (!r.doubted) return null;
  return `found wrong on ${r.doubted === 1 ? "a recent turn" : `${r.doubted} recent turns`}: ` +
    "check it before relying on it, then fix it with memory_update or confirm it with memory_confirm";
}
