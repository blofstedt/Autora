/**
 * The rules the mind is kept by.
 *
 * A pile of notes written by whoever had a thought at the time is hard to
 * recall from: titles that say nothing about what they are about, a paragraph
 * holding five facts, a note about "right now" that was never true again, a
 * claim about how a website works with no word on where it came from. This is
 * what every write is held to, and what the tidy pass holds the old ones to,
 * so recall finds one thing per record under the name it is known by.
 *
 *  - One topic per record, short enough to read at a glance.
 *  - A title that starts with its subject: "GitHub: where repository settings are".
 *  - Durable: nothing about this conversation, nothing secret.
 *  - A `reference` is what the official source says -- how a product, API or
 *    interface works -- and carries where it was read and when. Interfaces
 *    change, so a reference is checked against its source again after a while.
 *
 * Pure: text in, a verdict or a normalised entry out.
 */

import { siteOf } from "./site";
import type { MemoryRecord } from "./memory";

export type Facet = "interface" | "api" | "docs" | "workflow" | "quirk";
export const FACETS: Facet[] = ["interface", "api", "docs", "workflow", "quirk"];

/** Characters a record may hold, by kind: a fact is one sentence or two. */
export const MAX_BODY: Record<string, number> = {
  preference: 400,
  fact: 600,
  procedure: 1200,
  skill: 1500,
  reference: 1500,
};

/** How long a reference is trusted before it is read from its source again.
    Where to click moves faster than what an API is called. */
export const REFERENCE_FRESH_DAYS: Record<Facet, number> = {
  interface: 21,
  workflow: 45,
  quirk: 60,
  api: 60,
  docs: 90,
};

const SECRET = /(password|passwd|api[_ -]?key|secret|token)\s*[:=]\s*\S{6,}/i;
/** Wording that places a note in this conversation rather than in the world. */
const EPHEMERAL = /\b(this (?:session|conversation|chat|turn)|just now|right now|today's|i am (?:now )?working on|we are (?:now )?working on|todo)\b/i;

/** Hosts whose pages are someone's retelling, not the product's own word. */
const NOT_OFFICIAL = new Set([
  "stackoverflow.com", "stackexchange.com", "reddit.com", "quora.com", "medium.com", "dev.to",
  "youtube.com", "youtu.be", "w3schools.com", "geeksforgeeks.org", "tutorialspoint.com", "hackernoon.com",
  "substack.com", "blogspot.com", "wordpress.com", "facebook.com", "twitter.com", "x.com", "pinterest.com",
]);
const squash = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** A subject as it is filed: lowercase words, nothing else. */
export function subjectKey(subject: string): string {
  return squash(subject, 60).toLowerCase().replace(/[^\p{L}\p{N}.+# -]/gu, "").replace(/\s+/g, " ").trim();
}

export interface SourceCheck {
  ok: boolean;
  /** The address as kept (no fragment, no tracking). */
  url: string;
  host: string;
  site: string;
  /** Whether it reads as the subject's own word. */
  official: boolean;
  error?: string;
}

/**
 * Whether an address can stand as a reference's source, and whether it looks
 * like the subject's own documentation. A heuristic, said as one: a domain
 * that carries the subject's name, and is not a forum or a blog platform. When
 * it is not recognisably official the record is kept as unconfirmed, for the
 * person to look at.
 */
export function checkSource(raw: unknown, subject: string): SourceCheck {
  const text = String(raw ?? "").trim();
  const bad = (error: string): SourceCheck => ({ ok: false, url: "", host: "", site: "", official: false, error });
  let u: URL;
  try { u = new URL(text); } catch { return bad("source must be the address of the page the information came from (https://...)."); }
  if (u.protocol !== "https:" && u.protocol !== "http:") return bad("source must be an http(s) address.");
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const site = siteOf(host);
  if (!site) return bad("source must be a public web address (not localhost or an IP number).");
  u.hash = "";
  for (const key of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref$)/i.test(key)) u.searchParams.delete(key);
  const name = site.split(".")[0];
  const key = subjectKey(subject).replace(/[ .+#-]/g, "");
  const carriesName = name.length >= 3 && key.length >= 3 && (key.includes(name) || name.includes(key));
  // A page on the subject's own domain is its own word. A docs-looking page elsewhere can still be
  // right (a vendor documenting a product it makes) but cannot be told from a mirror: it is kept
  // unconfirmed, for the person to look at.
  const official = !NOT_OFFICIAL.has(site) && carriesName;
  return { ok: true, url: u.toString(), host, site, official };
}

export interface EntryInput {
  title: unknown;
  body: unknown;
  kind?: unknown;
  tags?: unknown;
  subject?: unknown;
  facet?: unknown;
  source?: unknown;
  version?: unknown;
}

export interface Entry {
  title: string;
  body: string;
  kind: "fact" | "preference" | "procedure" | "skill" | "reference";
  tags: string[];
  subject: string | undefined;
  facet: Facet | undefined;
  source: string | undefined;
  version: string | undefined;
  /** What it should be filed as: a reference from an unfamiliar source waits to be looked at. */
  status: "confirmed" | "provisional";
}

/** What is wrong with the words of a memory, or null: too long for its kind, about the moment, holding a secret. */
export function checkText(kind: string, title: string, body: string): string | null {
  if (SECRET.test(body) || SECRET.test(title)) {
    return "That holds what looks like a password, key or token. Secrets are never written to memory; say where it is kept instead.";
  }
  const limit = MAX_BODY[kind] ?? 600;
  if (body.length > limit) {
    return `Too long for a ${kind} (${body.length} characters; at most ${limit}). One topic per memory: split it into separate records, each with a title naming what it covers, or keep only what will matter again.`;
  }
  if (kind !== "reference" && (EPHEMERAL.test(title) || EPHEMERAL.test(body))) {
    return "That reads as a note about this conversation or this moment, which is already in the log. Memory is for what will still be true and useful in other sessions; rewrite it as that, or leave it out.";
  }
  return null;
}

export type EntryVerdict = { ok: true; entry: Entry; notes: string[] } | { ok: false; error: string };

const KINDS = new Set(["fact", "preference", "procedure", "skill", "reference"]);

const titled = (subject: string, title: string) => {
  const s = subject.trim();
  if (!s) return title;
  if (title.toLowerCase().includes(s.toLowerCase())) return title;
  return `${s[0].toUpperCase()}${s.slice(1)}: ${title}`.slice(0, 200);
};

/**
 * A write held to the rules: the entry as it will be kept, or what to change.
 * The messages are written to the agent, which fixes the call and tries again.
 */
export function checkEntry(input: EntryInput): EntryVerdict {
  const notes: string[] = [];
  const title = squash(input.title, 200);
  const body = String(input.body ?? "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (!title || !body) return { ok: false, error: "A memory needs both a title and a body." };
  const kind = (KINDS.has(String(input.kind)) ? String(input.kind) : "fact") as Entry["kind"];
  const wrong = checkText(kind, title, body);
  if (wrong) return { ok: false, error: wrong };

  let subject = subjectKey(String(input.subject ?? "")) || undefined;
  const sourceRaw = String(input.source ?? "").trim();
  let source: string | undefined;
  let facet: Facet | undefined;
  let status: Entry["status"] = "confirmed";
  const tags = Array.isArray(input.tags) ? input.tags.map((t) => squash(t, 40).toLowerCase()).filter(Boolean) : [];

  if (kind === "reference") {
    if (!subject) return { ok: false, error: "A reference needs a subject: the product, site or app it is about (for example \"github\" or \"google sheets\")." };
    const asked = String(input.facet ?? "").trim().toLowerCase();
    facet = (FACETS as string[]).includes(asked) ? (asked as Facet) : "docs";
    if (!sourceRaw) {
      return { ok: false, error: "A reference needs its source: the address of the official page it was read from. Fetch it (web_search, then http_request or browser_read on the docs page), then write it down with that address." };
    }
    const checked = checkSource(sourceRaw, subject);
    if (!checked.ok) return { ok: false, error: checked.error ?? "That source cannot be used." };
    source = checked.url;
    if (!checked.official) {
      status = "provisional";
      notes.push(`${checked.host} does not read as ${subject}'s own site or documentation, so this is kept as unconfirmed until the person looks at it. Prefer the vendor's own docs or help pages.`);
    }
    tags.push(facet, checked.site.split(".")[0]);
  } else {
    if (sourceRaw) {
      const checked = checkSource(sourceRaw, subject ?? "");
      if (checked.ok) source = checked.url;
    }
    const asked = String(input.facet ?? "").trim().toLowerCase();
    if ((FACETS as string[]).includes(asked)) facet = asked as Facet;
  }
  if (!subject) {
    // A note filed under a site is about that site.
    const site = tags.map((t) => siteOf(t)).find(Boolean);
    if (site) subject = site.split(".")[0];
  }

  const version = squash(input.version, 40) || undefined;
  return {
    ok: true,
    notes,
    entry: {
      title: titled(squash(input.subject, 60) || subject || "", title),
      body,
      kind,
      tags: [...new Set(tags)],
      subject,
      facet,
      source,
      version,
      status,
    },
  };
}

// ------------------------------------------------------------------ tidy --

const BOOKKEEPING = new Set(["skill", "agent-authored", "learned", "unconfirmed", "proven", "reference", "dead-end"]);

export interface TidyReport {
  /** Records changed, with what was done. */
  fixed: { id: string; title: string; did: string[] }[];
  /** Records the rules would not accept as written, and why -- for a person (or the agent) to rewrite. */
  flagged: { id: string; title: string; problems: string[] }[];
  total: number;
}

/** A subject for an old record that never had one: its site, else its first topical tag. */
function inferSubject(r: MemoryRecord): string | undefined {
  const site = r.tags.map((t) => siteOf(t)).find(Boolean);
  if (site) return site.split(".")[0];
  const tag = r.tags.find((t) => !BOOKKEEPING.has(t) && /^[\p{L}\p{N}][\p{L}\p{N} .+#-]{1,29}$/u.test(t));
  return tag ? subjectKey(tag) : undefined;
}

/**
 * Bring the existing records up to the rules, as far as plain code can: tidy
 * whitespace, file each under a subject, put the subject at the front of the
 * title. What needs judgment (too long, about the moment, a reference with no
 * source, knowledge gone stale) is listed, not rewritten.
 */
export function tidyRecords(records: MemoryRecord[], at = Math.floor(Date.now() / 1000)): TidyReport {
  const report: TidyReport = { fixed: [], flagged: [], total: 0 };
  for (const r of records) {
    if (r.superseded_by) continue;
    report.total += 1;
    const did: string[] = [];
    const problems: string[] = [];

    const title = squash(r.title, 200);
    const body = r.body.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    if (title !== r.title) { r.title = title; did.push("tidied the title"); }
    if (body !== r.body) { r.body = body; did.push("tidied the text"); }

    if (!r.subject) {
      const guess = inferSubject(r);
      if (guess) { r.subject = guess; did.push(`filed under "${guess}"`); }
    }
    if (r.subject) {
      const next = titled(r.subject, r.title);
      if (next !== r.title && r.kind !== "preference") { r.title = next; did.push("put the subject at the front of the title"); }
    }

    const limit = MAX_BODY[r.kind] ?? 600;
    if (r.body.length > limit) problems.push(`${r.body.length} characters is too long for a ${r.kind} (at most ${limit}): split it, one topic each`);
    if (r.kind !== "reference" && (EPHEMERAL.test(r.title) || EPHEMERAL.test(r.body))) problems.push("reads as a note about a moment, not something durable");
    if (SECRET.test(r.body)) problems.push("looks like it holds a secret");
    if (!r.subject) problems.push("no subject: edit it to say what it is about");
    if (r.kind === "reference") {
      if (!r.source) problems.push("a reference with no source");
      else if (referenceAgeDays(r, at) > REFERENCE_FRESH_DAYS[r.facet ?? "docs"]) problems.push(`read from its source ${referenceAgeDays(r, at)} days ago; read it again before relying on it`);
    }
    if (did.length > 0) { r.updated = at; report.fixed.push({ id: r.id, title: r.title, did }); }
    if (problems.length > 0) report.flagged.push({ id: r.id, title: r.title, problems });
  }
  return report;
}

/** Days since a reference was read from its source (or last checked). */
export function referenceAgeDays(r: MemoryRecord, at = Math.floor(Date.now() / 1000)): number {
  const when = Math.max(r.fetched ?? 0, r.checked ?? 0) || r.updated;
  return Math.max(0, Math.floor((at - when) / 86400));
}

/** Whether a reference is still within the time its sort of knowledge is trusted. */
export function referenceFresh(r: MemoryRecord, at = Math.floor(Date.now() / 1000)): boolean {
  return r.kind === "reference" && !r.superseded_by && referenceAgeDays(r, at) <= REFERENCE_FRESH_DAYS[r.facet ?? "docs"];
}

// ------------------------------------------------------------ grounding --

/** Calls that act on a site rather than look at it. Looking is how a page gets read; acting is where
    not knowing the interface costs a wrong click on someone's account. */
export function actsOnSite(name: string, args: Record<string, any> = {}): boolean {
  if (name === "browser_click" || name === "browser_fill" || name === "browser_press" || name === "browser_upload") return true;
  if (name === "http_request") {
    const method = String(args.method ?? "GET").toUpperCase();
    return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
  }
  return false;
}

/** Refusals of one site's actions, in a turn, before the agent is let through: a docs site that is
    down, or no official page to be found, must not wedge the turn. */
export const GROUNDING_REFUSALS = 3;

/**
 * What to say before an action on a site nothing current is stored about, or
 * null to let it go. `fresh` is whether memory holds a reference for the site
 * still inside its time; `refused` how many times this turn has been told.
 */
export function groundingRefusal(opts: { enabled: boolean; site: string; fresh: boolean; stale: boolean; refused: number }): string | null {
  if (!opts.enabled || !opts.site || opts.fresh) return null;
  if (opts.refused >= GROUNDING_REFUSALS) return null;
  const what = opts.stale
    ? `what is stored about ${opts.site} was read from its source too long ago to trust (interfaces change)`
    : `nothing is stored about how ${opts.site} works`;
  return (
    `Not done yet: ${what}, and this would act on it. Find out first, from the official source: ` +
    `web_search for ${opts.site}'s own documentation or help pages (or hand it to the research tool, which keeps your context clean), ` +
    "read the page that covers what you are about to do, then write down what you learned with memory_write: " +
    `kind "reference", subject "${opts.site.split(".")[0]}", facet "interface" for where things are and what they are called or "api" for endpoints, ` +
    "source the address you read it from, one topic per record. Then repeat this action. " +
    (opts.refused >= GROUNDING_REFUSALS - 1
      ? "(If no official documentation can be found, repeat the action once more and it will go ahead.)"
      : "Reading the page you are on is always allowed.")
  );
}
