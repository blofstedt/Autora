/**
 * Finding things in a folder of code without asking a model to.
 *
 * Reading a repository by running `grep` and `cat` until something looks
 * right costs a round trip and a screenful of output each time, and the model
 * is doing the work of a search index. This narrows first, in plain code: an
 * exact or regular-expression scan, or a ranked search (BM25 over short
 * windows of each file, with identifiers split into their words so `fetchUser`
 * is found by "fetch user" and `fetch_user_by_id` by "user id"). What comes
 * back is a few places, each with its best lines, for the model to read.
 *
 * Nothing here calls a model, the network or a shell, and nothing is written.
 */

import fs from "node:fs";
import path from "node:path";

const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", ".next", ".nuxt", "target", "venv", ".venv", "__pycache__",
  ".cache", ".turbo", "coverage", ".idea", ".gradle", "vendor", ".svn", ".hg",
]);
const MAX_FILES = 20_000;
const MAX_BYTES = 512 * 1024;
const WINDOW = 30;

export interface SearchOptions {
  /** Where to look. */
  root: string;
  query: string;
  mode?: "ranked" | "exact" | "regex";
  /** Only files whose path (from the root) matches: `*.ts`, `src/**\/*.tsx`. */
  glob?: string;
  caseSensitive?: boolean;
  /** How many places to return. */
  max?: number;
}

export interface SearchResult {
  ok: boolean;
  text: string;
  /** Files looked through. */
  files: number;
}

interface Chunk {
  file: string;
  start: number;
  lines: string[];
  tokens: Map<string, number>;
  length: number;
}

interface Indexed {
  mtime: number;
  size: number;
  lines: string[];
  chunks: Chunk[];
}

interface Walk {
  files: string[];
  truncated: boolean;
}

const indexed = new Map<string, Indexed>();

/** Split an identifier or a word into the words in it, lowercased. */
export function words(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.match(/[A-Za-z0-9_]+/g) ?? []) {
    const lower = raw.toLowerCase();
    if (lower.length > 1) out.push(lower);
    const parts = raw
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .split(/[_\s]+/)
      .map((p) => p.toLowerCase())
      .filter((p) => p.length > 1);
    if (parts.length > 1) out.push(...parts);
  }
  return out;
}

/** A glob as a pattern over a path with forward slashes. */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  const g = glob.trim().replace(/^\.\//, "");
  for (let i = 0; i < g.length; i += 1) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        i += 1;
        if (g[i + 1] === "/") {
          i += 1;
          out += "(?:.*/)?";
        } else out += ".*";
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  // A bare pattern like *.ts is meant at any depth.
  const anywhere = !g.includes("/");
  return new RegExp(`^${anywhere ? "(?:.*/)?" : ""}${out}$`);
}

function listFiles(root: string): Walk {
  // Walked afresh every time: a file made a moment ago must be found. What is
  // kept is each file's index, which is only rebuilt when the file changes.
  const files: string[] = [];
  let truncated = false;
  const visit = (dir: string) => {
    if (truncated) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of entries) {
      // Hidden folders are skipped (.github is code); so are environment files,
      // which hold secrets and are nobody's search target.
      if (e.isDirectory() && e.name.startsWith(".") && e.name !== ".github") continue;
      if (e.isFile() && (/^\.env/.test(e.name) || e.name === ".DS_Store")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) visit(full);
      } else if (e.isFile()) {
        if (files.length >= MAX_FILES) {
          truncated = true;
          return;
        }
        files.push(full);
      }
    }
  };
  visit(root);
  return { files, truncated };
}

function load(file: string, rel: string): Indexed | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  if (stat.size > MAX_BYTES || stat.size === 0) return null;
  const cached = indexed.get(file);
  if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) return cached;
  let data: Buffer;
  try {
    data = fs.readFileSync(file);
  } catch {
    return null;
  }
  // A file with a NUL byte near the start is not text.
  if (data.subarray(0, 4096).includes(0)) return null;
  const lines = data.toString("utf8").split(/\r?\n/);
  // The newline that ends a file is not a line of it.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const chunks: Chunk[] = [];
  for (let start = 0; start < lines.length; start += WINDOW) {
    const slice = lines.slice(start, start + WINDOW);
    const tokens = new Map<string, number>();
    let length = 0;
    for (const w of words(slice.join("\n"))) {
      tokens.set(w, (tokens.get(w) ?? 0) + 1);
      length += 1;
    }
    // The file's name is part of what its first window is about.
    if (start === 0) {
      for (const w of words(rel)) {
        tokens.set(w, (tokens.get(w) ?? 0) + 2);
        length += 2;
      }
    }
    if (length > 0) chunks.push({ file: rel, start, lines: slice, tokens, length });
  }
  const entry = { mtime: stat.mtimeMs, size: stat.size, lines, chunks };
  indexed.set(file, entry);
  return entry;
}

const clip = (line: string) => {
  const t = line.trim().replace(/\s+/g, " ");
  return t.length > 160 ? `${t.slice(0, 157)}...` : t;
};

function selected(root: string, glob?: string) {
  const walk = listFiles(root);
  const re = glob?.trim() ? globToRegExp(glob) : null;
  const files = walk.files
    .map((full) => ({ full, rel: path.relative(root, full).split(path.sep).join("/") }))
    .filter((f) => !re || re.test(f.rel));
  return { files, truncated: walk.truncated };
}

/** Search a folder. Never throws: a problem comes back as text. */
export function searchCode(opts: SearchOptions): SearchResult {
  const query = String(opts.query ?? "").trim();
  if (!query) return { ok: false, text: "Say what to search for: a name, a phrase, or a /regular expression/.", files: 0 };
  let root = path.resolve(opts.root);
  try {
    if (!fs.statSync(root).isDirectory()) root = path.dirname(root);
  } catch {
    return { ok: false, text: `There is no folder at ${opts.root}.`, files: 0 };
  }
  const max = Math.min(30, Math.max(1, Math.floor(opts.max ?? 8)));
  const { files, truncated } = selected(root, opts.glob);
  if (files.length === 0) {
    return { ok: true, text: `No files to look through under ${root}${opts.glob ? ` matching ${opts.glob}` : ""}.`, files: 0 };
  }
  const note = truncated ? ` (only the first ${MAX_FILES} files were looked through; narrow it with path or glob)` : "";
  const mode = opts.mode ?? "ranked";

  if (mode === "exact" || mode === "regex") {
    let re: RegExp;
    try {
      const flags = opts.caseSensitive ? "" : "i";
      re = mode === "regex"
        ? new RegExp(query.replace(/^\/(.*)\/[a-z]*$/s, "$1"), flags)
        : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
    } catch (err) {
      return { ok: false, text: `That is not a regular expression this can use: ${String((err as Error).message).split("\n")[0]}`, files: 0 };
    }
    const found: string[] = [];
    let total = 0;
    let inFiles = 0;
    const cap = max * 6;
    for (const f of files) {
      const entry = load(f.full, f.rel);
      if (!entry) continue;
      let any = false;
      entry.lines.forEach((line, i) => {
        if (!re.test(line)) return;
        total += 1;
        if (!any) inFiles += 1;
        any = true;
        if (found.length < cap) found.push(`${f.rel}:${i + 1}: ${clip(line)}`);
      });
    }
    if (total === 0) return { ok: true, text: `No lines match ${JSON.stringify(query)} in ${files.length} files under ${root}.${note}`, files: files.length };
    return {
      ok: true,
      files: files.length,
      text:
        `${total} line${total === 1 ? "" : "s"} in ${inFiles} file${inFiles === 1 ? "" : "s"} match ${JSON.stringify(query)} ` +
        `(${files.length} files searched under ${root}).${note}\n${found.join("\n")}` +
        (total > found.length ? `\n... and ${total - found.length} more lines: narrow it with path, glob or a longer query.` : ""),
    };
  }

  // Ranked: BM25 over the windows.
  const terms = [...new Set(words(query))];
  if (terms.length === 0) return { ok: false, text: "That query has no words in it to rank by; try mode exact.", files: files.length };
  const chunks: Chunk[] = [];
  for (const f of files) {
    const entry = load(f.full, f.rel);
    if (entry) chunks.push(...entry.chunks);
  }
  if (chunks.length === 0) return { ok: true, text: `No text files under ${root}.`, files: files.length };
  const avg = chunks.reduce((n, c) => n + c.length, 0) / chunks.length;
  const df = new Map<string, number>();
  for (const t of terms) df.set(t, chunks.reduce((n, c) => n + (c.tokens.has(t) ? 1 : 0), 0));
  const k1 = 1.2, b = 0.75;
  const scored = chunks.map((c) => {
    let score = 0;
    let matched = 0;
    for (const t of terms) {
      const tf = c.tokens.get(t) ?? 0;
      if (!tf) continue;
      matched += 1;
      const n = df.get(t) ?? 0;
      const idf = Math.log(1 + (chunks.length - n + 0.5) / (n + 0.5));
      score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (c.length / avg))));
    }
    // A window that has every word of the query is worth more than the sum.
    if (matched === terms.length && terms.length > 1) score *= 1.5;
    return { c, score };
  }).filter((s) => s.score > 0).sort((a, z) => z.score - a.score);
  if (scored.length === 0) {
    return { ok: true, text: `Nothing ranks for ${JSON.stringify(query)} in ${files.length} files under ${root}. Try other words, or mode exact.${note}`, files: files.length };
  }
  // At most two windows from one file: the point is to find places.
  const perFile = new Map<string, number>();
  const picked: typeof scored = [];
  for (const s of scored) {
    const n = perFile.get(s.c.file) ?? 0;
    if (n >= 2) continue;
    perFile.set(s.c.file, n + 1);
    picked.push(s);
    if (picked.length >= max) break;
  }
  const lines = picked.map(({ c, score }) => {
    const best = c.lines
      .map((line, i) => ({ line, i, hits: terms.filter((t) => words(line).includes(t)).length }))
      .filter((l) => l.hits > 0)
      .sort((a, z) => z.hits - a.hits || a.i - z.i)
      .slice(0, 4)
      .sort((a, z) => a.i - z.i);
    return [
      `${c.file}:${c.start + 1}-${c.start + c.lines.length}  (score ${score.toFixed(1)})`,
      ...best.map((l) => `  ${c.start + l.i + 1}: ${clip(l.line)}`),
    ].join("\n");
  });
  return {
    ok: true,
    files: files.length,
    text:
      `Best matches for ${JSON.stringify(query)} (${files.length} files searched under ${root}).${note}\n` +
      `${lines.join("\n")}\nRead a place with the terminal (sed -n 'START,ENDp' file) rather than the whole file.`,
  };
}
