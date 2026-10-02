/**
 * What the agent's commands changed in the project, as lines.
 *
 * The agent writes code by running commands -- a redirect, `sed`, a scaffold
 * tool -- so the thread saw a command and its output, never the code that
 * appeared. This watches the working folder and, after a command that changes
 * things, says which files were added, changed or removed and which lines, so
 * the thread can show the code being written.
 *
 * Plain code, read-only: it stats the folder, reads what changed, and keeps the
 * text of small source files to compare against. It is bounded -- a folder with
 * too many files is not tracked at all rather than slowing every command.
 */

import fs from "node:fs";
import path from "node:path";

const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", ".next", ".nuxt", ".svelte-kit", "target", "venv", ".venv", "__pycache__",
  ".cache", ".turbo", "coverage", ".idea", ".gradle", "vendor", ".parcel-cache", ".output",
]);
/** Noisy files: said to have changed, never shown line by line. */
const QUIET = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|Gemfile\.lock|composer\.lock)$|\.(min\.js|min\.css|map|svg|lock)$/;
const SECRET = /(^|\/)\.env/;

export const MAX_TRACKED = 6000;
const MAX_KEPT_BYTES = 64 * 1024;
const MAX_READ_BYTES = 512 * 1024;
const MAX_KEPT_TOTAL = 16 * 1024 * 1024;
const MAX_LINES_PER_FILE = 150;
const MAX_LINES_TOTAL = 400;
const CONTEXT = 2;

export interface DiffLine {
  /** "+" added, "-" removed, " " unchanged context, "~" lines left out. */
  t: "+" | "-" | " " | "~";
  /** The line's number in the new file (old file for a removed line). */
  n: number | null;
  s: string;
}

export interface FileChange {
  path: string;
  kind: "added" | "changed" | "removed";
  added: number;
  removed: number;
  lines: DiffLine[];
  /** Some lines were left out to keep this small. */
  truncated: boolean;
  /** Not shown line by line: a lock file, a big or binary file. */
  quiet?: string;
}

interface Entry {
  mtime: number;
  size: number;
  /** The text, for a small source file. */
  text: string | null;
}

/** The lines of a text, without the newline that ends the last one. */
export function linesOf(text: string): string[] {
  const l = text.split(/\r?\n/);
  if (l.length > 1 && l[l.length - 1] === "") l.pop();
  return l;
}

type Op = { t: "+" | "-" | " "; s: string };

/** A line diff: the shared start and end are set aside, the middle is a
    longest-common-subsequence. A middle too big for that is one block of
    removals and one of additions. */
export function diffLines(a: string[], b: string[]): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const out: Op[] = [];
  for (let i = 0; i < start; i += 1) out.push({ t: " ", s: a[i] });
  const x = a.slice(start, endA), y = b.slice(start, endB);
  if (x.length * y.length > 1_000_000) {
    for (const s of x) out.push({ t: "-", s });
    for (const s of y) out.push({ t: "+", s });
  } else {
    // table[i][j]: the length of the common part of x[i..] and y[j..].
    const table: Uint32Array[] = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
    for (let i = x.length - 1; i >= 0; i -= 1) {
      for (let j = y.length - 1; j >= 0; j -= 1) {
        table[i][j] = x[i] === y[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < x.length && j < y.length) {
      if (x[i] === y[j]) {
        out.push({ t: " ", s: x[i] });
        i += 1;
        j += 1;
      } else if (table[i + 1][j] >= table[i][j + 1]) {
        out.push({ t: "-", s: x[i] });
        i += 1;
      } else {
        out.push({ t: "+", s: y[j] });
        j += 1;
      }
    }
    for (; i < x.length; i += 1) out.push({ t: "-", s: x[i] });
    for (; j < y.length; j += 1) out.push({ t: "+", s: y[j] });
  }
  for (let k = endA; k < a.length; k += 1) out.push({ t: " ", s: a[k] });
  return out;
}

/** The changed lines with a little context, numbered, and bounded. */
function windowed(ops: Op[], maxLines: number): { lines: DiffLine[]; truncated: boolean; added: number; removed: number } {
  // Line numbers in the new file; a removed line keeps the old file's number.
  let nNew = 0, nOld = 0;
  const numbered = ops.map((op) => {
    if (op.t === " ") {
      nNew += 1;
      nOld += 1;
      return { ...op, n: nNew };
    }
    if (op.t === "+") {
      nNew += 1;
      return { ...op, n: nNew };
    }
    nOld += 1;
    return { ...op, n: nOld };
  });
  const added = ops.filter((o) => o.t === "+").length;
  const removed = ops.filter((o) => o.t === "-").length;
  const keep = new Set<number>();
  numbered.forEach((o, i) => {
    if (o.t === " ") return;
    for (let k = Math.max(0, i - CONTEXT); k <= Math.min(numbered.length - 1, i + CONTEXT); k += 1) keep.add(k);
  });
  const lines: DiffLine[] = [];
  let truncated = false;
  let skipped = false;
  for (let i = 0; i < numbered.length; i += 1) {
    if (!keep.has(i)) {
      if (!skipped && lines.length > 0) lines.push({ t: "~", n: null, s: "" });
      skipped = true;
      continue;
    }
    skipped = false;
    if (lines.length >= maxLines) {
      truncated = true;
      break;
    }
    lines.push({ t: numbered[i].t, n: numbered[i].n, s: numbered[i].s.slice(0, 240) });
  }
  while (lines.length > 0 && lines[lines.length - 1].t === "~") lines.pop();
  return { lines, truncated, added, removed };
}

export class Workspace {
  private files = new Map<string, Entry>();
  private kept = 0;
  /** Set when the folder has too many files to follow. */
  tooMany = false;
  private primed = false;

  /** `skip`: folders that are never looked in (Autora's own data, say). */
  constructor(readonly root: string, private readonly skip: string[] = []) {}

  private walk(): Map<string, { full: string; mtime: number; size: number }> | null {
    const found = new Map<string, { full: string; mtime: number; size: number }>();
    let over = false;
    const visit = (dir: string) => {
      if (over) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (over) return;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (this.skip.some((s) => path.resolve(s) === path.resolve(full))) continue;
          if (!SKIP_DIRS.has(e.name) && !(e.name.startsWith(".") && e.name !== ".github")) visit(full);
        } else if (e.isFile() && !SECRET.test(e.name)) {
          if (found.size >= MAX_TRACKED) {
            over = true;
            return;
          }
          try {
            const st = fs.statSync(full);
            found.set(path.relative(this.root, full).split(path.sep).join("/"), { full, mtime: st.mtimeMs, size: st.size });
          } catch {
            // gone between listing and looking
          }
        }
      }
    };
    visit(this.root);
    return over ? null : found;
  }

  private read(full: string, size: number): string | null {
    if (size > MAX_READ_BYTES) return null;
    try {
      const data = fs.readFileSync(full);
      if (data.subarray(0, 4096).includes(0)) return null;
      return data.toString("utf8");
    } catch {
      return null;
    }
  }

  private keep(text: string | null, size: number): string | null {
    if (text === null || size > MAX_KEPT_BYTES || this.kept + size > MAX_KEPT_TOTAL) return null;
    this.kept += size;
    return text;
  }

  /** A file as the last scan saw it, when it was small enough to keep. */
  textOf(rel: string): string | null {
    return this.files.get(rel)?.text ?? null;
  }

  /** Whether a baseline has been taken: later scans say what changed since. */
  get hasBaseline(): boolean {
    return this.primed;
  }

  /** Take the folder as it is now as the one later scans compare against. */
  prime(): void {
    this.scan();
    this.primed = true;
  }

  /** What changed since the last scan (or prime). The first scan is a baseline
      and says nothing. */
  scan(): FileChange[] {
    const now = this.walk();
    if (now === null) {
      this.tooMany = true;
      this.files.clear();
      this.kept = 0;
      return [];
    }
    this.tooMany = false;
    const baseline = !this.primed && this.files.size === 0;
    const out: FileChange[] = [];
    let budget = MAX_LINES_TOTAL;

    for (const [rel, info] of now) {
      const was = this.files.get(rel);
      if (was && was.mtime === info.mtime && was.size === info.size) continue;
      const text = this.read(info.full, info.size);
      const quiet = QUIET.test(rel) ? "generated or lock file" : text === null ? (info.size > MAX_READ_BYTES ? "large file" : "not text") : undefined;
      if (was?.text) this.kept -= was.size;
      this.files.set(rel, { mtime: info.mtime, size: info.size, text: quiet ? null : this.keep(text, info.size) });
      if (baseline) continue;
      if (quiet) {
        out.push({ path: rel, kind: was ? "changed" : "added", added: 0, removed: 0, lines: [], truncated: false, quiet });
        continue;
      }
      if (text === null) continue;
      if (!was) {
        const all = linesOf(text);
        const shown = all.slice(0, Math.min(MAX_LINES_PER_FILE, Math.max(0, budget)));
        budget -= shown.length;
        out.push({
          path: rel, kind: "added", added: all.length, removed: 0,
          lines: shown.map((s, i) => ({ t: "+" as const, n: i + 1, s: s.slice(0, 240) })),
          truncated: shown.length < all.length,
        });
      } else if (was.text !== null) {
        if (was.text === text) continue;
        const d = windowed(diffLines(linesOf(was.text), linesOf(text)), Math.min(MAX_LINES_PER_FILE, Math.max(0, budget)));
        budget -= d.lines.length;
        if (d.added === 0 && d.removed === 0) continue;
        out.push({ path: rel, kind: "changed", added: d.added, removed: d.removed, lines: d.lines, truncated: d.truncated });
      } else {
        out.push({ path: rel, kind: "changed", added: 0, removed: 0, lines: [], truncated: false, quiet: "too big to compare" });
      }
    }
    for (const [rel, was] of [...this.files]) {
      if (now.has(rel)) continue;
      this.files.delete(rel);
      if (was.text !== null) this.kept -= was.size;
      if (baseline) continue;
      out.push({ path: rel, kind: "removed", added: 0, removed: was.text ? linesOf(was.text).length : 0, lines: [], truncated: false });
    }
    this.primed = true;
    // Newest-looking work first: new files, then edits, then removals.
    const rank = { added: 0, changed: 1, removed: 2 } as const;
    return out.sort((a, b) => rank[a.kind] - rank[b.kind] || (a.path < b.path ? -1 : 1)).slice(0, 40);
  }
}
