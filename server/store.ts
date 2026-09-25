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
  /** Where the log had got to, and what is in it. Written whenever the log is
      flushed, so a session can be listed, sorted and counted without reading
      a single line of it -- which is the difference between a restart that
      parses every thread ever recorded and one that reads a few hundred
      bytes per session. Missing on sessions written before this existed; the
      counters are then filled in once, from the log, and stored. */
  counts?: SessionCounts;
}

/** What a session's log holds, without holding the log. */
export interface SessionCounts {
  /** The highest seq in it. */
  seq: number;
  /** Milliseconds since the epoch, of the last event. */
  lastTs: number;
  events: number;
  turns: number;
  tools: number;
  errors: number;
}

export interface StoredSession<E> extends StoredMeta {
  events: E[];
}

const pendingLines = new Map<string, string[]>();
let lineTimer: NodeJS.Timeout | null = null;

/* One counts object per session, handed out by countsFor and shared with
   whoever asked: the loader keeps the tallies on the session it builds, and
   every appended event moves the same object, so what is written here is
   always what the app is showing. */
const countsCache = new Map<string, SessionCounts>();

function flushLines() {
  if (lineTimer) clearTimeout(lineTimer);
  lineTimer = null;
  for (const [id, lines] of pendingLines) {
    try {
      const dir = path.join(SESSIONS(), id);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.appendFileSync(path.join(dir, "events.jsonl"), lines.join(""), { mode: 0o600 });
      persistCounts(id);
    } catch (err) {
      warn(`could not save events for ${id}`, err);
    }
  }
  pendingLines.clear();
}

/** Write the tallies into meta.json, beside the fields that were already
    there. Called as the log is flushed, so a session's meta.json is always a
    summary of the log next to it. */
function persistCounts(id: string) {
  const counts = countsCache.get(id);
  if (!counts) return;
  try {
    const file = path.join(SESSIONS(), id, "meta.json");
    const meta = JSON.parse(fs.readFileSync(file, "utf8")) as StoredMeta;
    const next = { ...meta, id, counts };
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    warn(`could not write the counts for ${id}`, err);
  }
}

/**
 * What a session's log holds: from memory, else from meta.json, else by
 * reading the log once and storing the answer. Every caller gets the same
 * object, so a session whose tallies have been handed out keeps them current
 * as events are appended rather than asking again.
 */
export function countsFor(id: string): SessionCounts {
  const held = countsCache.get(id);
  if (held) return held;
  let counts: SessionCounts | undefined;
  try {
    counts = (JSON.parse(
      fs.readFileSync(path.join(SESSIONS(), id, "meta.json"), "utf8"),
    ) as StoredMeta).counts;
  } catch {
    counts = undefined;
  }
  if (!counts) {
    counts = countsOf(loadSessionEvents<{ seq?: number; ts?: number; kind?: string }>(id));
    const written = { ...counts };
    countsCache.set(id, written);
    persistCounts(id);
    return written;
  }
  /* Field by field, so a meta.json written by an older build -- which has
     some of these and not others -- comes up whole. */
  const merged: SessionCounts = {
    seq: Number(counts.seq) || 0,
    lastTs: Number(counts.lastTs) || 0,
    events: Number(counts.events) || 0,
    turns: Number(counts.turns) || 0,
    tools: Number(counts.tools) || 0,
    errors: Number(counts.errors) || 0,
  };
  countsCache.set(id, merged);
  return merged;
}

/** One event, folded into its session's tallies. */
function countEvent(id: string, event: { seq?: number; ts?: number; kind?: string }) {
  const counts = countsFor(id);
  const seq = Number(event?.seq) || 0;
  if (seq > counts.seq) counts.seq = seq;
  const ts = Number(event?.ts) || 0;
  if (ts > counts.lastTs) counts.lastTs = ts;
  counts.events += 1;
  if (event?.kind === "turn.user") counts.turns += 1;
  else if (event?.kind === "tool.call") counts.tools += 1;
  else if (event?.kind === "tool.error" || event?.kind === "system.error") counts.errors += 1;
}

/** Forget a session's tallies, when the session goes. */
export function forgetCounts(id: string) {
  countsCache.delete(id);
}

/**
 * Add one event to a session's log on disk, and move the tallies that go with
 * it. The event is counted here rather than by the caller so that the summary
 * in meta.json cannot drift from the log it summarises, whoever appends.
 */
export function appendEvent(id: string, event: unknown) {
  if (!safeId(id)) return;
  const lines = pendingLines.get(id) ?? [];
  lines.push(`${JSON.stringify(event)}\n`);
  pendingLines.set(id, lines);
  countEvent(id, event as { seq?: number; ts?: number; kind?: string });
  if (lineTimer) return;
  lineTimer = setTimeout(flushLines, 250);
  lineTimer.unref?.();
}

/** Save what can change about a session. The tallies are merged in rather
    than expected from the caller: a rename must not lose the summary of a
    log, which would put the next start back to reading the whole thing. */
export function saveMeta(meta: StoredMeta) {
  if (!safeId(meta.id)) return;
  const counts = meta.counts ?? countsCache.get(meta.id);
  if (counts) countsCache.set(meta.id, counts);
  try {
    writeAtomic(
      path.join(SESSIONS(), meta.id, "meta.json"),
      JSON.stringify(counts ? { ...meta, counts } : meta, null, 2),
    );
  } catch (err) {
    warn(`could not save session ${meta.id}`, err);
  }
}

/** Save a whole session at once: for one built in memory before it was stored. */
export function saveSession<E>(session: StoredSession<E>) {
  if (!safeId(session.id)) return;
  pendingLines.delete(session.id);
  if (session.counts) countsCache.set(session.id, session.counts);
  saveMeta({
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    pinned: session.pinned,
    ...(session.counts ? { counts: session.counts } : {}),
  });
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
  countsCache.delete(id);
  try {
    fs.rmSync(path.join(SESSIONS(), id), { recursive: true, force: true });
  } catch (err) {
    warn(`could not delete session ${id}`, err);
  }
}

/**
 * Every stored session, without its events.
 *
 * Reading `events.jsonl` is where the old boot went: parsing tens of
 * thousands of lines to build threads nobody had asked to see yet, on every
 * start -- and on Umbrel every update is a start. The listing only needs what
 * meta.json holds; the log itself is read when a session is opened.
 */
export function loadSessionIndex(): StoredMeta[] {
  let ids: string[];
  try {
    ids = fs.readdirSync(SESSIONS());
  } catch {
    return [];
  }
  const out: StoredMeta[] = [];
  for (const id of ids) {
    if (!safeId(id)) continue;
    try {
      const meta = JSON.parse(
        fs.readFileSync(path.join(SESSIONS(), id, "meta.json"), "utf8"),
      ) as StoredMeta;
      if (!meta || typeof meta !== "object") continue;
      out.push({ ...meta, id });
    } catch (err) {
      warn(`could not read ${id}/meta.json`, err);
    }
  }
  return out;
}

/**
 * One session's events, in order. A torn last line -- the process died
 * mid-write -- is dropped rather than losing the thread over it.
 */
export function loadSessionEvents<E>(id: string): E[] {
  if (!safeId(id)) return [];
  let raw = "";
  try {
    raw = fs.readFileSync(path.join(SESSIONS(), id, "events.jsonl"), "utf8");
  } catch {
    return [];
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
  return events;
}

/**
 * What a session's log holds, for a session whose meta.json does not say.
 *
 * Read once per session, ever: the answer is stored in meta.json so the next
 * start does not have to look.
 */
export function countSession<E extends { seq?: number; ts?: number; kind?: string }>(
  id: string,
): SessionCounts {
  return countsOf(loadSessionEvents<E>(id));
}

/** The same count, for events already in hand. */
export function countsOf<E extends { seq?: number; ts?: number; kind?: string }>(
  events: E[],
): SessionCounts {
  const counts: SessionCounts = { seq: 0, lastTs: 0, events: events.length, turns: 0, tools: 0, errors: 0 };
  for (const e of events) {
    const seq = Number(e?.seq) || 0;
    if (seq > counts.seq) counts.seq = seq;
    const ts = Number(e?.ts) || 0;
    if (ts > counts.lastTs) counts.lastTs = ts;
    if (e?.kind === "turn.user") counts.turns += 1;
    else if (e?.kind === "tool.call") counts.tools += 1;
    else if (e?.kind === "tool.error" || e?.kind === "system.error") counts.errors += 1;
  }
  return counts;
}

/** Every session folder, what it weighs and when it was last touched, for the
    retention sweep. Sizes are of the whole folder, log included. */
export function sessionFolders(): { id: string; bytes: number; modified: number; pinned: boolean }[] {
  let ids: string[];
  try {
    ids = fs.readdirSync(SESSIONS());
  } catch {
    return [];
  }
  const out: { id: string; bytes: number; modified: number; pinned: boolean }[] = [];
  for (const id of ids) {
    if (!safeId(id)) continue;
    const dir = path.join(SESSIONS(), id);
    let bytes = 0;
    let modified = 0;
    try {
      const walk = (where: string) => {
        for (const entry of fs.readdirSync(where, { withFileTypes: true })) {
          const full = path.join(where, entry.name);
          if (entry.isDirectory()) walk(full);
          else {
            const stat = fs.statSync(full);
            bytes += stat.size;
            if (stat.mtimeMs > modified) modified = stat.mtimeMs;
          }
        }
      };
      walk(dir);
    } catch {
      continue;
    }
    let pinned = false;
    try {
      pinned = Boolean(JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")).pinned);
    } catch {
      // A folder with no readable meta.json is still a folder to account for.
    }
    out.push({ id, bytes, modified, pinned });
  }
  return out;
}

/* ---- the vault, on disk --------------------------------------------------

   A too-long tool output is kept whole in a vault and referred to by id, so
   the model can read it back with vault_read. That vault lived in memory and
   went down with the process, while the turn note that mentions the id is in
   the log and comes back after a restart -- so the reference outlived the
   thing it referred to and vault_read answered "no such artifact". The text
   is written beside the session now, and read back from there.
*/

const VAULT_DIR = "vault";

/** Ids are only ever ours: hex, fixed length, nothing a request can turn into
    a path. */
function safeArtifactId(id: string): string | null {
  return /^art_[0-9a-f]{1,32}$/.test(id) ? id : null;
}

export function saveVaultText(sessionId: string, id: string, text: string) {
  const safe = safeId(sessionId) && safeArtifactId(id);
  if (!safe) return;
  try {
    const dir = path.join(SESSIONS(), sessionId, VAULT_DIR);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeAtomic(path.join(dir, id), text);
  } catch (err) {
    warn(`could not store vault artifact ${id}`, err);
  }
}

export function readVaultText(sessionId: string, id: string): string | null {
  if (!safeId(sessionId) || !safeArtifactId(id)) return null;
  try {
    return fs.readFileSync(path.join(SESSIONS(), sessionId, VAULT_DIR, id), "utf8");
  } catch {
    return null;
  }
}

/** Write everything still queued. Called on the way out. */
export function flushStore() {
  flushLines();
  flushDocs();
}
