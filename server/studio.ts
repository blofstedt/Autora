/**
 * Autora Studio: the music window, and the agent's hands on the same song.
 *
 * One song per chat. It lives here (the song is plain JSON, src/lib/studio/model.ts), and:
 *
 *   - the agent's `studio_*` tools edit it (`runStudioTool`), and every change is announced to the window, which
 *     loads the new song and shows the clips that moved;
 *   - the person works in the window (src/components/StudioWindow.tsx, which also plays it: the sound is Web
 *     Audio, made on the person's device) and what they change is put back here (`PUT /api/studio/:session/doc`),
 *     so the agent's next look sees it.
 *
 * Who made a change travels with it (`by`): the window reloads the song for the agent's changes and never for its
 * own person's, so a note being dragged is not interrupted by an echo of itself. A person's save that was based on
 * an older song than the agent has since changed is refused (409) rather than allowed to undo the agent's work
 * unseen; the window loads the newer one and says so.
 *
 * The three things only a browser can do -- make sound, stop it, bounce the song to a file -- are commands to the open
 * window (`command`), which does them and answers. The agent cannot hear; playing is for the person.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { type Express, type Request, type Response } from "express";
import {
  addNotes, barBeat, BASS_STYLES, bassNotes, CHORD_STYLES, chordLabel, chordNotes, clamp, copyClip, describeProject, detectChord,
  DRUM_STYLES, drumNotes, findClip, findTrack, fitBars, humanize, INSTRUMENTS, instrumentOf, isDrumTrack, keyName, MAX_BARS, MAX_BPM,
  MAX_CLIPS_PER_TRACK, MAX_TRACKS, MIN_BPM, newClip, newProject, newTrack, normalizeProject, notesIn, parseDrum, parseKey,
  parsePitch, parseProgression, quantize, review, songBeats, tidy, uid,
  type BassStyle, type Chord, type ChordStyle, type Clip, type DrumStyle, type InstrumentId, type Note, type Project, type Track,
} from "../src/lib/studio/model";
import { MAX_ARTIFACT_BYTES, saveArtifact } from "./artifacts";
import { stateDir } from "./state";
import { readDoc, saveDoc } from "./store";

// ------------------------------------------------------------------ state --

/** What the page knows about the window: small, because it is sent on every change. */
interface StudioState {
  open: boolean;
  /** When the window was opened, which orders it among the others. */
  since?: number;
  /** Goes up on every change to the song, by anyone. */
  rev?: number;
  /** Who made the latest change. */
  by?: "agent" | "person";
  name?: string;
  bpm?: number;
  tracks?: number;
}

interface Focus {
  trackId: string | null;
  clipId: string | null;
}

interface Entry {
  project: Project;
  open: boolean;
  since: number;
  rev: number;
  by: "agent" | "person";
  focus: Focus;
  /** The window has said its page is up and can take commands. */
  ready: boolean;
}

interface Saved {
  project: Project;
  open: boolean;
  since: number;
}

const entries = new Map<string, Entry>();
const listeners = new Set<(session: string) => void>();
let pushed: (session: string, message: Record<string, unknown>) => void = () => undefined;

const validSession = (id: string) => /^[A-Za-z0-9_-]{1,80}$/.test(id);
const savedName = (session: string) => `studio-${session}`;

function entryFor(session: string): Entry {
  let entry = entries.get(session);
  if (!entry) {
    const saved = validSession(session) ? readDoc<Saved>(savedName(session)) : null;
    entry = {
      project: (saved && normalizeProject(saved.project)) || newProject("My song"),
      open: Boolean(saved?.open),
      since: saved?.since ?? 0,
      // From the clock, not from 0: a window left open across a restart remembers a revision, and must find a newer one.
      rev: Date.now(),
      by: "agent",
      focus: { trackId: null, clipId: null },
      ready: false,
    };
    entries.set(session, entry);
  }
  return entry;
}

function persist(session: string, entry: Entry) {
  if (!validSession(session)) return;
  saveDoc(savedName(session), () => ({ project: entry.project, open: entry.open, since: entry.since }) satisfies Saved);
}

function changed(session: string) {
  for (const fn of listeners) fn(session);
}

export function studioState(session: string): StudioState {
  if (!validSession(session)) return { open: false };
  const e = entryFor(session);
  if (!e.open) return { open: false };
  return { open: true, since: e.since, rev: e.rev, by: e.by, name: e.project.name, bpm: e.project.bpm, tracks: e.project.tracks.length };
}

/** Told after every change to a chat's window or song, so the page can be told. */
export function onStudioChange(fn: (session: string) => void) {
  listeners.add(fn);
}

function setOpen(session: string, open: boolean) {
  const e = entryFor(session);
  if (e.open === open) return;
  e.open = open;
  e.ready = false;
  if (open) e.since = Date.now();
  else rejectAll(session, "The music window was closed.");
  persist(session, e);
  changed(session);
}

/** A change to the song by `who`: kept, saved and announced. */
function commit(session: string, e: Entry, next: Project, who: "agent" | "person") {
  fitBars(next);
  e.project = next;
  e.rev++;
  e.by = who;
  persist(session, e);
  changed(session);
}

/** The chat is gone: let go of its song, and of the file it was kept in. */
export function dropStudio(session: string) {
  rejectAll(session, "The chat was closed.");
  entries.delete(session);
  if (!validSession(session)) return;
  fs.rmSync(path.join(stateDir(), `${savedName(session)}.json`), { force: true });
}

/** What the agent is told at the start of a turn when the window is open. */
export function studioTurnNote(session: string): string | null {
  if (!validSession(session)) return null;
  const e = entries.get(session);
  if (!e?.open) return null;
  const p = e.project;
  const made = p.tracks.reduce((n, t) => n + t.clips.reduce((m, c) => m + c.notes.length, 0), 0);
  const hit = e.focus.clipId ? findClip(p, e.focus.clipId) : null;
  const watching = hit ? ` The person has the clip ${hit.clip.id} ("${hit.clip.name}", ${hit.track.name}) open in the editor.` : "";
  return `The music window is open on "${p.name}" (${p.bpm} bpm, ${keyName(p.key)}, ${p.tracks.length} track${p.tracks.length === 1 ? "" : "s"}, ${made} notes).${watching} studio_look shows it; the person edits it by hand too, so look again before you rely on what you saw earlier.`;
}

/** The capability line for the system prompt. As short as it can be: it is paid for on every turn, and the tools carry their own guidance. */
export function studioBriefing(on: boolean): string {
  if (!on) return "- Autora Studio (music window): switched off on the Tools page; if asked, say so.";
  return "- Autora Studio (music window): studio_* tools (tools_enable studio). Music is theirs: suggest, ask; backing when asked, a melody only when asked.";
}

// --------------------------------------------------------------- commands --

type Pending = { session: string; resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; claimed: boolean };
const pending = new Map<string, Pending>();

function rejectAll(session: string, why: string) {
  for (const [id, p] of pending) {
    if (p.session !== session) continue;
    clearTimeout(p.timer);
    pending.delete(id);
    p.reject(new Error(why));
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Ask the open window to do something only a browser can, and wait for what it says. */
async function command(session: string, name: string, args: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<unknown> {
  setOpen(session, true);
  const e = entryFor(session);
  // The page loads after the window opens: give it time to say it is up.
  for (let waited = 0; !e.ready && waited < 20_000; waited += 150) await sleep(150);
  if (!e.ready) throw new Error("The music window did not start. It opens in the browser tab for this chat; if no tab is open, open Autora there and try again.");
  const id = crypto.randomBytes(6).toString("hex");
  return await new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`The music window did not answer ${name} in ${Math.round(timeoutMs / 1000)} seconds.`));
    }, timeoutMs);
    const entry: Pending = { session, resolve, reject, timer, claimed: false };
    pending.set(id, entry);
    const send = () => pushed(session, { type: "studio.command", session, id, name, args });
    send();
    // The same chat open in two tabs hears it twice and the first to claim does it; one that missed it is sent it again.
    const again = setInterval(() => {
      if (entry.claimed || !pending.has(id)) clearInterval(again);
      else send();
    }, 1500);
    const settle = entry.resolve;
    entry.resolve = (v) => { clearInterval(again); settle(v); };
    const refuse = entry.reject;
    entry.reject = (err) => { clearInterval(again); refuse(err); };
  });
}

// ------------------------------------------------------------------ tools --

interface StudioHooks {
  showFile?: (file: { id: string; name: string; mime: string; size: number }) => void;
}

interface StudioOutcome {
  ok: boolean;
  summary: string;
  preview?: string;
}

const fmt = (n: number) => `${Math.round(n * 100) / 100}`;

const GRIDS: Record<string, number> = { "1/1": 4, "1/2": 2, "1/4": 1, "1/8": 0.5, "1/16": 0.25, "1/32": 0.125, "1/4t": 2 / 3, "1/8t": 1 / 3, "1/16t": 1 / 6 };

class Refuse extends Error {}
const refuse = (message: string): never => { throw new Refuse(message); };

const numberOr = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

/** Where something starts, in beats: `start` (0-based beats) or `bar` (1-based, fractions allowed). */
function startOf(p: Project, args: Record<string, any>, fallback: number | null): number {
  const start = numberOr(args.start);
  if (start !== null) return tidy(Math.max(0, start));
  const bar = numberOr(args.bar);
  if (bar !== null) return tidy(Math.max(0, (bar - 1) * p.beatsPerBar));
  if (fallback === null) return refuse("Say where: `bar` (1 is the first bar) or `start` (in beats).");
  return fallback;
}

function lengthOf(p: Project, args: Record<string, any>, fallback: number | null): number {
  const length = numberOr(args.length);
  if (length !== null) return tidy(Math.max(0.25, length));
  const bars = numberOr(args.bars);
  if (bars !== null) return tidy(Math.max(0.25, bars * p.beatsPerBar));
  if (fallback === null) return refuse("Say how long: `bars` or `length` (in beats).");
  return fallback;
}

/** Notes as the agent writes them, checked: a drum track takes drum names, the others note names. */
function readNotes(track: Track, raw: unknown): { notes: Array<Omit<Note, "id">>; problems: string[] } {
  const notes: Array<Omit<Note, "id">> = [];
  const problems: string[] = [];
  if (!Array.isArray(raw)) return { notes, problems: ["`notes` must be a list of {pitch, start, length, vel}."] };
  const drums = isDrumTrack(track);
  raw.forEach((n, i) => {
    if (!n || typeof n !== "object") return void problems.push(`note ${i + 1} is not an object`);
    const pitch = drums ? parseDrum((n as any).pitch) ?? parsePitch((n as any).pitch) : parsePitch((n as any).pitch);
    const start = numberOr((n as any).start);
    if (pitch === null || pitch < 0 || pitch > 127) return void problems.push(`note ${i + 1}: "${String((n as any).pitch)}" is not a ${drums ? "drum (kick, snare, hat...) or note" : "note"}`);
    if (start === null) return void problems.push(`note ${i + 1}: start (in beats) is required`);
    notes.push({ pitch, start, length: numberOr((n as any).length) ?? (drums ? 0.25 : 1), vel: numberOr((n as any).vel) ?? 0.8 });
  });
  return { notes, problems };
}

const needTrack = (p: Project, ref: unknown): Track => findTrack(p, ref) ?? refuse(
  `There is no track "${String(ref ?? "")}". ${p.tracks.length ? `Tracks: ${p.tracks.map((t) => `${t.id} "${t.name}"`).join("; ")}.` : "There are no tracks yet (studio_track add)."}`);

const needClip = (p: Project, ref: unknown): { track: Track; clip: Clip } => findClip(p, ref) ?? refuse(
  `There is no clip "${String(ref ?? "")}". Clip ids are in studio_look.`);

function parseGrid(v: unknown): number {
  const g = typeof v === "string" ? GRIDS[v.trim().toLowerCase()] : typeof v === "number" ? v : undefined;
  return g && g > 0 ? g : refuse(`grid is one of ${Object.keys(GRIDS).join(", ")}.`);
}

/** A pitch window for remove/transpose/velocity: notes between `from`/`to` beats and `low`/`high` pitch, or the whole clip. */
function windowOf(clip: Clip, track: Track, args: Record<string, any>): Note[] {
  const from = numberOr(args.from) ?? 0;
  const to = numberOr(args.to) ?? clip.length;
  const low = args.low === undefined ? -Infinity : (isDrumTrack(track) ? parseDrum(args.low) : null) ?? parsePitch(args.low) ?? -Infinity;
  const high = args.high === undefined ? Infinity : (isDrumTrack(track) ? parseDrum(args.high) : null) ?? parsePitch(args.high) ?? Infinity;
  return notesIn(clip, from, to, low, high);
}

/** The chords a track plays between two beats, read off its notes: a chord per `each` beats. */
function chordsHeard(p: Project, from: number, count: number, each: number): Chord[] {
  const out: Chord[] = [];
  for (const t of p.tracks) {
    if (isDrumTrack(t) || t.instrument === "bass" || t.instrument === "lead") continue;
    const found: Chord[] = [];
    for (let i = 0; i < count; i++) {
      const a = from + i * each;
      const pitches = t.clips.flatMap((c) => c.notes.filter((n) => c.start + n.start >= a - 1e-6 && c.start + n.start < a + each - 1e-6).map((n) => n.pitch));
      const chord = detectChord(pitches);
      if (!chord) break;
      found.push(chord);
    }
    if (found.length === count) return found;
    if (found.length > out.length) out.splice(0, out.length, ...found);
  }
  return out;
}

function ensureRoom(track: Track) {
  if (track.clips.length >= MAX_CLIPS_PER_TRACK) refuse(`${track.name} already has ${MAX_CLIPS_PER_TRACK} clips.`);
}

/** The edit a tool call asks for, done to `p` (a copy). Returns what to tell the agent. */
function edit(name: string, p: Project, args: Record<string, any>, focus: Focus): { text: string; preview: string } {
  const action = typeof args.action === "string" ? args.action : "";
  switch (name) {
    case "studio_song": {
      const done: string[] = [];
      if (typeof args.name === "string" && args.name.trim()) { p.name = args.name.trim().slice(0, 80); done.push(`named it "${p.name}"`); }
      const bpm = numberOr(args.bpm);
      if (bpm !== null) { p.bpm = clamp(Math.round(bpm * 100) / 100, MIN_BPM, MAX_BPM); done.push(`tempo ${fmt(p.bpm)} bpm`); }
      if (args.key !== undefined) {
        const key = parseKey(args.key);
        if (!key) refuse(`"${String(args.key)}" is not a key. Try "A minor", "C", "F# dorian".`);
        p.key = key!;
        done.push(`key ${keyName(p.key)}`);
      }
      const per = numberOr(args.beats_per_bar);
      if (per !== null) { p.beatsPerBar = clamp(Math.round(per), 2, 12); done.push(`${p.beatsPerBar} beats a bar`); }
      const bars = numberOr(args.bars);
      if (bars !== null) { p.bars = clamp(Math.round(bars), 1, MAX_BARS); done.push(`${p.bars} bars`); }
      const master = numberOr(args.master);
      if (master !== null) { p.master = clamp(master, 0, 1.2); done.push(`master ${Math.round(p.master * 100)}%`); }
      if (typeof args.loop === "boolean") { p.loop = args.loop; done.push(p.loop ? "looping" : "not looping"); }
      if (!done.length) refuse("Nothing to change: pass name, bpm, key, beats_per_bar, bars, master or loop.");
      return { text: `Song: ${done.join(", ")}. Notes were not moved or changed.`, preview: done[0]! };
    }

    case "studio_track": {
      const settable = (t: Track) => {
        const done: string[] = [];
        if (typeof args.name === "string" && args.name.trim()) { t.name = args.name.trim().slice(0, 40); done.push(`name "${t.name}"`); }
        if (typeof args.instrument === "string") {
          if (!INSTRUMENTS.some((i) => i.id === args.instrument)) refuse(`instrument is one of ${INSTRUMENTS.map((i) => i.id).join(", ")}.`);
          const to = args.instrument as InstrumentId;
          if (isDrumTrack({ instrument: to }) !== isDrumTrack(t) && t.clips.some((c) => c.notes.length)) {
            refuse(`${t.name} has notes, and drums and pitched instruments read them differently. Add a new track, or clear this one first.`);
          }
          t.instrument = to;
          done.push(`instrument ${instrumentOf(to).name}`);
        }
        for (const [key, lo, hi] of [["volume", 0, 1.2], ["pan", -1, 1], ["reverb", 0, 1]] as const) {
          const v = numberOr(args[key]);
          if (v !== null) { t[key] = clamp(v, lo, hi); done.push(`${key} ${fmt(t[key])}`); }
        }
        if (typeof args.mute === "boolean") { t.mute = args.mute; done.push(t.mute ? "muted" : "unmuted"); }
        if (typeof args.solo === "boolean") { t.solo = args.solo; done.push(t.solo ? "solo" : "not solo"); }
        if (typeof args.color === "string" && /^#[0-9a-fA-F]{6}$/.test(args.color)) { t.color = args.color; done.push(`colour ${args.color}`); }
        return done;
      };
      switch (action) {
        case "add": {
          if (p.tracks.length >= MAX_TRACKS) refuse(`A song holds ${MAX_TRACKS} tracks.`);
          const instrument = typeof args.instrument === "string" ? args.instrument : "keys";
          if (!INSTRUMENTS.some((i) => i.id === instrument)) refuse(`instrument is one of ${INSTRUMENTS.map((i) => i.id).join(", ")}.`);
          const t = newTrack(p, instrument as InstrumentId, typeof args.name === "string" && args.name.trim() ? args.name.trim().slice(0, 40) : undefined);
          p.tracks.push(t);
          const done = settable(t);
          return { text: `Added track ${t.id} "${t.name}" (${instrumentOf(t.instrument).name})${done.length ? `; ${done.join(", ")}` : ""}.`, preview: `added ${t.name}` };
        }
        case "set": {
          const t = needTrack(p, args.track);
          const done = settable(t);
          if (!done.length) refuse("Nothing to change: pass name, instrument, volume, pan, reverb, mute, solo or color.");
          return { text: `${t.name}: ${done.join(", ")}.`, preview: `${t.name} ${done[0]}` };
        }
        case "duplicate": {
          if (p.tracks.length >= MAX_TRACKS) refuse(`A song holds ${MAX_TRACKS} tracks.`);
          const t = needTrack(p, args.track);
          const copy: Track = { ...t, id: uid("t"), name: `${t.name} copy`.slice(0, 40), solo: false, clips: t.clips.map((c) => copyClip(c, c.start)) };
          p.tracks.splice(p.tracks.indexOf(t) + 1, 0, copy);
          return { text: `Copied ${t.name} as track ${copy.id} "${copy.name}".`, preview: `copied ${t.name}` };
        }
        case "clear": {
          const t = needTrack(p, args.track);
          const n = t.clips.length;
          t.clips = [];
          return { text: `Removed ${n} clip${n === 1 ? "" : "s"} from ${t.name}.`, preview: `cleared ${t.name}` };
        }
        case "remove": {
          const t = needTrack(p, args.track);
          p.tracks.splice(p.tracks.indexOf(t), 1);
          return { text: `Deleted track ${t.name} and its ${t.clips.length} clip${t.clips.length === 1 ? "" : "s"}.`, preview: `deleted ${t.name}` };
        }
        default:
          return refuse("action is one of: add, set, duplicate, clear, remove.");
      }
    }

    case "studio_clip": {
      switch (action) {
        case "add": {
          const t = needTrack(p, args.track);
          ensureRoom(t);
          const start = startOf(p, args, null);
          const length = lengthOf(p, args, p.beatsPerBar);
          const clip = newClip(start, length, typeof args.name === "string" && args.name.trim() ? args.name.trim().slice(0, 40) : `${t.name} ${t.clips.length + 1}`);
          let skipped = "";
          if (args.notes !== undefined) {
            const { notes, problems } = readNotes(t, args.notes);
            if (problems.length) refuse(problems.slice(0, 5).join("; "));
            const added = addNotes(clip, notes);
            if (added < notes.length) skipped = ` ${notes.length - added} note${notes.length - added === 1 ? " was" : "s were"} past the clip's end and skipped.`;
          }
          t.clips.push(clip);
          return { text: `Added clip ${clip.id} "${clip.name}" to ${t.name} at bar ${barBeat(p, clip.start)}, ${fmt(clip.length / p.beatsPerBar)} bars, ${clip.notes.length} notes.${skipped}`, preview: `added clip to ${t.name}` };
        }
        case "move": {
          const { track, clip } = needClip(p, args.clip);
          const to = args.track !== undefined ? needTrack(p, args.track) : track;
          if (isDrumTrack(to) !== isDrumTrack(track) && clip.notes.length) refuse("Drums and pitched tracks read notes differently; a clip cannot move between them.");
          clip.start = startOf(p, args, clip.start);
          if (to !== track) {
            ensureRoom(to);
            track.clips.splice(track.clips.indexOf(clip), 1);
            to.clips.push(clip);
          }
          return { text: `Moved clip ${clip.id} to bar ${barBeat(p, clip.start)} on ${to.name}.`, preview: `moved ${clip.name}` };
        }
        case "resize": {
          const { clip } = needClip(p, args.clip);
          clip.length = lengthOf(p, args, null);
          const before = clip.notes.length;
          clip.notes = clip.notes.filter((n) => n.start < clip.length - 1e-6);
          for (const n of clip.notes) n.length = tidy(Math.min(n.length, clip.length - n.start));
          const cut = before - clip.notes.length;
          return { text: `Clip ${clip.id} is now ${fmt(clip.length / p.beatsPerBar)} bars (${fmt(clip.length)} beats).${cut ? ` ${cut} note${cut === 1 ? "" : "s"} past the new end were removed.` : ""}`, preview: `resized ${clip.name}` };
        }
        case "rename": {
          const { clip } = needClip(p, args.clip);
          if (typeof args.name !== "string" || !args.name.trim()) refuse("name is required.");
          clip.name = args.name.trim().slice(0, 40);
          return { text: `Renamed clip ${clip.id} to "${clip.name}".`, preview: `renamed to ${clip.name}` };
        }
        case "duplicate": {
          const { track, clip } = needClip(p, args.clip);
          const times = clamp(Math.round(numberOr(args.times) ?? 1), 1, 64);
          const explicit = numberOr(args.start) !== null || numberOr(args.bar) !== null;
          const made: Clip[] = [];
          for (let i = 0; i < times; i++) {
            ensureRoom(track);
            const at = explicit ? startOf(p, args, null) + i * clip.length : clip.start + clip.length * (i + 1);
            const copy = copyClip(clip, at);
            track.clips.push(copy);
            made.push(copy);
          }
          return { text: `Copied clip ${clip.id} ${times} time${times === 1 ? "" : "s"}: ${made.map((c) => `${c.id} at bar ${barBeat(p, c.start)}`).join("; ")}.`, preview: `copied ${clip.name} x${times}` };
        }
        case "split": {
          const { track, clip } = needClip(p, args.clip);
          const at = startOf(p, args, null);
          const inside = at - clip.start;
          if (inside <= 0.0001 || inside >= clip.length - 0.0001) refuse(`The cut at bar ${barBeat(p, at)} is not inside the clip (bar ${barBeat(p, clip.start)} to ${barBeat(p, clip.start + clip.length)}).`);
          ensureRoom(track);
          const right = newClip(at, clip.length - inside, `${clip.name} b`);
          for (const n of clip.notes) {
            if (n.start >= inside) right.notes.push({ ...n, id: uid("n"), start: tidy(n.start - inside) });
            else if (n.start + n.length > inside) n.length = tidy(inside - n.start);
          }
          clip.notes = clip.notes.filter((n) => n.start < inside);
          clip.length = tidy(inside);
          track.clips.push(right);
          return { text: `Split clip ${clip.id} at bar ${barBeat(p, at)}: the second half is clip ${right.id}.`, preview: `split ${clip.name}` };
        }
        case "remove": {
          const { track, clip } = needClip(p, args.clip);
          track.clips.splice(track.clips.indexOf(clip), 1);
          if (focus.clipId === clip.id) focus.clipId = null;
          return { text: `Deleted clip ${clip.id} "${clip.name}" (${clip.notes.length} notes).`, preview: `deleted ${clip.name}` };
        }
        default:
          return refuse("action is one of: add, move, resize, rename, duplicate, split, remove.");
      }
    }

    case "studio_notes": {
      const { track, clip } = needClip(p, args.clip);
      switch (action) {
        case "add":
        case "replace": {
          const { notes, problems } = readNotes(track, args.notes);
          if (problems.length) refuse(problems.slice(0, 5).join("; "));
          if (action === "replace") clip.notes = [];
          const added = addNotes(clip, notes);
          const skipped = notes.length - added;
          return { text: `${action === "replace" ? "Rewrote" : "Added to"} clip ${clip.id}: ${added} note${added === 1 ? "" : "s"}${action === "replace" ? "" : ` (now ${clip.notes.length})`}.${skipped ? ` ${skipped} past the clip's end (${fmt(clip.length)} beats) or over the limit were skipped.` : ""}`, preview: `${action} ${added} notes` };
        }
        case "clear": {
          const n = clip.notes.length;
          clip.notes = [];
          return { text: `Cleared ${n} note${n === 1 ? "" : "s"} from clip ${clip.id}.`, preview: `cleared ${clip.name}` };
        }
        case "remove": {
          const ids = Array.isArray(args.ids) ? new Set(args.ids.map(String)) : null;
          const hit = new Set((ids ? clip.notes.filter((n) => ids.has(n.id)) : windowOf(clip, track, args)).map((n) => n.id));
          if (!ids && args.from === undefined && args.to === undefined && args.low === undefined && args.high === undefined) refuse("Say what to remove: `ids`, or a window (`from`/`to`/`low`/`high`). To remove everything use clear.");
          clip.notes = clip.notes.filter((n) => !hit.has(n.id));
          return { text: `Removed ${hit.size} note${hit.size === 1 ? "" : "s"} from clip ${clip.id} (${clip.notes.length} left).`, preview: `removed ${hit.size} notes` };
        }
        case "transpose": {
          if (isDrumTrack(track)) refuse("A drum clip is not transposed: a different pitch is a different drum.");
          const semis = numberOr(args.semitones);
          if (semis === null) return refuse("semitones is required (negative is down).");
          const hit = windowOf(clip, track, args);
          for (const n of hit) n.pitch = clamp(n.pitch + Math.round(semis), 0, 127);
          return { text: `Moved ${hit.length} note${hit.length === 1 ? "" : "s"} ${semis >= 0 ? "up" : "down"} ${Math.abs(Math.round(semis))} semitone${Math.abs(semis) === 1 ? "" : "s"}.`, preview: `transposed ${semis}` };
        }
        case "quantize": {
          quantize(clip, parseGrid(args.grid ?? "1/16"), clamp(numberOr(args.strength) ?? 1, 0, 1), args.lengths === true);
          return { text: `Snapped the timing of clip ${clip.id} to ${String(args.grid ?? "1/16")} (${Math.round(clamp(numberOr(args.strength) ?? 1, 0, 1) * 100)}%).`, preview: "quantized" };
        }
        case "humanize": {
          humanize(clip, clamp(numberOr(args.amount) ?? 0.5, 0, 1), 1 + clip.notes.length);
          return { text: `Loosened the timing and velocity of clip ${clip.id}.`, preview: "humanized" };
        }
        case "velocity": {
          const vel = numberOr(args.vel);
          if (vel === null) return refuse("vel is required (0 to 1).");
          const hit = windowOf(clip, track, args);
          for (const n of hit) n.vel = clamp(vel, 0.05, 1);
          return { text: `Set the velocity of ${hit.length} note${hit.length === 1 ? "" : "s"} to ${fmt(clamp(vel, 0.05, 1))}.`, preview: "velocity" };
        }
        default:
          return refuse("action is one of: add, replace, clear, remove, transpose, quantize, humanize, velocity.");
      }
    }

    case "studio_make": {
      const kind = String(args.kind ?? "");
      if (!["chords", "bass", "drums"].includes(kind)) refuse("kind is chords, bass or drums.");
      const bpb = p.beatsPerBar;
      // The clip to rewrite, or the track the new one goes on.
      const existing = args.clip !== undefined ? needClip(p, args.clip) : null;
      let track: Track | null = existing?.track ?? null;
      if (!track && args.track !== undefined) {
        track = findTrack(p, args.track);
        if (!track && typeof args.track === "string" && args.track.trim()) {
          if (p.tracks.length >= MAX_TRACKS) refuse(`A song holds ${MAX_TRACKS} tracks.`);
          track = newTrack(p, kind === "drums" ? "kit" : kind === "bass" ? "bass" : "keys", args.track.trim().slice(0, 40));
          p.tracks.push(track);
        }
      }
      if (!track) {
        const wanted = (t: Track) => (kind === "drums" ? isDrumTrack(t) : kind === "bass" ? t.instrument === "bass" : !isDrumTrack(t) && t.instrument !== "bass" && t.instrument !== "lead");
        track = p.tracks.find(wanted) ?? null;
        if (!track) {
          if (p.tracks.length >= MAX_TRACKS) refuse(`A song holds ${MAX_TRACKS} tracks.`);
          track = newTrack(p, kind === "drums" ? "kit" : kind === "bass" ? "bass" : "keys");
          p.tracks.push(track);
        }
      }
      if (kind === "drums" ? !isDrumTrack(track) : isDrumTrack(track)) refuse(`${track.name} is ${isDrumTrack(track) ? "a drum" : "a pitched"} track; ${kind} needs ${kind === "drums" ? "a drum" : "a pitched"} one.`);
      const at = existing ? existing.clip.start : startOf(p, args, 0);
      const each = clamp(numberOr(args.beats_each) ?? bpb, 0.5, 64);
      let notes: Array<Omit<Note, "id">>;
      let label: string;
      let length: number;
      let heard = "";
      if (kind === "drums") {
        const style = String(args.style ?? "rock");
        if (!(DRUM_STYLES as readonly string[]).includes(style)) refuse(`drum style is one of: ${DRUM_STYLES.join(", ")}.`);
        const bars = Math.max(1, Math.round((numberOr(args.bars) ?? (existing ? existing.clip.length / bpb : 4))));
        length = bars * bpb;
        notes = drumNotes({ style: style as DrumStyle, bars, beatsPerBar: bpb, swing: numberOr(args.swing) ?? 0, fill: args.fill === true, feel: numberOr(args.feel) ?? 0.12, seed: bars * 31 + style.length });
        label = `Drums: ${style.replace(/_/g, " ")}`;
      } else {
        let chords: Chord[];
        if (typeof args.progression === "string" && args.progression.trim()) {
          const parsed = parseProgression(args.progression, p.key);
          if ("error" in parsed) return refuse(parsed.error);
          chords = parsed;
        } else if (kind === "bass") {
          const count = Math.max(1, Math.round(((numberOr(args.bars) ?? 4) * bpb) / each));
          chords = chordsHeard(p, at, count, each);
          if (chords.length === 0) refuse("Say which chords: `progression` (\"Am F C G\"), or make the chords first and the bass will follow them.");
          heard = " (read from the chords already in the song)";
        } else {
          return refuse("progression is required (chord names like \"Am F C G\", or numerals like \"vi IV I V\").");
        }
        const wanted = numberOr(args.bars);
        const total = wanted !== null ? Math.max(1, Math.round((wanted * bpb) / each)) : chords.length;
        const cycled = Array.from({ length: total }, (_, i) => chords[i % chords.length]!);
        length = total * each;
        const style = String(args.style ?? (kind === "chords" ? "block" : "root"));
        if (kind === "chords") {
          if (!(CHORD_STYLES as readonly string[]).includes(style)) refuse(`chord style is one of: ${CHORD_STYLES.join(", ")}.`);
          notes = chordNotes(cycled, { style: style as ChordStyle, octave: numberOr(args.octave) ?? 3, beatsEach: each, spread: args.spread === true });
        } else {
          if (!(BASS_STYLES as readonly string[]).includes(style)) refuse(`bass style is one of: ${BASS_STYLES.join(", ")}.`);
          notes = bassNotes(cycled, { style: style as BassStyle, octave: numberOr(args.octave) ?? 2, beatsEach: each });
        }
        label = `${kind === "chords" ? "Chords" : "Bass"}: ${chords.map(chordLabel).join(" ")}`;
        heard = `${heard} Chords: ${cycled.map(chordLabel).join(" ")}.`;
      }
      let clip: Clip;
      if (existing) {
        clip = existing.clip;
        clip.notes = [];
        clip.length = tidy(length);
        if (typeof args.name === "string" && args.name.trim()) clip.name = args.name.trim().slice(0, 40);
      } else {
        ensureRoom(track);
        clip = newClip(at, length, typeof args.name === "string" && args.name.trim() ? args.name.trim().slice(0, 40) : label.slice(0, 40));
        track.clips.push(clip);
      }
      addNotes(clip, notes);
      return {
        text: `${existing ? "Rewrote" : "Made"} clip ${clip.id} "${clip.name}" on ${track.name} (${instrumentOf(track.instrument).name}): bar ${barBeat(p, clip.start)}, ${fmt(clip.length / bpb)} bars, ${clip.notes.length} notes.${heard}`,
        preview: label,
      };
    }
  }
  return refuse(`Unknown studio tool: ${name}`);
}

/**
 * Runs one `studio_*` tool on the chat's song and opens the window, so the person watches it happen.
 * Never throws: a bad call comes back as { ok: false, summary } saying what was wrong and what to try.
 */
export async function runStudioTool(session: string, name: string, args: Record<string, any>, hooks: StudioHooks = {}): Promise<StudioOutcome> {
  if (!validSession(session)) return { ok: false, summary: "Autora Studio needs a chat to work in." };
  try {
    const e = entryFor(session);
    switch (name) {
      case "studio_open": {
        if (typeof args.new === "string" && args.new.trim()) {
          const has = e.project.tracks.some((t) => t.clips.some((c) => c.notes.length));
          if (has && args.replace !== true) {
            return { ok: false, summary: `The song "${e.project.name}" already has notes in it, and starting a new one would throw them away. If the person asked to start over, call again with replace: true; otherwise carry on in this song.` };
          }
          const next = newProject(args.new.trim().slice(0, 80));
          const bpm = numberOr(args.bpm);
          if (bpm !== null) next.bpm = clamp(bpm, MIN_BPM, MAX_BPM);
          if (args.key !== undefined) next.key = parseKey(args.key) ?? next.key;
          e.focus = { trackId: null, clipId: null };
          commit(session, e, next, "agent");
        }
        setOpen(session, true);
        return { ok: true, summary: `${describeProject(e.project, { focus: e.focus })}`, preview: `"${e.project.name}"` };
      }

      case "studio_look": {
        setOpen(session, true);
        if (args.clip !== undefined && !findClip(e.project, args.clip)) return { ok: false, summary: `There is no clip "${String(args.clip)}". Clip ids are in studio_look.` };
        const notes = review(e.project);
        return {
          ok: true,
          summary: describeProject(e.project, { clip: typeof args.clip === "string" ? args.clip : undefined, focus: e.focus }) + (notes.length ? `\nObservations:\n${notes.map((n) => `- ${n}`).join("\n")}` : ""),
          preview: `"${e.project.name}"`,
        };
      }

      case "studio_song":
      case "studio_track":
      case "studio_clip":
      case "studio_notes":
      case "studio_make": {
        const next = structuredClone(e.project);
        const done = edit(name, next, args, e.focus);
        setOpen(session, true);
        commit(session, e, next, "agent");
        return { ok: true, summary: `${done.text}\n${describeProject(e.project, { focus: e.focus })}`, preview: done.preview };
      }

      case "studio_play": {
        const action = String(args.action ?? "");
        if (!["play", "stop", "seek"].includes(action)) return { ok: false, summary: "action is play, stop or seek." };
        const bar = numberOr(args.bar);
        const result = (await command(session, action, bar !== null ? { beat: Math.max(0, (bar - 1) * e.project.beatsPerBar) } : {}, 20_000)) as { playing?: boolean; blocked?: boolean } | null;
        if (result?.blocked) return { ok: true, summary: "The browser will not let the page make sound until the person has tapped something in it. Ask them to press play in the window once.", preview: "waiting for a tap" };
        return { ok: true, summary: action === "stop" ? "Stopped." : action === "seek" ? `The playhead is at bar ${bar ?? 1}.` : `Playing${bar !== null ? ` from bar ${bar}` : ""} in the person's window. You cannot hear it; ask how it sounds.`, preview: action };
      }

      case "studio_export": {
        if (songBeats(e.project) <= 0 || !e.project.tracks.some((t) => t.clips.some((c) => c.notes.length))) return { ok: false, summary: "There is nothing to export yet: the song has no notes." };
        const base = (typeof args.name === "string" && args.name.trim() ? args.name.trim() : e.project.name).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").replace(/\.wav$/i, "").slice(0, 80) || "song";
        const out = (await command(session, "export", { name: base }, 5 * 60_000)) as { artifact?: string; name?: string; size?: number; mime?: string } | null;
        if (!out?.artifact) return { ok: false, summary: "The window could not render the song." };
        hooks.showFile?.({ id: out.artifact, name: out.name ?? `${base}.wav`, mime: out.mime ?? "audio/wav", size: out.size ?? 0 });
        return { ok: true, summary: `Exported ${out.name ?? `${base}.wav`} (${Math.round((out.size ?? 0) / 1024)} KB) as artifact ${out.artifact}; the person can play and download it from the thread.`, preview: out.name ?? base };
      }

      default:
        return { ok: false, summary: `Unknown studio tool: ${name}` };
    }
  } catch (err) {
    return { ok: false, summary: err instanceof Refuse ? err.message : `Autora Studio could not do that: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ------------------------------------------------------------------ routes --

const bigJson = express.json({ limit: "16mb" });
const rawBody = express.raw({ type: () => true, limit: MAX_ARTIFACT_BYTES });

/** The window's side of the wire: its state, its song, its focus, opening and putting it away, and the commands. */
export function studioRoutes(app: Express, opts: {
  exists: (session: string) => boolean;
  incognito: (session: string) => boolean;
  off: () => boolean;
  push: (session: string, message: Record<string, unknown>) => void;
}) {
  pushed = opts.push;
  const known = (req: Request, res: Response): string | null => {
    const id = String(req.params.session);
    if (!validSession(id) || !opts.exists(id)) {
      res.status(404).json({ error: "No such session." });
      return null;
    }
    return id;
  };

  app.get("/api/studio/:session", (req, res) => {
    const id = known(req, res);
    if (id) res.json(studioState(id));
  });

  app.get("/api/studio/:session/doc", (req, res) => {
    const id = known(req, res);
    if (!id) return;
    const e = entryFor(id);
    res.setHeader("Cache-Control", "no-store");
    res.json({ doc: e.project, rev: e.rev, focus: e.focus });
  });

  /* What the person did in the window. The song is taken only after it has been checked and repaired, so a stale or
     malformed one is refused rather than saved; and refused (409) when the agent has changed the song since the
     window last loaded it, so that its work is never undone unseen. */
  app.put("/api/studio/:session/doc", bigJson, (req, res) => {
    const id = known(req, res);
    if (!id) return;
    if (opts.off()) return res.status(403).json({ error: "Autora Studio is switched off on the Tools page." });
    const e = entryFor(id);
    const based = numberOr(req.body?.rev);
    if (based !== null && based < e.rev && e.by === "agent") {
      return res.status(409).json({ error: "Autora changed the song while you were editing.", rev: e.rev });
    }
    const next = normalizeProject(req.body?.doc);
    if (!next) return res.status(400).json({ error: "That is not an Autora Studio song." });
    commit(id, e, next, "person");
    res.json({ rev: e.rev });
  });

  /* Which clip the person has open, so the agent can be told "this clip". Not a change to the song. */
  app.post("/api/studio/:session/focus", bigJson, (req, res) => {
    const id = known(req, res);
    if (!id) return;
    const e = entryFor(id);
    const clean = (v: unknown) => (typeof v === "string" && /^[\w-]{1,24}$/.test(v) ? v : null);
    e.focus = { trackId: clean(req.body?.trackId), clipId: clean(req.body?.clipId) };
    res.json({ ok: true });
  });

  app.post("/api/studio/:session/open", (req, res) => {
    const id = known(req, res);
    if (!id) return;
    if (opts.off()) return res.status(403).json({ error: "Autora Studio is switched off on the Tools page." });
    if (opts.incognito(id)) return res.status(409).json({ error: "An incognito chat keeps nothing, so it has no music window." });
    setOpen(id, true);
    res.json({ ...studioState(id), name: entryFor(id).project.name });
  });

  app.post("/api/studio/:session/close", (req, res) => {
    const id = known(req, res);
    if (!id) return;
    setOpen(id, false);
    res.json(studioState(id));
  });

  app.post("/api/studio/:session/ready", bigJson, (req, res) => {
    const id = known(req, res);
    if (!id) return;
    // A window that has just mounted says false: its page is not up, whatever an earlier one said.
    entryFor(id).ready = req.body?.ready !== false;
    res.json({ ok: true });
  });

  /* The same chat can be open in two tabs and both get the command: the first to ask does it. */
  app.post("/api/studio/:session/claim", (req, res) => {
    const id = known(req, res);
    if (!id) return;
    const p = pending.get(String(req.query.id ?? ""));
    const won = !!p && p.session === id && !p.claimed;
    if (won && p) p.claimed = true;
    res.json({ won });
  });

  app.post("/api/studio/:session/reply", bigJson, (req, res) => {
    const id = known(req, res);
    if (!id) return;
    const p = pending.get(String(req.body?.id ?? ""));
    if (p && p.session === id) {
      clearTimeout(p.timer);
      pending.delete(String(req.body.id));
      if (req.body.ok) p.resolve(req.body.value);
      else p.reject(new Error(String(req.body?.value?.message ?? "The window could not do that.")));
    }
    res.json({ ok: true });
  });

  // The bounced song, from the window, kept as an artifact the person can play and download.
  app.post("/api/studio/:session/deliver", rawBody, (req, res) => {
    const id = known(req, res);
    if (!id) return;
    if (!Buffer.isBuffer(req.body) || req.body.byteLength < 44) return res.status(400).json({ error: "empty" });
    const raw = String(req.query.name ?? "song").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").replace(/\.wav$/i, "").slice(0, 80);
    const art = saveArtifact({ origin: "agent", name: `${raw || "song"}.wav`, data: req.body, mime: "audio/wav", session: id, note: "Bounced from Autora Studio" });
    res.json({ artifact: art.id, name: art.name, size: art.size, mime: art.mime });
  });
}
