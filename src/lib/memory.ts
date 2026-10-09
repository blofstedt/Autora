export type MemoryRecord = {
  id: string;
  kind: "fact" | "preference" | "procedure" | "skill" | "reference";
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
  uses: number;
  last_used: number | null;
  superseded_by: string | null;
  /** Times a turn that used it went well. */
  worked?: number;
  /** For a learned rewrite: the memory it replaces once kept. */
  replaces?: string | null;
  /** Times a turn that used it found it wrong, since it last held. */
  doubted?: number;
  /** What it is about (a product, site, app or project). */
  subject?: string;
  /** For knowledge about a product: interface, api, docs, workflow or quirk. */
  facet?: "interface" | "api" | "docs" | "workflow" | "quirk";
  /** For a reference: the official page it was read from, and when (seconds). */
  source?: string | null;
  fetched?: number | null;
  version?: string;
};

export type MemoryLink = { src: string; dst: string; rel: string };

export type Knowledge = {
  records: MemoryRecord[];
  links: MemoryLink[];
  enabled: boolean;
  /** Whether the agent writes down what it learns after a turn. */
  learning?: boolean;
  /** Whether the agent reads a site's official documentation before acting on a site it has nothing current on. */
  groundFirst?: boolean;
};

export const KIND_COLOR: Record<MemoryRecord["kind"], string> = {
  preference: "var(--accent-2)",
  procedure: "var(--live)",
  fact: "var(--accent)",
  skill: "var(--glow-light)",
  reference: "var(--accent-3, var(--accent))",
};

export type Bucket = MemoryRecord["kind"];

/** The Mind's four buckets, in the order the page shows them. */
export const BUCKETS: { kind: Bucket; label: string; blurb: string }[] = [
  { kind: "preference", label: "Preferences", blurb: "How you like things done." },
  { kind: "procedure", label: "Procedures", blurb: "Steps it follows for a recurring job." },
  { kind: "fact", label: "Facts", blurb: "What is true about your setup." },
  { kind: "skill", label: "Skills", blurb: "Things it knows how to do." },
  { kind: "reference", label: "References", blurb: "What a product's own documentation says, with where and when it was read." },
];

/** Said when a record is changed from the page, so the graph beside it
    redraws now rather than on its next poll. */
const CHANGED = "autora:memory-changed";
export const announceChange = () => window.dispatchEvent(new Event(CHANGED));
export function onKnowledgeChange(fn: () => void): () => void {
  window.addEventListener(CHANGED, fn);
  return () => window.removeEventListener(CHANGED, fn);
}

export async function createRecord(body: Pick<MemoryRecord, "kind" | "title" | "body" | "tags">) {
  const res = await fetch("/api/memory", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? "Could not save");
  return (await res.json()) as MemoryRecord;
}

export async function fetchKnowledge(): Promise<Knowledge> {
  const res = await fetch("/api/memory");
  if (!res.ok) return { records: [], links: [], enabled: false };
  return res.json();
}

export async function patchRecord(id: string, body: Partial<MemoryRecord>) {
  await fetch(`/api/memory/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function deleteRecord(id: string) {
  await fetch(`/api/memory/${id}`, { method: "DELETE" });
}

/** Keep a learned memory: known from now on, replacing what it rewrote. */
export async function confirmRecord(id: string) {
  const res = await fetch(`/api/memory/${id}/confirm`, { method: "POST" });
  if (!res.ok) throw new Error("Could not keep it");
}

export async function setLearning(learning: boolean) {
  await fetch("/api/memory-settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ learning }),
  });
}

export async function setGroundFirst(groundFirst: boolean) {
  await fetch("/api/memory-settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ groundFirst }),
  });
}

export interface TidyReport {
  dry: boolean;
  total: number;
  fixed: { id: string; title: string; did: string[] }[];
  flagged: { id: string; title: string; problems: string[] }[];
}

/** Bring the memories up to the mind's rules; `dry` only says what would change. */
export async function tidyMemory(dry = false): Promise<TidyReport> {
  const res = await fetch("/api/memory/tidy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dry }),
  });
  if (!res.ok) throw new Error("Could not tidy the memory");
  return res.json();
}

/**
 * Edges the graph draws: only the links the mind made, between memories about the same thing (or one
 * that replaced another). A shared tag is not drawn: a tag on a few memories said nothing about whether
 * they are alike, and the web became a hairball in which a connection meant nothing. A line here is what
 * tells the agent "if you want this, you may want that", so it must not be drawn between strangers.
 */
export function edgesFor(k: Knowledge): { a: string; b: string; strong: boolean }[] {
  const ids = new Set(k.records.map((r) => r.id));
  const out: { a: string; b: string; strong: boolean }[] = [];
  const seen = new Set<string>();
  const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

  for (const link of k.links) {
    if (!ids.has(link.src) || !ids.has(link.dst)) continue;
    const id = key(link.src, link.dst);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ a: link.src, b: link.dst, strong: true });
  }

  return out;
}
