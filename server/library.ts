/**
 * The library: what the person has given the agent to know, searchable, with
 * where each answer came from.
 *
 * Memory is what the agent learned. The library is what the person owns:
 * contracts, manuals, notes, exported chats, web pages. Files and pages are
 * added once (from the terminal's folder, an artifact, or a web address); they
 * are read into plain text, cut into passages that keep their place (a PDF
 * page, a range of lines), and ranked with BM25 at search time, so a question
 * returns the few passages most about it, each as a citation the agent can
 * quote: "lease.pdf, p.7". Plain code does the searching -- no embeddings, no
 * model, nothing sent anywhere -- so it works offline and an answer is never a
 * guess about what a passage says.
 *
 * Stored under the state directory (library/): one index, one file of passages
 * per source. A source is identified by its content, so adding the same file
 * twice is a no-op, and a changed file is added again as a new version.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getArtifact, readArtifact, listArtifacts } from "./artifacts";
import { words } from "./codesearch";
import { htmlToText } from "./pages";
import { stateDir } from "./state";

export interface Passage {
  /** Where in the source: "p.3" or "lines 40-79". */
  loc: string;
  text: string;
}

export interface Source {
  id: string;
  name: string;
  kind: "pdf" | "text" | "web";
  /** Where it came from: a path, an artifact id, or an address. */
  origin: string;
  addedAt: number;
  chars: number;
  passages: number;
  tags: string[];
}

const TEXT_EXT = new Set([
  ".txt", ".md", ".markdown", ".rst", ".csv", ".tsv", ".json", ".yaml", ".yml", ".toml", ".xml", ".log", ".ini",
  ".html", ".htm", ".tex", ".org", ".js", ".ts", ".tsx", ".jsx", ".py", ".rb", ".go", ".rs", ".java", ".c", ".h",
  ".cpp", ".sh", ".sql", ".css", ".eml",
]);
const MAX_FILE_BYTES = 30 * 1024 * 1024;
const MAX_TEXT_CHARS = 4_000_000;
const MAX_FOLDER_FILES = 200;
const PASSAGE_CHARS = 900;

const dir = () => path.join(stateDir(), "library");
const indexFile = () => path.join(dir(), "index.json");
const passageFile = (id: string) => path.join(dir(), `${id}.json`);

let cache: { index: Source[]; passages: Map<string, Passage[]>; built: Map<string, Bm25> } | null = null;

function loadIndex(): Source[] {
  if (cache) return cache.index;
  let index: Source[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(indexFile(), "utf8"));
    if (Array.isArray(raw)) index = raw.filter((s) => s && typeof s.id === "string");
  } catch {
    // none yet
  }
  cache = { index, passages: new Map(), built: new Map() };
  return index;
}

function saveIndex() {
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(indexFile(), JSON.stringify(loadIndex()), { mode: 0o600 });
}

function passagesOf(id: string): Passage[] {
  loadIndex();
  const have = cache!.passages.get(id);
  if (have) return have;
  let list: Passage[] = [];
  try {
    list = JSON.parse(fs.readFileSync(passageFile(id), "utf8"));
  } catch {
    // lost: the source reads as empty
  }
  cache!.passages.set(id, list);
  return list;
}

/** Forget what is held in memory, so the next call reads the disk (tests). */
export function resetLibraryCache() {
  cache = null;
}

// ---------------------------------------------------------------- reading --

/** Cut text into passages at paragraph breaks, each with the lines it covers. */
export function passagesFromText(text: string): Passage[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: Passage[] = [];
  let buf: string[] = [];
  let start = 1;
  let size = 0;
  const flush = (endLine: number) => {
    const body = buf.join("\n").trim();
    if (body) out.push({ loc: start === endLine ? `line ${start}` : `lines ${start}-${endLine}`, text: body });
    buf = [];
    size = 0;
  };
  lines.forEach((line, i) => {
    const n = i + 1;
    if (buf.length === 0) start = n;
    buf.push(line);
    size += line.length + 1;
    // End at a blank line once big enough, or at the hard ceiling.
    if ((size >= PASSAGE_CHARS * 0.4 && line.trim() === "") || size >= PASSAGE_CHARS) flush(n);
  });
  flush(lines.length);
  return out;
}

/** A PDF page's text, cut into passages that all say which page they are on. */
export function passagesFromPage(page: number, text: string): Passage[] {
  const body = text.trim();
  if (!body) return [];
  if (body.length <= PASSAGE_CHARS * 1.4) return [{ loc: `p.${page}`, text: body }];
  const out: Passage[] = [];
  const parts = body.split(/\n{2,}|(?<=[.!?])\s{2,}/);
  let cur = "";
  for (const p of parts) {
    if (cur && cur.length + p.length > PASSAGE_CHARS) { out.push({ loc: `p.${page}`, text: cur.trim() }); cur = ""; }
    cur += (cur ? "\n" : "") + p;
  }
  if (cur.trim()) out.push({ loc: `p.${page}`, text: cur.trim() });
  return out;
}

async function pdfPassages(data: Buffer): Promise<Passage[]> {
  const { withPdf } = await import("./pdfrender");
  return withPdf(data, undefined, async (view) => {
    const out: Passage[] = [];
    for (let n = 1; n <= view.pages; n++) {
      const [page] = await view.text(n, n);
      let text = "";
      for (const item of page?.items ?? []) text += item.s + (item.eol ? "\n" : "");
      out.push(...passagesFromPage(n, text));
    }
    return out;
  });
}

interface Read {
  name: string;
  kind: Source["kind"];
  passages: Passage[];
  chars: number;
}

async function readBytes(name: string, data: Buffer): Promise<Read> {
  const ext = path.extname(name).toLowerCase();
  if (data.subarray(0, 1024).includes("%PDF-")) {
    const passages = await pdfPassages(data);
    return { name, kind: "pdf", passages, chars: passages.reduce((n, p) => n + p.text.length, 0) };
  }
  if (!TEXT_EXT.has(ext) && data.subarray(0, 8000).includes(0)) {
    throw new Error(`${name} is not a kind of file the library can read (PDF, web pages and plain text are).`);
  }
  let text = data.toString("utf8");
  if (ext === ".html" || ext === ".htm") text = htmlToText(text);
  text = text.slice(0, MAX_TEXT_CHARS);
  const passages = passagesFromText(text);
  return { name, kind: "text", passages, chars: text.length };
}

// ---------------------------------------------------------------- ranking --

interface Bm25 {
  docs: { source: string; i: number; tf: Map<string, number>; len: number }[];
  df: Map<string, number>;
  avg: number;
}

function stem(w: string): string {
  return w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w;
}

function terms(text: string): string[] {
  return words(text).map(stem);
}

function buildAll(): Bm25 {
  const docs: Bm25["docs"] = [];
  const df = new Map<string, number>();
  for (const s of loadIndex()) {
    passagesOf(s.id).forEach((p, i) => {
      const tf = new Map<string, number>();
      let len = 0;
      for (const t of terms(p.text)) { tf.set(t, (tf.get(t) ?? 0) + 1); len++; }
      for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
      docs.push({ source: s.id, i, tf, len });
    });
  }
  const avg = docs.length ? docs.reduce((n, d) => n + d.len, 0) / docs.length : 1;
  return { docs, df, avg };
}

let ranker: Bm25 | null = null;
let rankerStamp = "";

function ranked(): Bm25 {
  const stamp = loadIndex().map((s) => s.id).join(",");
  if (!ranker || rankerStamp !== stamp) {
    ranker = buildAll();
    rankerStamp = stamp;
  }
  return ranker;
}

export interface Hit {
  source: Source;
  loc: string;
  score: number;
  text: string;
}

/** The passages most about `query`, best first. */
export function searchLibrary(query: string, opts: { max?: number; source?: string; tag?: string } = {}): Hit[] {
  const q = terms(query);
  if (!q.length) return [];
  const idx = ranked();
  const N = idx.docs.length;
  const sources = new Map(loadIndex().map((s) => [s.id, s]));
  const phrase = query.trim().toLowerCase();
  const scored: Hit[] = [];
  for (const d of idx.docs) {
    const src = sources.get(d.source);
    if (!src) continue;
    if (opts.source && src.id !== opts.source && src.name.toLowerCase() !== opts.source.toLowerCase()) continue;
    if (opts.tag && !src.tags.includes(opts.tag)) continue;
    let score = 0;
    let matched = 0;
    for (const t of new Set(q)) {
      const f = d.tf.get(t);
      if (!f) continue;
      matched++;
      const n = idx.df.get(t) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * ((f * 2.4) / (f + 1.4 * (0.25 + 0.75 * (d.len / idx.avg))));
    }
    if (!score) continue;
    const p = passagesOf(d.source)[d.i];
    if (!p) continue;
    // Passages holding more of the question's words, and the phrase itself, come first.
    score *= 1 + matched / new Set(q).size;
    if (phrase.length > 5 && p.text.toLowerCase().includes(phrase)) score *= 1.8;
    scored.push({ source: src, loc: p.loc, score, text: p.text });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.min(20, Math.max(1, opts.max ?? 6)));
}

/** The part of a passage around where the question's words are densest. */
export function snippet(text: string, query: string, size = 420): string {
  if (text.length <= size) return text;
  const q = new Set(terms(query));
  const lower = text.toLowerCase();
  let best = 0, bestScore = -1;
  for (let at = 0; at < text.length; at += Math.floor(size / 3)) {
    const win = lower.slice(at, at + size);
    let s = 0;
    for (const t of q) if (win.includes(t)) s++;
    if (s > bestScore) { bestScore = s; best = at; }
  }
  const cut = text.slice(best, best + size).trim();
  return `${best > 0 ? "… " : ""}${cut}${best + size < text.length ? " …" : ""}`;
}

// ----------------------------------------------------------------- adding --

function fingerprint(name: string, data: Buffer): string {
  return crypto.createHash("sha1").update(name).update("\0").update(data).digest("hex").slice(0, 16);
}

async function addRead(read: Read, origin: string, tags: string[], data: Buffer): Promise<{ source: Source; fresh: boolean }> {
  const id = `lib_${fingerprint(read.name, data)}`;
  const had = loadIndex().find((s) => s.id === id);
  if (had) return { source: had, fresh: false };
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(passageFile(id), JSON.stringify(read.passages), { mode: 0o600 });
  const source: Source = { id, name: read.name, kind: read.kind, origin, addedAt: Date.now(), chars: read.chars, passages: read.passages.length, tags };
  loadIndex().push(source);
  cache!.passages.set(id, read.passages);
  saveIndex();
  return { source, fresh: true };
}

export interface LibraryCall {
  cwd: string;
  args: Record<string, any>;
  /** Folders that are Autora's own data: never added. */
  protect?: string[];
  fetchPage?: (url: string) => Promise<{ name: string; data: Buffer }>;
}

export interface LibraryResult {
  ok: boolean;
  summary: string;
  preview?: string;
}

const isProtected = (full: string, protect: string[]) =>
  protect.some((p) => p && (full === p || full.startsWith(p.endsWith(path.sep) ? p : p + path.sep)));

function walk(root: string, protect: string[], out: string[], glob: RegExp | null) {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const e of entries) {
    if (out.length >= MAX_FOLDER_FILES) return;
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const full = path.join(root, e.name);
    if (isProtected(full, protect)) continue;
    if (e.isDirectory()) walk(full, protect, out, glob);
    else if (e.isFile() && (/\.pdf$/i.test(e.name) || TEXT_EXT.has(path.extname(e.name).toLowerCase())) && (!glob || glob.test(e.name))) out.push(full);
  }
}

async function add(call: LibraryCall): Promise<LibraryResult> {
  const a = call.args;
  const tags = (Array.isArray(a.tags) ? a.tags : a.tags ? [a.tags] : []).map((t: unknown) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 8);
  const added: string[] = [];
  const already: string[] = [];
  const failed: string[] = [];
  const take = async (name: string, data: Buffer, origin: string) => {
    try {
      const read = await readBytes(name, data);
      if (!read.passages.length) { failed.push(`${name}: no text in it (a scan? try media's ocr first)`); return; }
      const { source, fresh } = await addRead(read, origin, tags, data);
      (fresh ? added : already).push(`${source.name} (${source.passages} passages, ${source.id})`);
    } catch (err: any) {
      failed.push(`${name}: ${String(err?.message ?? err).split("\n")[0]}`);
    }
  };

  const artifact = String(a.artifact ?? "").trim();
  const target = String(a.path ?? "").trim();
  const url = String(a.url ?? "").trim();
  if (!artifact && !target && !url) return { ok: false, summary: "add needs one of: artifact (an id), path (a file or folder) or url." };

  if (artifact) {
    const art = getArtifact(artifact) ?? listArtifacts().find((x) => x.name.toLowerCase() === artifact.toLowerCase()) ?? null;
    const data = art ? readArtifact(art.id) : null;
    if (!art || !data) return { ok: false, summary: `There is no artifact "${artifact}".` };
    await take(art.name, data, art.id);
  }
  if (target) {
    const full = path.resolve(call.cwd, target);
    if (isProtected(full, call.protect ?? [])) return { ok: false, summary: `${full} is Autora's own data, not something to add.` };
    let stat: fs.Stats;
    try { stat = fs.statSync(full); } catch { return { ok: false, summary: `${full} is not there.` }; }
    const files: string[] = [];
    if (stat.isDirectory()) {
      let glob: RegExp | null = null;
      if (typeof a.glob === "string" && a.glob.trim()) {
        const { globToRegExp } = await import("./codesearch");
        glob = globToRegExp(a.glob);
      }
      walk(full, call.protect ?? [], files, glob);
      if (!files.length) return { ok: false, summary: `${full} holds no PDFs or text files to add.` };
    } else files.push(full);
    for (const f of files) {
      let size = 0;
      try { size = fs.statSync(f).size; } catch { continue; }
      if (size > MAX_FILE_BYTES) { failed.push(`${path.basename(f)}: over ${MAX_FILE_BYTES / 1048576} MB`); continue; }
      await take(path.basename(f), fs.readFileSync(f), f);
    }
  }
  if (url) {
    if (!/^https?:\/\//i.test(url)) return { ok: false, summary: "url must start with http:// or https://." };
    if (!call.fetchPage) return { ok: false, summary: "Fetching a web page is not available here." };
    try {
      const page = await call.fetchPage(url);
      await take(page.name, page.data, url);
    } catch (err: any) {
      failed.push(`${url}: ${String(err?.message ?? err).split("\n")[0]}`);
    }
  }
  const lines: string[] = [];
  if (added.length) lines.push(`Added ${added.length}: ${added.slice(0, 12).join("; ")}${added.length > 12 ? "; ..." : ""}.`);
  if (already.length) lines.push(`Already in the library: ${already.slice(0, 6).join("; ")}.`);
  if (failed.length) lines.push(`Not added: ${failed.slice(0, 8).join("; ")}.`);
  if (!added.length && !already.length) return { ok: false, summary: lines.join("\n") || "Nothing was added." };
  return { ok: true, summary: lines.join("\n"), preview: `${added.length} added` };
}

// --------------------------------------------------------------- the tool --

import { LIBRARY_READ } from "./readonly";
export { LIBRARY_READ };

/** Whether this call only looks. */
export function libraryReadOnly(args: Record<string, any>): boolean {
  return LIBRARY_READ.has(String(args.action ?? "").trim().toLowerCase());
}

function findSource(ref: string): Source | null {
  const r = ref.trim().toLowerCase();
  if (!r) return null;
  const all = loadIndex();
  return all.find((s) => s.id.toLowerCase() === r) ?? all.find((s) => s.name.toLowerCase() === r) ?? all.find((s) => s.name.toLowerCase().includes(r)) ?? null;
}

export async function runLibrary(call: LibraryCall): Promise<LibraryResult> {
  const a = call.args;
  const action = String(a.action ?? "").trim().toLowerCase();
  switch (action) {
    case "add":
      return add(call);

    case "list": {
      const all = loadIndex();
      if (!all.length) return { ok: true, summary: "The library is empty. Add PDFs, text files, folders or web pages with action add.", preview: "empty" };
      const tag = typeof a.tag === "string" ? a.tag.trim().toLowerCase() : "";
      const rows = all.filter((s) => !tag || s.tags.includes(tag));
      return {
        ok: true,
        summary: `${rows.length} source${rows.length === 1 ? "" : "s"}:\n` + rows.map((s) =>
          `${s.id}  ${s.name}  [${s.kind}, ${s.passages} passages${s.tags.length ? `, tags: ${s.tags.join(", ")}` : ""}]`).join("\n"),
        preview: `${rows.length} sources`,
      };
    }

    case "search": {
      const query = String(a.query ?? "").trim();
      if (!query) return { ok: false, summary: "search needs a query." };
      if (!loadIndex().length) return { ok: true, summary: "The library is empty, so there is nothing to search. Add sources first.", preview: "empty" };
      const only = typeof a.source === "string" && a.source.trim() ? findSource(a.source) : null;
      if (typeof a.source === "string" && a.source.trim() && !only) return { ok: false, summary: `There is no source "${a.source}" in the library (list shows them).` };
      const hits = searchLibrary(query, { max: Number(a.max) || 6, source: only?.id, tag: typeof a.tag === "string" ? a.tag.trim().toLowerCase() : undefined });
      if (!hits.length) return { ok: true, summary: `Nothing in the library matches "${query}". Try other words, or list what is there.`, preview: "no matches" };
      return {
        ok: true,
        summary: hits.map((h, i) => `${i + 1}. [${h.source.name}, ${h.loc}]  (${h.source.id})\n${snippet(h.text, query)}`).join("\n\n") +
          "\n\nCite a passage as its bracket, e.g. [name, p.3]. read with source and loc gives the whole passage.",
        preview: `${hits.length} passages`,
      };
    }

    case "read": {
      const src = findSource(String(a.source ?? ""));
      if (!src) return { ok: false, summary: `There is no source "${a.source ?? ""}" in the library (list shows them).` };
      const all = passagesOf(src.id);
      const loc = String(a.loc ?? "").trim().toLowerCase();
      let picked = loc ? all.filter((p) => p.loc.toLowerCase() === loc || p.loc.toLowerCase().startsWith(`${loc} `) || p.loc.toLowerCase().includes(loc)) : all.slice(0, 3);
      if (!picked.length) return { ok: false, summary: `${src.name} has no passage at "${a.loc}". Its passages run from ${all[0]?.loc} to ${all[all.length - 1]?.loc}.` };
      picked = picked.slice(0, 8);
      return { ok: true, summary: `[${src.name}]\n` + picked.map((p) => `--- ${p.loc} ---\n${p.text}`).join("\n\n"), preview: `${src.name} ${picked[0].loc}` };
    }

    case "remove": {
      const src = findSource(String(a.source ?? ""));
      if (!src) return { ok: false, summary: `There is no source "${a.source ?? ""}" in the library.` };
      const all = loadIndex();
      all.splice(all.indexOf(src), 1);
      cache!.passages.delete(src.id);
      try { fs.rmSync(passageFile(src.id), { force: true }); } catch { /* gone */ }
      saveIndex();
      return { ok: true, summary: `Removed ${src.name} from the library. The original file is untouched.`, preview: "removed" };
    }

    default:
      return { ok: false, summary: "action is add, search, read, list or remove." };
  }
}
