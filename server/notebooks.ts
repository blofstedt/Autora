/**
 * Notebooks: artifacts grouped by purpose, with writing between them.
 *
 * A notebook is an ordered list of entries. An entry is either an artifact
 * (an email, a screenshot, a contract) with an optional annotation, or a note
 * in Markdown (a finding, a rebuttal, a summary) that can cite the artifacts
 * it rests on. The person makes them on the Notebooks page; the agent makes
 * and fills them with the notebook tool, so a report built from many sources
 * is one place with every source beside the claim it supports.
 *
 * Entries point at artifacts rather than copying them: an artifact in a
 * notebook is kept by retention, and one deleted by hand leaves the notebooks
 * it was in.
 */

import crypto from "node:crypto";
import { getArtifact, listArtifacts, type Artifact } from "./artifacts";
import { readDoc, saveDoc } from "./store";

export type NotebookAuthor = "agent" | "user";

export interface NotebookEntry {
  id: string;
  kind: "artifact" | "note";
  /** The artifact this entry is, for kind "artifact". */
  artifact?: string;
  /** A heading for a note, or a caption for an artifact. */
  title?: string;
  /** A note's body, or what an artifact shows, in Markdown. */
  text?: string;
  /** Artifacts a note's claims rest on. */
  cites?: string[];
  by: NotebookAuthor;
  added: number;
  updated?: number;
}

export interface Notebook {
  id: string;
  title: string;
  /** What the notebook is for, in a line or two. */
  purpose: string;
  by: NotebookAuthor;
  created: number;
  updated: number;
  entries: NotebookEntry[];
}

const MAX_NOTEBOOKS = 300;
const MAX_ENTRIES = 1000;
const MAX_TITLE = 200;
const MAX_PURPOSE = 2000;
const MAX_TEXT = 40_000;
const MAX_CITES = 50;

const DOC = "notebooks";
let books: Notebook[] | null = null;

const notebookId = () => `nb_${crypto.randomBytes(6).toString("hex")}`;
const entryId = () => `en_${crypto.randomBytes(5).toString("hex")}`;
const clip = (v: unknown, max: number) => String(v ?? "").replace(/\u0000/g, "").trim().slice(0, max);

function load(): Notebook[] {
  if (books) return books;
  const raw = readDoc<unknown>(DOC);
  books = Array.isArray(raw)
    ? raw.filter((b): b is Notebook =>
      !!b && typeof b === "object" && typeof (b as Notebook).id === "string" && Array.isArray((b as Notebook).entries))
    : [];
  return books;
}

function persist(book?: Notebook) {
  if (book) book.updated = Date.now();
  saveDoc(DOC, () => load());
}

export class NotebookError extends Error {}

export function listNotebooks(): Notebook[] {
  return [...load()].sort((a, b) => b.updated - a.updated);
}

export function getNotebook(id: string): Notebook | null {
  return load().find((b) => b.id === id) ?? null;
}

/** A notebook by id or, failing that, by its title (any case). */
export function findNotebook(ref: unknown): Notebook | null {
  const want = String(ref ?? "").trim();
  if (!want) return null;
  return getNotebook(want) ??
    load().find((b) => b.title.toLowerCase() === want.toLowerCase()) ?? null;
}

export function createNotebook(input: { title: unknown; purpose?: unknown; by: NotebookAuthor }): Notebook {
  const title = clip(input.title, MAX_TITLE);
  if (!title) throw new NotebookError("A notebook needs a title.");
  if (load().length >= MAX_NOTEBOOKS) {
    throw new NotebookError(`There are already ${MAX_NOTEBOOKS} notebooks; delete one first.`);
  }
  const now = Date.now();
  const book: Notebook = {
    id: notebookId(), title, purpose: clip(input.purpose, MAX_PURPOSE),
    by: input.by, created: now, updated: now, entries: [],
  };
  load().push(book);
  persist();
  return book;
}

export function updateNotebook(id: string, patch: { title?: unknown; purpose?: unknown }): Notebook {
  const book = must(id);
  if (patch.title !== undefined) {
    const title = clip(patch.title, MAX_TITLE);
    if (!title) throw new NotebookError("A notebook needs a title.");
    book.title = title;
  }
  if (patch.purpose !== undefined) book.purpose = clip(patch.purpose, MAX_PURPOSE);
  persist(book);
  return book;
}

/** The notebook goes; the artifacts in it stay on the Artifacts page. */
export function deleteNotebook(id: string): boolean {
  const list = load();
  const at = list.findIndex((b) => b.id === id);
  if (at < 0) return false;
  list.splice(at, 1);
  persist();
  return true;
}

function must(id: string): Notebook {
  const book = getNotebook(id);
  if (!book) throw new NotebookError(`There is no notebook "${id}".`);
  return book;
}

/** An artifact by id, or by its exact file name (any case). */
function artifactFor(ref: unknown): Artifact | null {
  const want = String(ref ?? "").trim();
  if (!want) return null;
  return getArtifact(want) ??
    listArtifacts().find((a) => a.name.toLowerCase() === want.toLowerCase()) ?? null;
}

function readCites(raw: unknown): { ids: string[]; unknown: string[] } {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" && raw.trim() ? raw.split(",") : [];
  const ids: string[] = [];
  const missing: string[] = [];
  for (const ref of list.slice(0, MAX_CITES)) {
    const art = artifactFor(ref);
    if (art) { if (!ids.includes(art.id)) ids.push(art.id); } else missing.push(String(ref).trim());
  }
  return { ids, unknown: missing };
}

interface EntryInput {
  artifact?: unknown;
  title?: unknown;
  text?: unknown;
  cites?: unknown;
}

/**
 * Add entries at `position` (1-based; default the end). An artifact already
 * in the notebook is not added twice: a new annotation replaces its old one.
 */
export function addEntries(
  id: string, inputs: EntryInput[], by: NotebookAuthor, position?: number,
): { notebook: Notebook; added: NotebookEntry[]; updated: NotebookEntry[]; unknown: string[] } {
  const book = must(id);
  const added: NotebookEntry[] = [];
  const updated: NotebookEntry[] = [];
  const unknown: string[] = [];
  const now = Date.now();
  for (const input of inputs) {
    const title = clip(input.title, MAX_TITLE);
    const text = clip(input.text, MAX_TEXT);
    const cites = readCites(input.cites);
    unknown.push(...cites.unknown);
    if (input.artifact !== undefined && input.artifact !== null && input.artifact !== "") {
      const art = artifactFor(input.artifact);
      if (!art) { unknown.push(String(input.artifact).trim()); continue; }
      const had = book.entries.find((e) => e.kind === "artifact" && e.artifact === art.id);
      if (had) {
        if (title) had.title = title;
        if (text) had.text = text;
        if (cites.ids.length) had.cites = cites.ids;
        had.updated = now;
        updated.push(had);
        continue;
      }
      added.push({
        id: entryId(), kind: "artifact", artifact: art.id,
        ...(title ? { title } : {}), ...(text ? { text } : {}),
        ...(cites.ids.length ? { cites: cites.ids } : {}), by, added: now,
      });
      continue;
    }
    if (!title && !text) continue;
    added.push({
      id: entryId(), kind: "note",
      ...(title ? { title } : {}), ...(text ? { text } : {}),
      ...(cites.ids.length ? { cites: cites.ids } : {}), by, added: now,
    });
  }
  if (book.entries.length + added.length > MAX_ENTRIES) {
    throw new NotebookError(`A notebook holds at most ${MAX_ENTRIES} entries.`);
  }
  const at = position && Number.isFinite(position)
    ? Math.min(Math.max(0, Math.floor(position) - 1), book.entries.length)
    : book.entries.length;
  book.entries.splice(at, 0, ...added);
  if (added.length || updated.length) persist(book);
  return { notebook: book, added, updated, unknown };
}

export function updateEntry(
  id: string, entry: string, patch: { title?: unknown; text?: unknown; cites?: unknown },
): { entry: NotebookEntry; unknown: string[] } {
  const book = must(id);
  const found = book.entries.find((e) => e.id === entry);
  if (!found) throw new NotebookError(`There is no entry "${entry}" in "${book.title}".`);
  const title = patch.title !== undefined ? clip(patch.title, MAX_TITLE) : found.title ?? "";
  const text = patch.text !== undefined ? clip(patch.text, MAX_TEXT) : found.text ?? "";
  if (found.kind === "note" && !title && !text) {
    throw new NotebookError("A note needs a title or some text; remove it instead.");
  }
  let unknown: string[] = [];
  if (title) found.title = title; else delete found.title;
  if (text) found.text = text; else delete found.text;
  if (patch.cites !== undefined) {
    const cites = readCites(patch.cites);
    unknown = cites.unknown;
    if (cites.ids.length) found.cites = cites.ids; else delete found.cites;
  }
  found.updated = Date.now();
  persist(book);
  return { entry: found, unknown };
}

export function removeEntry(id: string, entry: string): boolean {
  const book = must(id);
  const at = book.entries.findIndex((e) => e.id === entry);
  if (at < 0) return false;
  book.entries.splice(at, 1);
  persist(book);
  return true;
}

/** Move an entry to `position` (1-based). */
export function moveEntry(id: string, entry: string, position: number): Notebook {
  const book = must(id);
  const at = book.entries.findIndex((e) => e.id === entry);
  if (at < 0) throw new NotebookError(`There is no entry "${entry}" in "${book.title}".`);
  const to = Math.min(Math.max(0, Math.floor(Number(position) || 1) - 1), book.entries.length - 1);
  const [moved] = book.entries.splice(at, 1);
  book.entries.splice(to, 0, moved);
  persist(book);
  return book;
}

/** Every artifact some notebook holds or cites, which retention keeps. */
export function notebookArtifacts(): Set<string> {
  const keep = new Set<string>();
  for (const book of load()) {
    for (const e of book.entries) {
      if (e.artifact) keep.add(e.artifact);
      for (const c of e.cites ?? []) keep.add(c);
    }
  }
  return keep;
}

/** An artifact was deleted: it leaves every notebook and citation. */
export function forgetArtifact(artifact: string) {
  for (const book of load()) {
    const before = JSON.stringify(book.entries);
    book.entries = book.entries.filter((e) => e.artifact !== artifact);
    for (const e of book.entries) {
      if (!e.cites) continue;
      e.cites = e.cites.filter((c) => c !== artifact);
      if (!e.cites.length) delete e.cites;
    }
    if (JSON.stringify(book.entries) !== before) persist(book);
  }
}

const sizeOf = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function artifactLabel(id: string): string {
  const art = getArtifact(id);
  return art ? `${art.name} (${id}, ${art.mime}, ${sizeOf(art.size)})` : `${id} (deleted)`;
}

/** One line per notebook, for the agent's list. */
export function notebookLine(book: Notebook): string {
  const files = book.entries.filter((e) => e.kind === "artifact").length;
  const notes = book.entries.length - files;
  return `${book.id} · "${book.title}" · ${files} file${files === 1 ? "" : "s"}, ${notes} note${notes === 1 ? "" : "s"}` +
    (book.purpose ? ` · ${book.purpose.split("\n")[0].slice(0, 160)}` : "");
}

/**
 * The notebook as the agent reads it: every entry in order, with its id, so
 * it can be checked for gaps and edited. `brief` leaves note bodies at their
 * first line, for a chat that only needs to know what is in it.
 */
export function describeNotebook(book: Notebook, brief = false): string {
  const out = [
    `Notebook ${book.id}: "${book.title}"`,
    book.purpose ? `Purpose: ${book.purpose}` : "Purpose: (none given)",
    `${book.entries.length} entr${book.entries.length === 1 ? "y" : "ies"}, last changed ${new Date(book.updated).toISOString()}.`,
  ];
  book.entries.forEach((e, i) => {
    const head = e.kind === "artifact"
      ? `${i + 1}. [${e.id}] file: ${artifactLabel(e.artifact!)}${e.title ? ` -- ${e.title}` : ""}`
      : `${i + 1}. [${e.id}] note${e.title ? `: ${e.title}` : ""}`;
    out.push("", head);
    if (e.text) out.push(brief ? `   ${e.text.split("\n")[0].slice(0, 200)}${e.text.includes("\n") || e.text.length > 200 ? " ..." : ""}` : e.text);
    if (e.cites?.length) out.push(`   Cites: ${e.cites.map(artifactLabel).join("; ")}`);
  });
  if (!book.entries.length) out.push("", "(empty)");
  return out.join("\n");
}

/**
 * The notebook as one Markdown document: notes in order, each file as a
 * numbered exhibit, and an index of exhibits at the end.
 */
export function notebookMarkdown(book: Notebook): string {
  const exhibits = new Map<string, number>();
  const exhibit = (id: string) => {
    if (!exhibits.has(id)) exhibits.set(id, exhibits.size + 1);
    return exhibits.get(id)!;
  };
  for (const e of book.entries) if (e.artifact) exhibit(e.artifact);
  const name = (id: string) => getArtifact(id)?.name ?? `${id} (deleted)`;
  const cite = (ids: string[]) => ids.map((id) => `Exhibit ${exhibit(id)} (${name(id)})`).join(", ");

  const out = [`# ${book.title}`, ""];
  if (book.purpose) out.push(`> ${book.purpose.replace(/\n/g, "\n> ")}`, "");
  for (const e of book.entries) {
    if (e.kind === "artifact") {
      out.push(`### Exhibit ${exhibit(e.artifact!)}: ${e.title || name(e.artifact!)}`, "");
      if (e.title) out.push(`*File: ${name(e.artifact!)}*`, "");
    } else if (e.title) {
      out.push(`## ${e.title}`, "");
    }
    if (e.text) out.push(e.text, "");
    if (e.cites?.length) out.push(`*Supporting: ${cite(e.cites)}*`, "");
  }
  if (exhibits.size) {
    out.push("---", "", "## Exhibits", "");
    for (const [id, n] of exhibits) {
      const art = getArtifact(id);
      out.push(`${n}. ${art ? `${art.name} -- ${art.mime}, ${sizeOf(art.size)}` : `${id} (deleted)`}`);
    }
    out.push("");
  }
  return out.join("\n");
}
