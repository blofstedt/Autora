/**
 * An agent's own mind: a full memory graph of its own, separate from Autora's.
 *
 * Autora, the lead, is the base agent and keeps the main Mind (memory.ts, about
 * the person and the work in general). Every other agent has a Mind of its own,
 * the same engine -- kinds, ranked recall, links, confirming and doubting what it
 * remembers, tidying -- over records that only it reads and writes. That is the
 * point of keeping them apart: a specialist that knows one domain well is not
 * confused by what Autora knows about everything else, and nothing about the
 * person leaks into an agent that has no business with it.
 *
 * While an agent works (server.ts `mindFor`) its turns recall from and write to
 * this graph in place of the main one. Autora can also hand a body of domain
 * knowledge to a specialist (`teach`), which is how the main Mind is split up as it
 * grows. Stored one file a agent, `agentmind-<id>.json`.
 */

import { MemoryGraph, type MemoryKind, type MemoryRecord } from "./memory";
import { LEAD_ID } from "./agents";
import { readDoc, saveDoc } from "./store";

export type NoteKind = "fact" | "lesson" | "tip" | "colleague";

/** A memory as the agent's short notes were: for the Threads prompt and the page. */
export interface Note {
  id: string;
  text: string;
  kind: string;
  from: string;
  at: number;
  used: number;
}

interface Stored { records: MemoryRecord[]; links: MemoryGraph["links"] }

const graphs = new Map<string, MemoryGraph>();
const LEGACY = "agentminds";
const clip = (v: unknown, n: number) => String(v ?? "").replace(/\u0000/g, "").replace(/\s+/g, " ").trim().slice(0, n);
const docOf = (id: string) => `agentmind-${id.replace(/[^A-Za-z0-9_-]/g, "")}`;

/** The kind of memory each sort of note is filed as. */
const FILED: Record<NoteKind, MemoryKind> = { fact: "fact", lesson: "procedure", tip: "skill", colleague: "fact" };

/**
 * The mind of agent `id`, loaded on first use. The notes an agent kept before
 * minds were graphs (one flat file for all of them) are brought in once.
 */
export function agentMind(id: string): MemoryGraph {
  const have = graphs.get(id);
  if (have) return have;
  const doc = docOf(id);
  const stored = readDoc<Stored>(doc);
  const records = Array.isArray(stored?.records) ? stored!.records : [];
  const links = Array.isArray(stored?.links) ? stored!.links : [];
  const graph = new MemoryGraph(records, links, () => saveDoc(doc, () => ({ records, links })));
  graphs.set(id, graph);
  const legacy = readDoc<Record<string, { text?: string; kind?: string; from?: string }[]>>(LEGACY);
  if (legacy && Array.isArray(legacy[id])) {
    for (const n of legacy[id]) remember(id, n.text, (n.kind as NoteKind) ?? "lesson", n.from ?? "");
    delete legacy[id];
    saveDoc(LEGACY, () => legacy);
  }
  return graph;
}

const asNote = (r: MemoryRecord): Note => ({
  id: r.id, text: r.body || r.title, kind: r.tags.find((t) => ["fact", "lesson", "tip", "colleague"].includes(t)) ?? r.kind,
  from: r.source ?? "", at: r.created, used: r.uses,
});

/** What an agent holds, newest last. */
export const notesOf = (agentId: string): Note[] => agentMind(agentId).active().map(asNote).sort((a, b) => a.at - b.at);

/**
 * Keeps one thing in the agent's own mind. Its graph merges what says the same
 * and links what is about the same subject, so this is a write, not an append.
 * Null when there was nothing worth keeping.
 */
export function remember(agentId: string, text: unknown, kind: NoteKind = "lesson", from = ""): Note | null {
  if (agentId === LEAD_ID) return null;
  const body = clip(text, 400);
  if (body.length < 8) return null;
  const k: NoteKind = ["fact", "lesson", "tip", "colleague"].includes(kind) ? kind : "lesson";
  const { record } = agentMind(agentId).write({
    title: body.length > 70 ? `${body.slice(0, 67)}...` : body, body, kind: FILED[k], tags: [k],
    ...(from ? { source: from } : {}),
  });
  return asNote(record);
}

export function forgetNote(agentId: string, noteId: string): boolean {
  return agentMind(agentId).forget(noteId);
}

/** A removed agent's mind goes with it. */
export function dropMind(agentId: string): void {
  const g = agentMind(agentId);
  for (const r of [...g.records]) g.forget(r.id);
  graphs.delete(agentId);
}

/** A merged-away agent's mind goes to the one that took over its job. */
export function mergeMind(fromId: string, intoId: string): void {
  copyRecords(agentMind(fromId), agentMind(intoId), agentMind(fromId).active().map((r) => r.id), false);
  dropMind(fromId);
}

/**
 * Copies memories from one graph to another, and (`move`) takes them out of the
 * first. What the person told Autora about themselves (preferences) never goes:
 * it is not domain knowledge and is not a specialist's to hold.
 */
export function copyRecords(from: MemoryGraph, to: MemoryGraph, ids: string[], move: boolean): MemoryRecord[] {
  const moved: MemoryRecord[] = [];
  for (const id of ids) {
    const r = from.get(id);
    if (!r || r.superseded_by || r.kind === "preference") continue;
    to.write({
      title: r.title, body: r.body, kind: r.kind, tags: r.tags.filter((t) => t !== "learned"),
      ...(r.subject ? { subject: r.subject } : {}), ...(r.facet ? { facet: r.facet } : {}),
      ...(r.source ? { source: r.source } : {}), ...(r.version ? { version: r.version } : {}),
    });
    moved.push(r);
  }
  if (move) for (const r of moved) from.forget(r.id);
  return moved;
}

/**
 * Hands a body of knowledge to an agent: the memories in `from` that bear on
 * `query` (the best `limit` that match, not the nearest-looking ones), copied
 * into the agent's mind and, with `move`, out of `from` -- which is how Autora
 * splits its Mind up as a domain grows.
 */
export function teach(from: MemoryGraph, agentId: string, query: string, move: boolean, limit = 25): MemoryRecord[] {
  const hits = from.recall(query, limit, false).filter((h) => h.score > 0).map((h) => h.record.id);
  return copyRecords(from, agentMind(agentId), hits, move);
}

/** Where a graph's knowledge clusters: by subject (or first tag), largest first. For deciding who to hire. */
export function clusters(g: MemoryGraph, max = 12): { name: string; count: number; samples: string[] }[] {
  const by = new Map<string, MemoryRecord[]>();
  for (const r of g.active()) {
    if (r.kind === "preference") continue;
    const key = (r.subject || r.tags.find((t) => !["learned", "proven"].includes(t)) || "").trim().toLowerCase();
    if (!key) continue;
    by.set(key, [...(by.get(key) ?? []), r]);
  }
  return [...by.entries()].map(([name, list]) => ({ name, count: list.length, samples: list.slice(0, 3).map((r) => r.title) }))
    .sort((a, b) => b.count - a.count).slice(0, max);
}

/** What an agent knows about, in a few words, for the map Autora is shown. "" while its mind is empty. */
export function knowsAbout(agentId: string): string {
  if (agentId === LEAD_ID) return "";
  const g = agentMind(agentId);
  const n = g.active().length;
  if (!n) return "";
  const top = clusters(g, 4).filter((c) => c.count > 1 || n < 5).map((c) => c.name);
  return `${n} memor${n === 1 ? "y" : "ies"}${top.length ? ` (${top.join(", ")})` : ""}`;
}

/** What an agent is reminded of for `query`: the memories that bear on it, best first. Reading them counts as using them. */
export function mindBriefing(agentId: string, query = "", max = 6): string {
  const g = agentMind(agentId);
  const hits = query.trim() ? g.recall(query, max, true).map((h) => h.record) : [...g.active()].sort((a, b) => b.uses - a.uses || b.updated - a.updated).slice(0, max);
  if (!hits.length) return "";
  g.touch(hits.map((r) => r.id));
  return "What you have learned and kept (your own mind):\n" + hits.map((r) => `- ${r.body || r.title}${r.source ? ` (from ${r.source})` : ""}`).join("\n");
}

/** Test hook. */
export function resetMinds(): void { graphs.clear(); }
