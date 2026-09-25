/**
 * What the server has been doing, kept where the Logs page can read it.
 *
 * A ring buffer of structured lines -- time, level, component, message --
 * fed from three places: anything printed to the console (so nothing that
 * used to go only to `docker logs` is lost), API requests that failed, and
 * the agent's own activity (turns, tool calls, errors, Jev decisions), which
 * server.ts reports as it emits the events the thread is built from.
 *
 * In memory only, unlike the sessions themselves: enough to answer "what just
 * happened" without writing a log file into the one directory Umbrel keeps.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogLine {
  id: number;
  ts: number;
  level: LogLevel;
  component: string;
  message: string;
  session?: string;
}

const MAX_LINES = 5000;
const lines: LogLine[] = [];
let nextId = 1;

/* What blanks secrets out of a line, handed in by the server so this module
   depends on nothing: the Logs page shows what an MCP server printed to
   stderr and what a vendor's error said, and either can carry a key. */
let redactor: ((text: string) => string) | null = null;
let redacting = false;

export function setLogRedactor(fn: ((text: string) => string) | null) {
  redactor = fn;
}

function clean(text: string): string {
  // The redactor may itself warn (an unreadable credentials file); that
  // warning comes back through here and must not recurse.
  if (!redactor || redacting) return text;
  redacting = true;
  try {
    return redactor(text);
  } catch {
    return text;
  } finally {
    redacting = false;
  }
}

export function log(level: LogLevel, component: string, message: string, session?: string) {
  const text = clean(String(message ?? ""));
  const line: LogLine = {
    id: nextId++,
    ts: Date.now(),
    level,
    component: component || "server",
    message: text.length > 2000 ? `${text.slice(0, 2000)}…` : text,
    ...(session ? { session } : {}),
  };
  lines.push(line);
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
}

export interface LogQuery {
  level?: LogLevel;
  component?: string;
  q?: string;
  after?: number;
  limit?: number;
}

const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Newest last. `level` is a floor: "warn" returns warnings and errors. */
export function readLogs(query: LogQuery = {}) {
  const floor = query.level ? RANK[query.level] : 0;
  const needle = query.q?.trim().toLowerCase();
  const limit = Math.min(Math.max(query.limit ?? 500, 1), 2000);
  const out: LogLine[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const l = lines[i];
    if (query.after !== undefined && l.id <= query.after) break;
    if (RANK[l.level] < floor) continue;
    if (query.component && l.component !== query.component) continue;
    if (needle && !`${l.component} ${l.message}`.toLowerCase().includes(needle)) continue;
    out.push(l);
  }
  const components = [...new Set(lines.map((l) => l.component))].sort();
  return { lines: out.reverse(), components, latest: nextId - 1 };
}

let patched = false;

/**
 * Mirror the console into the buffer. "[browser] ready" becomes component
 * "browser", message "ready"; anything else is component "server".
 */
export function captureConsole() {
  if (patched) return;
  patched = true;
  const wrap = (method: "log" | "info" | "warn" | "error", level: LogLevel) => {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      original(...args);
      try {
        const text = args
          .map((a) => (typeof a === "string" ? a : a instanceof Error ? a.stack ?? a.message : safeJson(a)))
          .join(" ");
        const tagged = /^\[([\w .:-]+)\]\s*([\s\S]*)$/.exec(text);
        log(level, tagged ? tagged[1] : "server", tagged ? tagged[2] : text);
      } catch {
        /* logging must never throw */
      }
    };
  };
  wrap("log", "info");
  wrap("info", "info");
  wrap("warn", "warn");
  wrap("error", "error");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
