/**
 * An agent's own mind: the short notes it keeps for itself -- what it learned,
 * what works, what it knows about the others and the person -- carried into
 * every task it is started on and every look it takes at Threads.
 *
 * Small on purpose. A note is a sentence; an agent holds at most MAX_NOTES, and
 * when it is full the least-used, oldest one makes room, so what an agent
 * remembers is what it kept needing. This is not the main Mind (the person's
 * memory graph, memory.ts): that one is shared and about the person. This one
 * is each agent's, about its craft and its colleagues. Stored as `agentminds.json`.
 */

import crypto from "node:crypto";
import { readDoc, saveDoc } from "./store";

export type NoteKind = "fact" | "lesson" | "tip" | "colleague";

export interface Note {
  id: string;
  text: string;
  kind: NoteKind;
  /** Where it came from: another agent's name, a thread, or empty for its own. */
  from: string;
  at: number;
  /** How many times it has been read back into a prompt. */
  used: number;
}

const MAX_NOTES = 40;
const MAX_TEXT = 300;
const DOC = "agentminds";
let minds: Record<string, Note[]> | null = null;

const clip = (v: unknown, n: number) => String(v ?? "").replace(/\u0000/g, "").replace(/\s+/g, " ").trim().slice(0, n);
const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function load(): Record<string, Note[]> {
  if (minds) return minds;
  const raw = readDoc<Record<string, Note[]>>(DOC);
  minds = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return minds;
}

const persist = () => saveDoc(DOC, () => load());

export const notesOf = (agentId: string): Note[] => load()[agentId] ?? [];

/** Keeps a note, unless it says what one already does. Returns it, or null when there was nothing to keep. */
export function remember(agentId: string, text: unknown, kind: NoteKind = "lesson", from = ""): Note | null {
  const t = clip(text, MAX_TEXT);
  if (t.length < 8) return null;
  const list = (load()[agentId] ??= []);
  const same = list.find((n) => norm(n.text) === norm(t));
  if (same) return same;
  const note: Note = {
    id: `nt_${crypto.randomBytes(4).toString("hex")}`, text: t,
    kind: ["fact", "lesson", "tip", "colleague"].includes(kind) ? kind : "lesson", from: clip(from, 60), at: Date.now(), used: 0,
  };
  list.push(note);
  if (list.length > MAX_NOTES) {
    const drop = [...list].sort((a, b) => a.used - b.used || a.at - b.at)[0];
    list.splice(list.indexOf(drop), 1);
  }
  persist();
  return note;
}

/** An agent forgets a note, or a merged-away agent's whole mind goes to the one that took over. */
export function forgetNote(agentId: string, noteId: string): boolean {
  const list = load()[agentId] ?? [];
  const at = list.findIndex((n) => n.id === noteId);
  if (at < 0) return false;
  list.splice(at, 1);
  persist();
  return true;
}

export function dropMind(agentId: string): void {
  if (load()[agentId]) { delete load()[agentId]; persist(); }
}

export function mergeMind(fromId: string, intoId: string): void {
  for (const n of notesOf(fromId)) remember(intoId, n.text, n.kind, n.from);
  dropMind(fromId);
}

/** What an agent is reminded of: its newest and most-used notes, a dozen at most. Reading them counts as using them. */
export function mindBriefing(agentId: string, max = 12): string {
  const list = notesOf(agentId);
  if (!list.length) return "";
  const picked = [...list].sort((a, b) => b.used + b.at / 1e13 - (a.used + a.at / 1e13)).slice(0, max);
  for (const n of picked) n.used += 1;
  persist();
  return "What you have learned and kept (your own notes):\n" +
    picked.map((n) => `- ${n.text}${n.from ? ` (from ${n.from})` : ""}`).join("\n");
}

/** Test hook. */
export function resetMinds(): void { minds = null; }
