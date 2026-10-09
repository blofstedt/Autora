/**
 * The Terminal window: a real terminal, beside the conversation, on the machine Autora runs on.
 *
 * One shell per chat, on a pseudo-terminal, so it is a shell and not a command runner: bash's own completion and
 * history, colours, `vim`, `top`, `ssh`, Ctrl+C, a question a program asks and the answer to it. The page draws it with
 * xterm.js and talks to it over a websocket (`termUpgrade`): keystrokes in, bytes out, and the size of the window.
 *
 * The pseudo-terminal is made by a small Python program (`PTY_HELPER`) rather than by a native Node module: the image
 * is built once for every CPU it runs on, a native module would be built for the wrong one, and Python is in the image
 * already (the PDF engine). The program only joins the shell's terminal to its own stdin and stdout, and takes the size
 * on a pipe of its own.
 *
 * What the agent shares with it:
 *   - the working directory: the shell's own (read from /proc where there is one), which is where the agent's next
 *     command starts, so a `cd` here carries over;
 *   - what the agent runs with its `terminal` tool is printed into the scrollback in a dim colour, marked as the agent's
 *     (it is not typed into the shell: the agent's tool still runs its own command, with its own output and exit code);
 *   - what the person ran is told to the agent once (`termNews`), best-effort, from the lines they sent with Enter.
 *
 * Everything is in memory and per chat (`dropTerm` ends the shell with the chat). A terminal can show a secret, so
 * scrollback is never written to disk, and the lines kept for the agent are blanked first.
 */
import type { Express, Request, Response } from "express";
import { spawn, type ChildProcess } from "node:child_process";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import fs from "node:fs";
import { WebSocketServer, type WebSocket } from "ws";
import { redactForModel, terminalDir, toolSettings } from "./tools";

/** Joins a shell's terminal to stdin/stdout. fd 3 (in) takes "R <cols> <rows>" lines; fd 4 (out) says "P <pid>" once. */
const PTY_HELPER = String.raw`
import os, pty, sys, select, fcntl, termios, struct, signal
cols, rows = int(sys.argv[1]), int(sys.argv[2])
shell, cwd = sys.argv[3], sys.argv[4]
pid, fd = pty.fork()
if pid == 0:
    try:
        os.chdir(cwd)
    except OSError:
        pass
    env = dict(os.environ)
    env["TERM"] = "xterm-256color"
    env["COLORTERM"] = "truecolor"
    env["SHELL"] = shell
    os.execvpe(shell, [shell, "-l", "-i"] if os.path.basename(shell) in ("bash", "zsh", "fish") else [shell, "-i"], env)
def size(c, r):
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", r, c, 0, 0))
        os.kill(pid, signal.SIGWINCH)
    except OSError:
        pass
size(cols, rows)
os.write(4, ("P %d\n" % pid).encode())
ctl = b""
code = 0
try:
    while True:
        r, _, _ = select.select([fd, 0, 3], [], [])
        if fd in r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                data = b""
            if not data:
                break
            os.write(1, data)
        if 0 in r:
            data = os.read(0, 65536)
            if not data:
                break
            os.write(fd, data)
        if 3 in r:
            data = os.read(3, 4096)
            if not data:
                break
            ctl += data
            while b"\n" in ctl:
                line, ctl = ctl.split(b"\n", 1)
                parts = line.split()
                if len(parts) == 3 and parts[0] == b"R":
                    size(int(parts[1]), int(parts[2]))
finally:
    try:
        os.kill(pid, signal.SIGHUP)
    except OSError:
        pass
    try:
        _, status = os.waitpid(pid, 0)
        code = os.waitstatus_to_exitcode(status)
    except OSError:
        pass
sys.exit(code if code >= 0 else 1)
`;

interface Shell {
  child: ChildProcess;
  /** The shell's own pid, for its working directory. */
  pid: number | null;
  decoder: StringDecoder;
  watchers: Set<WebSocket>;
  /** The newest output, replayed to a page that connects (or reconnects). */
  scrollback: string;
  /** The line being typed, as far as keystrokes can tell: what the person ran, for the agent. */
  typing: string;
}

interface Desk {
  open: boolean;
  since: number;
  cwd: string;
  rev: number;
  shell: Shell | null;
  /** What the person ran that the agent has not been told yet. */
  news: string[];
  /** The agent's command being printed, by id. */
  agentSeq: number;
}

/** What the window shows, and what the page is told over the socket. */
export interface TermState {
  open: boolean;
  since?: number;
  cwd?: string;
  rev?: number;
  running?: boolean;
}

const desks = new Map<string, Desk>();
const listeners = new Set<(session: string) => void>();

const SCROLLBACK = 400_000;
const validSession = (id: string) => /^[A-Za-z0-9_-]{1,80}$/.test(id);

function deskFor(session: string): Desk {
  let desk = desks.get(session);
  if (!desk) {
    desk = { open: false, since: 0, cwd: "", rev: 0, shell: null, news: [], agentSeq: 0 };
    desks.set(session, desk);
  }
  return desk;
}

const changed = (session: string) => { for (const l of listeners) l(session); };
export const onTermChange = (fn: (session: string) => void): (() => void) => {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
};

/** Where the shell is now: read from the system where it can be, otherwise where it was last known to be. */
function liveCwd(desk: Desk): string {
  const pid = desk.shell?.pid;
  if (pid) {
    try {
      const at = fs.readlinkSync(`/proc/${pid}/cwd`);
      if (at && fs.existsSync(at)) desk.cwd = at;
    } catch { /* no /proc here: the last known one */ }
  }
  return desk.cwd && fs.existsSync(desk.cwd) ? desk.cwd : terminalDir();
}

export function termState(session: string): TermState {
  const desk = desks.get(session);
  if (!desk?.open) return { open: false };
  return { open: true, since: desk.since, cwd: liveCwd(desk), rev: desk.rev, running: Boolean(desk.shell) };
}

function endShell(desk: Desk) {
  const shell = desk.shell;
  desk.shell = null;
  if (!shell) return;
  for (const ws of shell.watchers) { try { ws.close(); } catch { /* gone */ } }
  shell.watchers.clear();
  try { shell.child.kill("SIGKILL"); } catch { /* already gone */ }
}

export function dropTerm(session: string) {
  const desk = desks.get(session);
  if (desk) endShell(desk);
  desks.delete(session);
}

/** Where a command starts: the shell's directory once the Terminal window has been opened, otherwise the tool's own. */
export function termCwd(session: string): string | null {
  const desk = desks.get(session);
  return desk?.open ? liveCwd(desk) : null;
}

// ------------------------------------------------------------------- the shell --

const send = (ws: WebSocket, msg: Record<string, unknown>) => {
  if (ws.readyState === ws.OPEN) { try { ws.send(JSON.stringify(msg)); } catch { /* going away */ } }
};

/** Output, kept for a page that comes later, and shown to every page that is watching. */
function emit(shell: Shell, text: string) {
  if (!text) return;
  shell.scrollback += text;
  if (shell.scrollback.length > SCROLLBACK) {
    const cut = shell.scrollback.length - SCROLLBACK;
    const nl = shell.scrollback.indexOf("\n", cut);
    shell.scrollback = shell.scrollback.slice(nl >= 0 ? nl + 1 : cut);
  }
  for (const ws of shell.watchers) send(ws, { t: "out", d: text });
}

function shellProgram(): string {
  for (const candidate of [process.env.SHELL, "/bin/bash", "/bin/sh"]) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return "sh";
}

/** The session's shell, started if it is not running. Null (and the reason) if it cannot start. */
function shellFor(session: string, cols: number, rows: number): { shell: Shell } | { error: string } {
  if (!toolSettings().terminal.enabled) return { error: "The terminal is switched off on the Tools page." };
  const desk = deskFor(session);
  if (desk.shell) return { shell: desk.shell };
  const cwd = liveCwd(desk);
  let child: ChildProcess;
  try {
    child = spawn("python3", ["-I", "-c", PTY_HELPER, String(cols), String(rows), shellProgram(), cwd], {
      stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
      env: process.env,
    });
  } catch (err) {
    return { error: `The terminal could not start: ${err instanceof Error ? err.message : String(err)}` };
  }
  const shell: Shell = { child, pid: null, decoder: new StringDecoder("utf8"), watchers: new Set(), scrollback: "", typing: "" };
  desk.shell = shell;
  const note = child.stdio[4] as NodeJS.ReadableStream | null;
  note?.on("data", (chunk: Buffer) => {
    const m = /P (\d+)/.exec(chunk.toString());
    if (m) shell.pid = Number(m[1]);
  });
  child.stdout?.on("data", (chunk: Buffer) => emit(shell, shell.decoder.write(chunk)));
  child.stderr?.on("data", (chunk: Buffer) => emit(shell, shell.decoder.write(chunk)));
  const over = (code: number | null, why?: string) => {
    if (desk.shell !== shell) return;
    desk.shell = null;
    emit(shell, `\r\n\x1b[2m[${why ?? `the shell ended${code ? ` (exit ${code})` : ""}`} — type anything to start a new one]\x1b[0m\r\n`);
    for (const ws of shell.watchers) send(ws, { t: "exit", code });
    desk.rev += 1;
    changed(session);
  };
  child.on("exit", (code) => over(code));
  child.on("error", (err) => over(null, `the terminal could not start: ${err.message}`));
  for (const stream of [child.stdin, child.stdio[3]]) (stream as NodeJS.WritableStream | null)?.on("error", () => undefined);
  desk.rev += 1;
  changed(session);
  return { shell };
}

function resize(shell: Shell, cols: number, rows: number) {
  (shell.child.stdio[3] as NodeJS.WritableStream | null)?.write(`R ${cols} ${rows}\n`);
}

/** What the person types, as far as keystrokes can say what was run: a line ends with Enter. For the agent's news only. */
function noteTyping(session: string, shell: Shell, data: string) {
  const desk = desks.get(session);
  if (!desk) return;
  for (const ch of data) {
    if (ch === "\r" || ch === "\n") {
      const line = shell.typing.trim();
      shell.typing = "";
      if (line) {
        desk.news.push(`\`${redactForModel(line).replace(/\s+/g, " ").slice(0, 160)}\``);
        if (desk.news.length > 40) desk.news.shift();
      }
    } else if (ch === "\x7f" || ch === "\b") {
      shell.typing = shell.typing.slice(0, -1);
    } else if (ch === "\x03" || ch === "\x15" || ch === "\x1b") {
      // Cancelled, or an escape sequence (an arrow, a function key): the line is no longer what was typed.
      shell.typing = "";
    } else if (ch >= " " && shell.typing.length < 2000) {
      shell.typing += ch;
    }
  }
}

let sockets: WebSocketServer | null = null;
let exists: (id: string) => boolean = () => false;

/**
 * A page connecting its terminal: `/api/term/ws?session=<id>&cols=&rows=`. Answers an upgrade rather than listening for
 * one (Autora has a single socket server, fed by hand in server.ts). `allow` is the cross-site check every socket
 * passes. Returns true when the request was this one's, taken or refused.
 */
export function termUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, allow: (headers: IncomingMessage["headers"]) => boolean): boolean {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/api/term/ws") return false;
  const session = url.searchParams.get("session") ?? "";
  if (!allow(req.headers) || !validSession(session) || !exists(session)) {
    socket.destroy();
    return true;
  }
  const num = (key: string, lo: number, hi: number, fallback: number) => {
    const n = Math.trunc(Number(url.searchParams.get(key)));
    return Number.isFinite(n) && n >= lo ? Math.min(hi, n) : fallback;
  };
  const cols = num("cols", 2, 500, 80);
  const rows = num("rows", 2, 200, 24);
  sockets ??= new WebSocketServer({ noServer: true });
  sockets.handleUpgrade(req, socket, head, (ws) => {
    const attach = (): Shell | null => {
      const made = shellFor(session, cols, rows);
      if ("error" in made) { send(ws, { t: "out", d: `\x1b[31m${made.error}\x1b[0m\r\n` }); return null; }
      return made.shell;
    };
    let shell = attach();
    if (shell) {
      shell.watchers.add(ws);
      resize(shell, cols, rows);
      if (shell.scrollback) send(ws, { t: "out", d: shell.scrollback });
    }
    send(ws, { t: "ready", running: Boolean(shell) });
    ws.on("message", (raw) => {
      let msg: { t?: string; d?: unknown; cols?: unknown; rows?: unknown };
      try { msg = JSON.parse(String(raw)); } catch { return; }
      const desk = desks.get(session);
      if (!desk) return;
      // A shell that ended starts again on the next key.
      if (!desk.shell && msg.t === "in") {
        shell = attach();
        if (shell) { shell.watchers.add(ws); send(ws, { t: "ready", running: true }); }
      }
      const live = desk.shell;
      if (!live) return;
      if (msg.t === "in" && typeof msg.d === "string" && msg.d.length <= 100_000) {
        noteTyping(session, live, msg.d);
        (live.child.stdin as NodeJS.WritableStream | null)?.write(msg.d);
      } else if (msg.t === "size") {
        const c = Math.trunc(Number(msg.cols));
        const r = Math.trunc(Number(msg.rows));
        if (c >= 2 && c <= 500 && r >= 2 && r <= 200) resize(live, c, r);
      }
    });
    const gone = () => { desks.get(session)?.shell?.watchers.delete(ws); };
    ws.on("close", gone);
    ws.on("error", gone);
  });
  return true;
}

// ------------------------------------------------------------ the agent's side --

/** The agent starts a command in its terminal tool: it is printed into the window, marked as the agent's. */
export function termAgentBegin(session: string, command: string, _cwd: string): number {
  const desk = deskFor(session);
  const id = ++desk.agentSeq;
  const shell = desk.shell;
  if (shell) emit(shell, `\r\n\x1b[2;35m[Autora] $ ${redactForModel(command).replace(/\r?\n/g, "\r\n  ")}\x1b[0m\r\n`);
  return id;
}

export function termAgentChunk(session: string, _id: number, text: string) {
  const shell = desks.get(session)?.shell;
  if (shell && text) emit(shell, `\x1b[2m${text.replace(/\r?\n/g, "\r\n")}\x1b[0m`);
}

export function termAgentEnd(session: string, _id: number, exit: number | undefined) {
  const shell = desks.get(session)?.shell;
  if (shell) emit(shell, `\r\n\x1b[2;35m[Autora] ${exit === 0 || exit === undefined ? "done" : `exit ${exit}`}\x1b[0m\r\n`);
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

// -------------------------------------------------------------------- routes --

export function termRoutes(app: Express, deps: { exists: (id: string) => boolean }) {
  exists = deps.exists;
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

  /* Put away: the window goes, and so does the shell in it (a terminal left running in a tab nobody can see is a
     process nobody knows about). Opening it again starts a new one, in the folder the last one was in. */
  app.post("/api/term/:session/close", (req, res) => {
    const id = known(req, res);
    if (!id) return;
    const desk = deskFor(id);
    liveCwd(desk);
    desk.open = false;
    endShell(desk);
    changed(id);
    res.json({ ok: true });
  });
}
