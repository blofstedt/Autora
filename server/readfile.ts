/**
 * Reading part of a file without running a shell for it.
 *
 * `cat` of a whole file spends the context on lines nobody needed, and
 * `sed -n 'a,bp'` costs a round trip and a guess about the numbers. This reads
 * a range of lines (numbered, so an edit can name them), or gives an outline --
 * the functions, classes and headings of the file with their line numbers -- or
 * finds a named symbol and returns its body. Plain code: no model, no shell,
 * nothing written.
 */

import fs from "node:fs";
import path from "node:path";
import { pathHint } from "./hints";

const MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_LINES = 200;
const MAX_LINES = 600;
const MAX_LINE_CHARS = 400;

export interface ReadArgs {
  path: string;
  /** First line, 1-based. */
  start?: number;
  /** Last line, inclusive. */
  end?: number;
  /** List the file's declarations and headings instead of its text. */
  outline?: boolean;
  /** Return the body of the declaration with this name. */
  symbol?: string;
}

export interface ReadResult {
  ok: boolean;
  text: string;
  /** The file as it was read, so a later edit has a base. */
  content?: string;
}

export interface Decl {
  line: number;
  name: string;
  kind: string;
  /** Indent in columns: what the declaration is nested in. */
  indent: number;
  text: string;
}

/** What starts a declaration, in the languages people ask this for. */
const PATTERNS: { kind: string; re: RegExp }[] = [
  // JS / TS
  { kind: "function", re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/ },
  { kind: "class", re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
  { kind: "interface", re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
  { kind: "type", re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^=]*>)?\s*=/ },
  { kind: "enum", re: /^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/ },
  { kind: "function", re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/ },
  { kind: "function", re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\b/ },
  // Python
  { kind: "function", re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/ },
  { kind: "class", re: /^\s*class\s+([A-Za-z_]\w*)/ },
  // Go / Rust / Java-ish
  { kind: "function", re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/ },
  { kind: "function", re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/ },
  { kind: "struct", re: /^\s*(?:pub\s+)?(?:struct|trait|impl)\s+([A-Za-z_]\w*)/ },
  { kind: "type", re: /^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/ },
  // Markdown
  { kind: "heading", re: /^(#{1,6})\s+(.+?)\s*#*\s*$/ },
];

/** Methods inside a class body: `name(args) {` with no keyword in front. */
const METHOD = /^\s+(?:public\s+|private\s+|protected\s+|static\s+|async\s+|readonly\s+|get\s+|set\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::[^{;]+)?\{\s*$/;
const NOT_METHOD = new Set(["if", "for", "while", "switch", "catch", "function", "return", "else", "with", "do"]);

export function declarations(lines: string[]): Decl[] {
  const out: Decl[] = [];
  let inClass = -1;
  lines.forEach((text, i) => {
    if (text.length > 600) return;
    const indent = text.match(/^\s*/)![0].replace(/\t/g, "    ").length;
    for (const { kind, re } of PATTERNS) {
      const m = re.exec(text);
      if (!m) continue;
      if (kind === "heading") {
        out.push({ line: i + 1, name: m[2], kind: `h${m[1].length}`, indent: (m[1].length - 1) * 2, text: text.trim() });
      } else {
        out.push({ line: i + 1, name: m[1], kind, indent, text: text.trim() });
        if (kind === "class") inClass = indent;
      }
      return;
    }
    if (inClass >= 0 && indent > inClass) {
      const m = METHOD.exec(text);
      if (m && !NOT_METHOD.has(m[1])) out.push({ line: i + 1, name: m[1], kind: "method", indent, text: text.trim() });
    } else if (inClass >= 0 && text.trim() && indent <= inClass && !/^\s*[})\]]/.test(text)) {
      inClass = -1;
    }
  });
  return out;
}

/** Where a declaration ends: the line before the next one at its depth or shallower, trimmed of blank lines. */
function endOf(lines: string[], decls: Decl[], at: number): number {
  const d = decls[at];
  // Braces: follow them from the declaration's first line.
  let depth = 0;
  let seen = false;
  for (let i = d.line - 1; i < lines.length; i += 1) {
    for (const ch of lines[i].replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "")) {
      if (ch === "{") { depth += 1; seen = true; }
      else if (ch === "}") depth -= 1;
    }
    if (seen && depth <= 0) return i + 1;
    if (!seen && i > d.line + 3) break;
  }
  // Indentation or headings: up to the next declaration at the same depth or less.
  let end = lines.length;
  for (let j = at + 1; j < decls.length; j += 1) {
    if (decls[j].indent <= d.indent) {
      end = decls[j].line - 1;
      break;
    }
  }
  while (end > d.line && lines[end - 1].trim() === "") end -= 1;
  return end;
}

const clip = (line: string) => (line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS - 3)}...` : line);

function numbered(lines: string[], from: number, to: number): string {
  const width = String(to).length;
  const out: string[] = [];
  for (let i = from; i <= to; i += 1) out.push(`${String(i).padStart(width, " ")}  ${clip(lines[i - 1])}`);
  return out.join("\n");
}

/** Read a file, or a part of it. Never throws: a problem comes back as text. */
export function readFile(args: ReadArgs, deps: { root: string; protect?: string[] }): ReadResult {
  const raw = String(args.path ?? "").trim();
  if (!raw) return { ok: false, text: "Say which file to read." };
  const file = path.resolve(deps.root, raw);
  for (const guarded of deps.protect ?? []) {
    const rel = path.relative(path.resolve(guarded), file);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return { ok: false, text: "That is Autora's own data; it is not read this way." };
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return { ok: false, text: `There is no file at ${file}.${pathHint(deps.root, raw)}` };
  }
  if (stat.isDirectory()) {
    let names: string[] = [];
    try { names = fs.readdirSync(file).sort(); } catch { /* unreadable */ }
    return { ok: true, text: `${file} is a folder with ${names.length} entries:\n${names.slice(0, 80).join("\n")}${names.length > 80 ? `\n... and ${names.length - 80} more` : ""}` };
  }
  if (/^\.env/.test(path.basename(file))) return { ok: false, text: "Environment files hold secrets and are not read this way." };
  if (stat.size > MAX_BYTES) return { ok: false, text: `${file} is ${(stat.size / 1048576).toFixed(1)} MB: too large to read whole. Search it with code_search or read a part with the terminal.` };
  let data: Buffer;
  try {
    data = fs.readFileSync(file);
  } catch (err) {
    return { ok: false, text: `Could not read ${file}: ${String((err as Error).message).split("\n")[0]}` };
  }
  if (data.subarray(0, 4096).includes(0)) return { ok: false, text: `${file} is not a text file (${stat.size} bytes).` };
  const content = data.toString("utf8");
  const lines = content.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const total = lines.length;
  const head = `${raw} (${total} line${total === 1 ? "" : "s"})`;

  if (args.outline || args.symbol) {
    const decls = declarations(lines);
    if (args.symbol) {
      const want = String(args.symbol).trim();
      const hits = decls.map((d, i) => ({ d, i })).filter(({ d }) => d.name === want || d.name.toLowerCase() === want.toLowerCase());
      if (hits.length === 0) {
        const near = decls.filter((d) => d.name.toLowerCase().includes(want.toLowerCase())).slice(0, 8);
        return {
          ok: false,
          text: `No declaration named ${JSON.stringify(want)} in ${raw}.` +
            (near.length ? ` Close: ${near.map((d) => `${d.name} (line ${d.line})`).join(", ")}.` : decls.length ? " Read outline for what is there." : " Nothing in it looks like a declaration; read a range instead."),
        };
      }
      const parts = hits.slice(0, 3).map(({ d, i }) => {
        const end = Math.min(endOf(lines, decls, i), d.line + MAX_LINES - 1);
        return `${d.kind} ${d.name}, lines ${d.line}-${end} of ${raw}:\n${numbered(lines, d.line, end)}`;
      });
      return { ok: true, content, text: `${parts.join("\n\n")}${hits.length > 3 ? `\n\n(${hits.length - 3} more with that name; read a range.)` : ""}` };
    }
    if (decls.length === 0) {
      return { ok: true, content, text: `${head}: nothing in it looks like a declaration or heading. Read a range instead.` };
    }
    const shown = decls.slice(0, 200).map((d) => `${String(d.line).padStart(String(total).length)}  ${" ".repeat(Math.min(8, Math.floor(d.indent / 2)))}${d.kind === "heading" || /^h\d$/.test(d.kind) ? d.text : `${d.kind} ${d.name}`}`);
    return { ok: true, content, text: `${head}, outline:\n${shown.join("\n")}${decls.length > 200 ? `\n... and ${decls.length - 200} more` : ""}\nRead a part with start and end, or one declaration with symbol.` };
  }

  if (total === 0) return { ok: true, content, text: `${head}: empty.` };
  let start = Math.floor(Number(args.start ?? 1));
  if (!Number.isFinite(start) || start < 1) start = 1;
  if (start > total) return { ok: false, text: `${head}: there is no line ${start}.` };
  let end = args.end === undefined ? start + DEFAULT_LINES - 1 : Math.floor(Number(args.end));
  if (!Number.isFinite(end) || end < start) end = start + DEFAULT_LINES - 1;
  const capped = Math.min(end, start + MAX_LINES - 1, total);
  const more = capped < total ? `\n[${total - capped} more lines: read from ${capped + 1}${capped < end ? "" : ""}, or outline the file.]` : "";
  return { ok: true, content, text: `${head}, lines ${start}-${capped}:\n${numbered(lines, start, capped)}${more}` };
}

/** The declaration a line sits inside: the nearest one above it that is not a heading. */
export function enclosing(decls: readonly Decl[], line: number): Decl | null {
  let found: Decl | null = null;
  for (const d of decls) {
    if (d.line > line) break;
    if (!/^h\d$/.test(d.kind)) found = d;
  }
  return found;
}
