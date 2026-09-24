/**
 * Sessions, memories and scheduled jobs, on disk.
 *
 * These used to be module-level arrays in server.ts, which meant every
 * restart -- and on Umbrel every update is a restart -- quietly emptied the
 * thread list, forgot everything the agent had written down, and put the demo
 * memories back. They now live beside the settings file, in the directory the
 * container keeps across an update.
 *
 * A session is a folder: `meta.json` for what can change (title, pin) and
 * `events.jsonl` for the log, which only ever grows, so an event costs one
 * appended line rather than a rewrite of the whole thread. Lines are queued
 * and written in batches, because a streamed reply is dozens of events a
 * second. Memories and jobs are small and are rewritten whole, a moment after
 * the last change.
 *
 * Pictures are not kept: they live in ./blobs, in memory, and a thread read
 * back after a restart shows where they were rather than what they showed.
 */

import fs from "node:fs";
import path from "node:path";
import { stateDir } from "./state";

const SESSIONS = () => path.join(stateDir(), "sessions");

/** Anything that becomes a path must not be able to leave the directory. */
function safeId(id: string): string | null {
  return /^[A-Za-z0-9_-]{1,120}$/.test(id) ? id : null;
}

function writeAtomic(file: string, body: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function warn(what: string, err: any) {
  console.warn(`[store] ${what}: ${err?.message ?? err}`);
}

// --------------------------------------------------------------- documents --

const pendingDocs = new Map<string, () => unknown>();
let docTimer: NodeJS.Timeout | null = null;

/** Read `<name>.json` from the state directory; null when absent or unreadable. */
export function readDoc<T>(name: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(stateDir(), `${name}.json`), "utf8")) as T;
  } catch (err: any) {
    if (err?.code !== "ENOENT") warn(`could not read ${name}.json`, err);
    return null;
  }
}

/** Write `<name>.json` shortly, from whatever `get` returns then. */
export function saveDoc(name: string, get: () => unknown) {
  pendingDocs.set(name, get);
  if (docTimer) return;
  docTimer = setTimeout(flushDocs, 500);
  docTimer.unref?.();
}

function flushDocs() {
  if (docTimer) clearTimeout(docTimer);
  docTimer = null;
  for (const [name, get] of pendingDocs) {
    try {
      writeAtomic(path.join(stateDir(), `${name}.json`), JSON.stringify(get(), null, 2));
    } catch (err) {
      warn(`could not save ${name}.json`, err);
    }
  }
  pendingDocs.clear();
}

// ---------------------------------------------------------------- sessions --

export interface StoredMeta {
  id: string;
  title: string;
  createdAt: number;
  pinned?: boolean;
}

export interface StoredSession<E> extends StoredMeta {
  events: E[];
}

const pendingLines = new Map<string, string[]>();
let lineTimer: NodeJS.Timeout | null = null;

function flushLines() {
  if (lineTimer) clearTimeout(lineTimer);
  lineTimer = null;
  for (const [id, lines] of pendingLines) {
    try {
      const dir = path.join(SESSIONS(), id);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.appendFileSync(path.join(dir, "events.jsonl"), lines.join(""), { mode: 0o600 });
    } catch (err) {
      warn(`could not save events for ${id}`, err);
    }
  }
  pendingLines.clear();
}

/** Add one event to a session's log on disk. */
export function appendEvent(id: string, event: unknown) {
  if (!safeId(id)) return;
  const lines = pendingLines.get(id) ?? [];
  lines.push(`${JSON.stringify(event)}\n`);
  pendingLines.set(id, lines);
  if (lineTimer) return;
  lineTimer = setTimeout(flushLines, 250);
  lineTimer.unref?.();
}

/** Save what can change about a session. */
export function saveMeta(meta: StoredMeta) {
  if (!safeId(meta.id)) return;
  try {
    writeAtomic(path.join(SESSIONS(), meta.id, "meta.json"), JSON.stringify(meta, null, 2));
  } catch (err) {
    warn(`could not save session ${meta.id}`, err);
  }
}

/** Save a whole session at once: for one built in memory before it was stored. */
export function saveSession<E>(session: StoredSession<E>) {
  if (!safeId(session.id)) return;
  pendingLines.delete(session.id);
  saveMeta({ id: session.id, title: session.title, createdAt: session.createdAt, pinned: session.pinned });
  try {
    writeAtomic(
      path.join(SESSIONS(), session.id, "events.jsonl"),
      session.events.map((e) => `${JSON.stringify(e)}\n`).join(""),
    );
  } catch (err) {
    warn(`could not save session ${session.id}`, err);
  }
}

export function deleteSession(id: string) {
  if (!safeId(id)) return;
  pendingLines.delete(id);
  try {
    fs.rmSync(path.join(SESSIONS(), id), { recursive: true, force: true });
  } catch (err) {
    warn(`could not delete session ${id}`, err);
  }
}

/** Every stored session, events in order. A torn last line -- the process
    died mid-write -- is dropped rather than losing the thread over it. */
export function loadSessions<E>(): StoredSession<E>[] {
  let ids: string[];
  try {
    ids = fs.readdirSync(SESSIONS());
  } catch {
    return [];
  }
  const out: StoredSession<E>[] = [];
  for (const id of ids) {
    if (!safeId(id)) continue;
    const dir = path.join(SESSIONS(), id);
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")) as StoredMeta;
      let raw = "";
      try {
        raw = fs.readFileSync(path.join(dir, "events.jsonl"), "utf8");
      } catch {
        // A session with no events yet.
      }
      const events: E[] = [];
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          events.push(JSON.parse(line) as E);
        } catch {
          // Skip it; the rest of the thread is still worth having.
        }
      }
      out.push({ ...meta, id, events });
    } catch (err) {
      warn(`could not load session ${id}`, err);
    }
  }
  return out;
}

/** Write everything still queued. Called on the way out. */
export function flushStore() {
  flushLines();
  flushDocs();
}
