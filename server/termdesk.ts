/**
 * The Terminal window: a shell the person and the agent share, beside the conversation.
 *
 * One terminal per chat. What the person types runs here (`POST /api/term/:session/run`), what the agent runs with its
 * `terminal` tool is mirrored into the same scrollback (`termAgentBegin` / `Chunk` / `End`, called from the tool), and
 * the two share a working directory: a `cd` in the window is where the agent's next command starts, and the agent is
 * told what the person ran in between (`termNews`).
 *
 * Like the agent's tool it is pipes, not a PTY (server/tools.ts `runCommand`): each command is its own `bash -lc`,
 * so a full-screen program (vim, top) cannot work. What makes it feel like a shell is kept here instead: the working
 * directory carries from one command to the next (the command is wrapped to print where it ended), output is shown
 * in colour as it arrives, a command can be stopped, and the line being typed is completed -- commands, paths,
 * `git` and `npm run` -- by `completeLine`.
 *
 * Everything is in memory and per chat (`dropTerm` clears it with the chat): scrollback is not worth writing to a
 * disk, and a command typed into a terminal can hold a secret. Output has already had the workspace's secrets blanked
 * by `runCommand`; commands are blanked here before they are kept.
 */
import type { Express, Request, Response } from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { redactForModel, runCommand, terminalDir, toolSettings } from "./tools";
import type { ToolContext } from "./tools";

export interface TermEntry {
  id: number;
  command: string;
  cwd: string;
  by: "person" | "agent";
  output: string;
  /** Exit code once it has finished; null while it runs. */
  exit: number | null;
  running: boolean;
  started: number;
  ms: number | null;
  /** The revision this entry last changed at, so a client asks only for what it has not seen. */
  rev: number;
}

interface Desk {
  open: boolean;
  since: number;
  cwd: string;
  rev: number;
  seq: number;
  entries: TermEntry[];
  stops: Map<number, () => void>;
  /** What the person ran that the agent has not been told yet. */
  news: string[];
  /** A marker is held back until the whole of it has arrived (see `Flow`). */
  flows: Map<number, Flow>;
}

/** What the window shows, and what the page is told over the socket: no output, only that something moved. */
export interface TermState {
  open: boolean;
  since?: number;
  cwd?: string;
  rev?: number;
  running?: boolean;
}

const desks = new Map<string, Desk>();
const listeners = new Set<(session: string) => void>();
/** What has been typed, newest last: for the line's suggestions. Never written to disk. */
const history: string[] = [];

const MAX_ENTRIES = 120;
const HEAD = 8_000;
const TAIL = 56_000;
/** The mark a wrapped command prints when it ends, to say where it ended. */
const MARK = "\n@@AUTORA-CWD@@";
const MARK_END = "@@/AUTORA-CWD@@";

const validSession = (id: string) => /^[A-Za-z0-9_-]{1,80}$/.test(id);

function deskFor(session: string): Desk {
  let desk = desks.get(session);
  if (!desk) {
    desk = { open: false, since: 0, cwd: "", rev: 0, seq: 0, entries: [], stops: new Map(), news: [], flows: new Map() };
    desks.set(session, desk);
  }
  return desk;
}

const changed = (session: string) => { for (const l of listeners) l(session); };
export const onTermChange = (fn: (session: string) => void): (() => void) => {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
};

export function termState(session: string): TermState {
  const desk = desks.get(session);
  if (!desk?.open) return { open: false };
  return { open: true, since: desk.since, cwd: desk.cwd || terminalDir(), rev: desk.rev, running: desk.entries.some((e) => e.running) };
}

export function dropTerm(session: string) {
  const desk = desks.get(session);
  if (desk) for (const stop of desk.stops.values()) stop();
  desks.delete(session);
}

/** Where a command starts: the window's directory once it has been opened, otherwise the tool's own. */
export function termCwd(session: string): string | null {
  const desk = desks.get(session);
  return desk?.open && desk.cwd ? desk.cwd : null;
}

// --------------------------------------------------------------- scrollback --

/**
 * Output as it arrives, minus the mark that says where a command ended. The mark can be split across chunks, so
 * from the first byte that might begin it nothing is passed on until it is complete or proved to be something else.
 */
interface Flow { held: string; cwd: string | null }

function flowThrough(flow: Flow, chunk: string): string {
  const text = flow.held + chunk;
  flow.held = "";
  const at = text.indexOf(MARK);
  if (at >= 0) {
    const end = text.indexOf(MARK_END, at + MARK.length);
    if (end < 0) {
      // The mark has begun and not finished: nothing from it on is shown yet.
      flow.held = text.slice(at);
      return text.slice(0, at);
    }
    flow.cwd = text.slice(at + MARK.length, end);
    return text.slice(0, at) + text.slice(end + MARK_END.length);
  }
  // The end of this chunk may be the start of the mark: held back until the next one says.
  for (let k = Math.min(MARK.length - 1, text.length); k > 0; k -= 1) {
    if (text.endsWith(MARK.slice(0, k))) {
      flow.held = text.slice(text.length - k);
      return text.slice(0, text.length - k);
    }
  }
  return text;
}

function bump(desk: Desk, entry: TermEntry) {
  entry.rev = ++desk.rev;
}

/** What was cut from the middle of a long output, per entry: the window gets the start, a note, and the end. */
const cuts = new WeakMap<TermEntry, { head: string; tail: string; skipped: number }>();

/** Append to an entry, keeping its start and its end when it runs long. */
function append(entry: TermEntry, text: string) {
  if (!text) return;
  let cut = cuts.get(entry);
  if (!cut) {
    entry.output += text;
    if (entry.output.length <= HEAD + TAIL) return;
    cut = { head: entry.output.slice(0, HEAD), tail: entry.output.slice(HEAD), skipped: 0 };
    cuts.set(entry, cut);
  } else {
    cut.tail += text;
  }
  if (cut.tail.length > TAIL) {
    cut.skipped += cut.tail.length - TAIL;
    cut.tail = cut.tail.slice(-TAIL);
  }
  entry.output = cut.skipped > 0
    ? `${cut.head}\n[... ${cut.skipped.toLocaleString("en-US")} characters left out of the middle ...]\n${cut.tail}`
    : cut.head + cut.tail;
}

function addEntry(session: string, command: string, cwd: string, by: "person" | "agent"): { desk: Desk; entry: TermEntry } {
  const desk = deskFor(session);
  const entry: TermEntry = {
    id: ++desk.seq, command: redactForModel(command), cwd, by, output: "", exit: null,
    running: true, started: Date.now(), ms: null, rev: 0,
  };
  desk.entries.push(entry);
  while (desk.entries.length > MAX_ENTRIES) {
    const gone = desk.entries.findIndex((e) => !e.running);
    if (gone < 0) break;
    desk.entries.splice(gone, 1);
  }
  bump(desk, entry);
  return { desk, entry };
}

function finish(session: string, desk: Desk, entry: TermEntry, exit: number | null) {
  entry.running = false;
  entry.exit = exit;
  entry.ms = Date.now() - entry.started;
  desk.stops.delete(entry.id);
  desk.flows.delete(entry.id);
  bump(desk, entry);
  changed(session);
}

// ------------------------------------------------------------ the agent's side --

/** The agent starts a command in its terminal tool: it appears in the window, marked as the agent's. */
export function termAgentBegin(session: string, command: string, cwd: string): number {
  const { entry } = addEntry(session, command, cwd, "agent");
  changed(session);
  return entry.id;
}

export function termAgentChunk(session: string, id: number, text: string) {
  const desk = desks.get(session);
  const entry = desk?.entries.find((e) => e.id === id);
  if (!desk || !entry) return;
  append(entry, text);
  bump(desk, entry);
  changed(session);
}

export function termAgentEnd(session: string, id: number, exit: number | undefined) {
  const desk = desks.get(session);
  const entry = desk?.entries.find((e) => e.id === id);
  if (desk && entry) finish(session, desk, entry, exit ?? null);
}

/** What the person ran in the window since the agent was last told, as a line for the agent; empty if nothing. */
export function termNews(session: string): string {
  const desk = desks.get(session);
  if (!desk || desk.news.length === 0) return "";
  const list = desk.news.slice(-8);
  const more = desk.news.length - list.length;
  desk.news = [];
  return (
    `Meanwhile, in the Terminal window, the person ran: ${list.join("; ")}${more > 0 ? `; and ${more} earlier` : ""}. ` +
    "Their directory carries over to your next command."
  );
}

// ---------------------------------------------------------- the person's side --

/** Start what the person typed. `done` resolves when it has finished; the output reaches the window as it arrives. */
export function startInTerm(session: string, command: string): { ok: true; id: number; done: Promise<void> } | { ok: false; error: string } {
  if (!validSession(session)) return { ok: false, error: "No such session." };
  const line = command.replace(/\r\n/g, "\n").trim();
  if (!line) return { ok: false, error: "Nothing to run." };
  if (line.length > 20_000) return { ok: false, error: "That command is too long." };
  if (!toolSettings().terminal.enabled) return { ok: false, error: "The terminal is switched off on the Tools page." };
  const desk = deskFor(session);
  const cwd = desk.cwd && fs.existsSync(desk.cwd) ? desk.cwd : terminalDir();
  const { entry } = addEntry(session, line, cwd, "person");
  const flow: Flow = { held: "", cwd: null };
  desk.flows.set(entry.id, flow);
  const at = history.indexOf(entry.command);
  if (at >= 0) history.splice(at, 1);
  history.push(entry.command);
  if (history.length > 500) history.shift();
  desk.news.push(`\`${entry.command.replace(/\s+/g, " ").slice(0, 160)}\``);
  changed(session);

  // The command runs as typed, then says where it ended: `cd` and friends carry to the next one.
  const wrapped = `${line}\n__autora_rc=$?\nprintf '%s%s%s' '${MARK}' "$PWD" '${MARK_END}'\nexit $__autora_rc`;
  let stop = () => undefined as void;
  const hooks = {
    onOutput: (chunk: string) => {
      append(entry, flowThrough(flow, chunk));
      bump(desk, entry);
      changed(session);
    },
    onCancel: (fn: () => void) => { stop = fn; desk.stops.set(entry.id, () => stop()); },
  };
  const done = runCommand(wrapped, cwd, 3600, hooks as unknown as ToolContext, {}, true).then((outcome) => {
    const last = flow.held;
    flow.held = "";
    // What was held back and never became the mark was output after all.
    if (last && !last.startsWith(MARK)) append(entry, last);
    if (flow.cwd && fs.existsSync(flow.cwd)) desk.cwd = flow.cwd;
    // A command that never started (no shell, no such folder) says why.
    if (outcome.exitCode === undefined) append(entry, outcome.summary);
    finish(session, desk, entry, outcome.exitCode ?? 1);
  });
  return { ok: true, id: entry.id, done };
}

/** For tests and callers that want to wait. */
export async function runInTerm(session: string, command: string) {
  const started = startInTerm(session, command);
  if (started.ok) await started.done;
  return started.ok ? { ok: true as const, id: started.id } : started;
}

export function stopInTerm(session: string, id?: number): boolean {
  const desk = desks.get(session);
  if (!desk) return false;
  let any = false;
  for (const [key, stop] of desk.stops) {
    if (id !== undefined && key !== id) continue;
    stop();
    any = true;
  }
  return any;
}

// ---------------------------------------------------------------- completion --

export interface Completion {
  /** The part of the line these replace: [from, to). */
  from: number;
  to: number;
  items: { text: string; kind: "command" | "dir" | "file" | "git" | "script" | "history" | "option"; hint?: string }[];
}

const BUILTINS = [
  "cd", "pwd", "echo", "export", "unset", "alias", "source", "exit", "history", "type", "which", "set", "read", "printf",
  "test", "eval", "exec", "kill", "wait", "jobs", "umask", "ulimit",
];
const GIT = [
  "add", "branch", "checkout", "clone", "commit", "diff", "fetch", "init", "log", "merge", "pull", "push", "rebase", "remote",
  "reset", "restore", "show", "stash", "status", "switch", "tag", "config", "blame", "cherry-pick", "clean", "grep", "revert", "rm", "mv",
];
const NPM = ["install", "run", "test", "start", "build", "ci", "init", "update", "outdated", "audit", "ls", "publish", "exec", "pack", "version"];
/** Words after which the next one is a command again. */
const CHAINERS = new Set(["sudo", "time", "env", "xargs", "nohup", "watch", "exec", "command", "nice", "timeout", "then", "do", "else"]);

let pathCache: { at: number; names: string[] } | null = null;
function pathCommands(): string[] {
  if (pathCache && Date.now() - pathCache.at < 30_000) return pathCache.names;
  const seen = new Set<string>();
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    try {
      for (const name of fs.readdirSync(dir)) {
        if (seen.has(name) || name.startsWith(".")) continue;
        try {
          fs.accessSync(path.join(dir, name), fs.constants.X_OK);
          seen.add(name);
        } catch { /* not runnable */ }
      }
    } catch { /* a folder on PATH that is not there */ }
  }
  const names = [...seen].sort();
  pathCache = { at: Date.now(), names };
  return names;
}

const unescapeWord = (w: string) => w.replace(/\\(.)/g, "$1").replace(/^["']|["']$/g, "");
const escapeWord = (w: string) => w.replace(/([ \t'"\\$`&|;()<>*?#!])/g, "\\$1");

/** The words of a line up to the cursor, with where the last one starts. */
function wordsBefore(line: string, cursor: number): { words: string[]; start: number; prefix: string; commandPos: boolean } {
  const upto = line.slice(0, cursor);
  const words: string[] = [];
  let start = 0;
  let cur = "";
  let quote = "";
  let commandPos = true;
  let wordStart = 0;
  const flush = (i: number) => {
    if (cur) words.push(cur);
    cur = "";
    wordStart = i;
  };
  for (let i = 0; i < upto.length; i += 1) {
    const ch = upto[i];
    if (quote) { cur += ch; if (ch === quote) quote = ""; continue; }
    if (ch === "\\" && i + 1 < upto.length) { cur += ch + upto[i + 1]; i += 1; continue; }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
    if (/\s/.test(ch)) { flush(i + 1); continue; }
    if (ch === "|" || ch === ";" || ch === "&" || ch === "(") { flush(i + 1); words.length = 0; commandPos = true; continue; }
    cur += ch;
  }
  start = wordStart;
  void commandPos;
  const prior = words;
  const isCmd = prior.length === 0 || (prior.length >= 1 && prior.every((w) => CHAINERS.has(w) || /^\w+=/.test(w)));
  return { words: prior, start, prefix: cur, commandPos: isCmd };
}

function listDir(dir: string): fs.Dirent[] {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

export function completeLine(line: string, cursor: number, cwd: string, past: string[] = history): Completion {
  const at = Math.max(0, Math.min(cursor, line.length));
  const { words, start, prefix, commandPos } = wordsBefore(line, at);
  const empty: Completion = { from: start, to: at, items: [] };
  const first = words[0] ?? "";
  const sub = words[1] ?? "";

  // A command name.
  if (commandPos && !prefix.includes("/") && !prefix.startsWith("~") && !prefix.startsWith(".")) {
    if (!prefix) return empty;
    const items: Completion["items"] = [];
    const seen = new Set<string>();
    for (const name of [...BUILTINS, ...pathCommands()]) {
      if (name.startsWith(prefix) && !seen.has(name)) { seen.add(name); items.push({ text: name, kind: "command" }); }
      if (items.length >= 60) break;
    }
    // What was typed before wins: its first words come first.
    const used = new Set(past.map((h) => h.split(/\s+/)[0]));
    items.sort((a, b) => Number(used.has(b.text)) - Number(used.has(a.text)) || a.text.length - b.text.length || a.text.localeCompare(b.text));
    return { from: start, to: at, items: items.slice(0, 40) };
  }

  const lead = commandPos ? "" : words.filter((w) => !CHAINERS.has(w) && !/^\w+=/.test(w))[0] ?? first;
  const next = words.filter((w) => !CHAINERS.has(w) && !/^\w+=/.test(w))[1] ?? sub;

  // What a command's own words are.
  if (lead === "git" && words.length >= 1 && (words.filter((w) => !CHAINERS.has(w)).length === 1) && !prefix.startsWith("-") && !prefix.includes("/")) {
    return { from: start, to: at, items: GIT.filter((g) => g.startsWith(prefix)).map((g) => ({ text: g, kind: "git" as const })) };
  }
  if (["git"].includes(lead) && ["checkout", "switch", "merge", "branch", "rebase"].includes(next) && !prefix.startsWith("-") && !prefix.includes("/")) {
    const heads = listDir(findGitDir(cwd) ? path.join(findGitDir(cwd)!, "refs", "heads") : "").filter((d) => d.isFile()).map((d) => d.name);
    const items = heads.filter((h) => h.startsWith(prefix)).map((h) => ({ text: h, kind: "git" as const, hint: "branch" }));
    if (items.length) return { from: start, to: at, items };
  }
  if (["npm", "pnpm", "yarn", "bun"].includes(lead)) {
    const sofar = words.filter((w) => !CHAINERS.has(w) && !/^\w+=/.test(w)).length;
    if (sofar === 1 && !prefix.startsWith("-")) return { from: start, to: at, items: NPM.filter((n) => n.startsWith(prefix)).map((n) => ({ text: n, kind: "git" as const })) };
    if (sofar === 2 && ["run", "run-script"].includes(next)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")) as { scripts?: Record<string, string> };
        const items = Object.entries(pkg.scripts ?? {}).filter(([k]) => k.startsWith(prefix)).map(([k, v]) => ({ text: k, kind: "script" as const, hint: v.slice(0, 60) }));
        if (items.length) return { from: start, to: at, items };
      } catch { /* no package.json here */ }
    }
  }

  // A path.
  const raw = unescapeWord(prefix);
  const home = os.homedir();
  const expanded = raw.startsWith("~") ? path.join(home, raw.slice(1)) : raw;
  const slash = expanded.lastIndexOf("/");
  const dirPart = slash >= 0 ? expanded.slice(0, slash + 1) : "";
  const base = slash >= 0 ? expanded.slice(slash + 1) : expanded;
  const dir = path.resolve(cwd, dirPart || ".");
  const dirsOnly = lead === "cd" || lead === "pushd" || lead === "rmdir";
  const shownDir = raw.slice(0, raw.length - base.length);
  const items: Completion["items"] = [];
  for (const entry of listDir(dir)) {
    if (!entry.name.startsWith(base)) continue;
    if (entry.name.startsWith(".") && !base.startsWith(".")) continue;
    let isDir = entry.isDirectory();
    if (entry.isSymbolicLink()) { try { isDir = fs.statSync(path.join(dir, entry.name)).isDirectory(); } catch { /* dangling */ } }
    if (dirsOnly && !isDir) continue;
    items.push({ text: escapeWord(shownDir + entry.name) + (isDir ? "/" : ""), kind: isDir ? "dir" : "file" });
  }
  items.sort((a, b) => (a.kind === "dir" ? 0 : 1) - (b.kind === "dir" ? 0 : 1) || a.text.localeCompare(b.text));
  return { from: start, to: at, items: items.slice(0, 80) };
}

function findGitDir(cwd: string): string | null {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 12; i += 1) {
    const g = path.join(dir, ".git");
    try { if (fs.statSync(g).isDirectory()) return g; } catch { /* up */ }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

// -------------------------------------------------------------------- routes --

export function termRoutes(app: Express, deps: { exists: (id: string) => boolean }) {
  const known = (req: Request, res: Response): string | null => {
    const id = String(req.params.session ?? "");
    if (!validSession(id) || !deps.exists(id)) { res.status(404).json({ error: "No such session." }); return null; }
    return id;
  };

  app.post("/api/term/:session/open", (req, res) => {
    const id = known(req, res);
    if (!id) return;
    if (!toolSettings().terminal.enabled) return res.status(409).json({ error: "The terminal is switched off on the Tools page." });
    const desk = deskFor(id);
    if (!desk.open) {
      desk.open = true;
      desk.since = Date.now();
      if (!desk.cwd) desk.cwd = terminalDir();
      desk.rev += 1;
    }
    changed(id);
    res.json({ name: "a terminal", state: termState(id) });
  });

  app.post("/api/term/:session/close", (req, res) => {
    const id = known(req, res);
    if (!id) return;
    const desk = deskFor(id);
    desk.open = false;
    changed(id);
    res.json({ ok: true });
  });

  /* What is on the screen, newer than `after`; `history` is what was typed, for the line's suggestions. */
  app.get("/api/term/:session", (req, res) => {
    const id = known(req, res);
    if (!id) return;
    const desk = deskFor(id);
    const after = Number(req.query.after) || 0;
    res.json({
      state: termState(id),
      cwd: desk.cwd || terminalDir(),
      home: os.homedir(),
      rev: desk.rev,
      entries: desk.entries.filter((e) => e.rev > after),
      known: desk.entries.map((e) => e.id),
      history: history.slice(-200),
    });
  });

  app.post("/api/term/:session/run", async (req, res) => {
    const id = known(req, res);
    if (!id) return;
    const command = typeof req.body?.command === "string" ? req.body.command : "";
    // The answer is not held for the command: it streams to the window, and this says it has begun.
    const started = startInTerm(id, command);
    if (!started.ok) return res.status(400).json({ error: started.error });
    void started.done.catch(() => undefined);
    res.json({ ok: true, id: started.id });
  });

  app.post("/api/term/:session/stop", (req, res) => {
    const id = known(req, res);
    if (!id) return;
    res.json({ stopped: stopInTerm(id, typeof req.body?.id === "number" ? req.body.id : undefined) });
  });

  app.post("/api/term/:session/clear", (req, res) => {
    const id = known(req, res);
    if (!id) return;
    const desk = deskFor(id);
    desk.entries = desk.entries.filter((e) => e.running);
    desk.rev += 1;
    changed(id);
    res.json({ ok: true });
  });

  app.get("/api/term/:session/complete", (req, res) => {
    const id = known(req, res);
    if (!id) return;
    const desk = deskFor(id);
    const line = String(req.query.line ?? "").slice(0, 4000);
    const cursor = Number(req.query.cursor);
    res.json(completeLine(line, Number.isFinite(cursor) ? cursor : line.length, desk.cwd || terminalDir()));
  });
}
