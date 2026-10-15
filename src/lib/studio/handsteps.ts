/**
 * What the agent's hand does in the Music window to turn one song into another, as a person would with the window's
 * own controls (Visible work, docs/VISIBLE-WORK.md). The server works out the finished song (server/studio.ts); this says
 * how to get there by hand, and the window does it (src/components/studio/hand.ts) while the tool call waits. What has no
 * step here -- an instrument changed, a note's velocity -- is in the finished song, which goes in afterwards.
 *
 * Shared by the server and the page: pure, no DOM.
 *
 * Ids are the finished song's. A track or clip the hand makes gets an id of the window's own; the window keeps a map, so
 * a later step naming the new id finds it.
 */
import { isDrumTrack, type Clip, type Note, type Project, type Track } from "./model";

export type StudioStep =
  | { k: "name"; name: string }
  | { k: "tempo"; bpm: number }
  | { k: "key"; root: number; scale: string }
  | { k: "bars"; bars: number }
  | { k: "loop"; on: boolean }
  | { k: "master"; v: number }
  | { k: "addTrack"; track: string; instrument: string; name: string }
  | { k: "renameTrack"; track: string; name: string }
  | { k: "flag"; track: string; which: "mute" | "solo"; on: boolean }
  | { k: "mix"; track: string; which: "volume" | "pan" | "reverb"; v: number }
  | { k: "trackMenu"; track: string; item: "Duplicate" | "Clear clips" | "Delete track"; made?: string }
  | { k: "drawClip"; track: string; clip: string; start: number; length: number; name: string }
  | { k: "moveClip"; clip: string; start: number; track?: string }
  | { k: "resizeClip"; clip: string; length: number }
  | { k: "renameClip"; clip: string; name: string }
  | { k: "clipTool"; clip: string; tool: "Duplicate" | "Delete" | "Split"; at?: number; made?: string }
  | { k: "notes"; clip: string; drum: boolean; snap: number; add: Array<{ pitch: number; start: number; length: number }>; remove: Array<{ pitch: number; start: number }> }
  | { k: "rollTool"; clip: string; tool: "Clear" | "Humanize" | "Tidy timing" | "♯" | "♭" | "+8" | "−8"; snap?: number };

/** The most notes one call places by hand; the rest are in the finished song. */
export const MAX_HAND_NOTES = 48;
/** The most steps of any kind one call does by hand. */
export const MAX_HAND_STEPS = 60;

const GRIDS = [1, 0.5, 0.25, 0.125];
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

/** The coarsest grid every start (and length) sits on, so the window's snap draws them where they are. */
function gridFor(values: number[]): number {
  for (const g of GRIDS) if (values.every((v) => near(Math.round(v / g) * g, v))) return g;
  return GRIDS[GRIDS.length - 1]!;
}

const clipsOf = (p: Project) => {
  const out = new Map<string, { track: Track; clip: Clip }>();
  for (const track of p.tracks) for (const clip of track.clips) out.set(clip.id, { track, clip });
  return out;
};

/** A uniform shift of every note's pitch, as the roll's ♯ ♭ +8 −8 buttons make; null when it is not one. */
function shiftOf(before: Note[], after: Note[]): number | null {
  if (!before.length || before.length !== after.length) return null;
  const by = new Map(after.map((n) => [n.id, n]));
  let shift: number | null = null;
  for (const n of before) {
    const m = by.get(n.id);
    if (!m || !near(m.start, n.start) || !near(m.length, n.length)) return null;
    const d = m.pitch - n.pitch;
    if (shift === null) shift = d;
    else if (shift !== d) return null;
  }
  return shift;
}

/**
 * The steps from `before` to `after`, for the tool call `tool` (its name says which of two ways a thing was done: a
 * duplicate, a split). `skipped` counts what is left for the finished song because the hand's budget ran out.
 */
export function studioSteps(tool: string, args: Record<string, unknown>, before: Project, after: Project): { steps: StudioStep[]; skipped: number } {
  const steps: StudioStep[] = [];
  let skipped = 0;
  const action = typeof args.action === "string" ? args.action : "";

  // The song.
  if (after.name !== before.name) steps.push({ k: "name", name: after.name });
  if (!near(after.bpm, before.bpm)) steps.push({ k: "tempo", bpm: after.bpm });
  if (after.key.root !== before.key.root || after.key.scale !== before.key.scale) steps.push({ k: "key", root: after.key.root, scale: after.key.scale });
  if (tool === "studio_song" && args.bars !== undefined && after.bars !== before.bars) steps.push({ k: "bars", bars: after.bars });
  if (after.loop !== before.loop) steps.push({ k: "loop", on: after.loop });
  if (!near(after.master, before.master)) steps.push({ k: "master", v: after.master });

  const was = new Map(before.tracks.map((t) => [t.id, t]));
  const now = new Map(after.tracks.map((t) => [t.id, t]));
  const clipsWere = clipsOf(before);
  const clipsNow = clipsOf(after);

  // Tracks gone: their menu's Delete track.
  for (const t of before.tracks) if (!now.has(t.id)) steps.push({ k: "trackMenu", track: t.id, item: "Delete track" });

  // Tracks new: Add track and the instrument, or a copy by the old one's menu.
  const copied = new Set<string>();
  for (const t of after.tracks) {
    if (was.has(t.id)) continue;
    if (tool === "studio_track" && action === "duplicate") {
      const src = before.tracks.find((x) => x.name && t.name === `${x.name} copy`.slice(0, 40)) ?? before.tracks.find((x) => String(args.track) === x.id || String(args.track) === x.name);
      if (src) {
        steps.push({ k: "trackMenu", track: src.id, item: "Duplicate", made: t.id });
        copied.add(t.id);
        for (const c of t.clips) copied.add(c.id);
        continue;
      }
    }
    steps.push({ k: "addTrack", track: t.id, instrument: t.instrument, name: t.name });
  }

  // Each track as it is now: its name, mute and solo, its levels.
  for (const t of after.tracks) {
    const old = was.get(t.id);
    if (copied.has(t.id)) continue;
    if (old && old.name !== t.name) steps.push({ k: "renameTrack", track: t.id, name: t.name });
    // A new one is checked against what Add track gives it, by the window, which knows.
    if (!old) steps.push({ k: "renameTrack", track: t.id, name: t.name });
    for (const which of ["mute", "solo"] as const) {
      if (old ? old[which] !== t[which] : t[which]) steps.push({ k: "flag", track: t.id, which, on: t[which] });
    }
    for (const which of ["volume", "pan", "reverb"] as const) {
      if (old ? !near(old[which], t[which]) : true) steps.push({ k: "mix", track: t.id, which, v: t[which] });
    }
  }

  // A track whose every clip went, and stays: its menu's Clear clips.
  const cleared = new Set<string>();
  for (const t of after.tracks) {
    const old = was.get(t.id);
    if (old && old.clips.length > 1 && t.clips.length === 0) {
      steps.push({ k: "trackMenu", track: t.id, item: "Clear clips" });
      cleared.add(t.id);
    }
  }

  // Clips gone (not with a track or a cleared track): picked, and the bar's Delete.
  for (const [id, { track }] of clipsWere) {
    if (clipsNow.has(id) || !now.has(track.id) || cleared.has(track.id)) continue;
    steps.push({ k: "clipTool", clip: id, tool: "Delete" });
  }

  // Clips new: a duplicate or a split by the bar's tool; else drawn on the lane, then put where they go.
  const notesFor: Array<{ clip: Clip; track: Track; old: Clip | null }> = [];
  for (const [id, { track, clip }] of clipsNow) {
    if (copied.has(id)) continue;
    const old = clipsWere.get(id);
    if (old) {
      if (old.track.id !== track.id || !near(old.clip.start, clip.start)) steps.push({ k: "moveClip", clip: id, start: clip.start, ...(old.track.id !== track.id ? { track: track.id } : {}) });
      if (!near(old.clip.length, clip.length) && !(tool === "studio_clip" && action === "split")) steps.push({ k: "resizeClip", clip: id, length: clip.length });
      if (old.clip.name !== clip.name) steps.push({ k: "renameClip", clip: id, name: clip.name });
      notesFor.push({ clip, track, old: old.clip });
      continue;
    }
    if (tool === "studio_clip" && action === "duplicate") {
      const src = clipsWere.get(String(args.clip ?? ""));
      if (src) { steps.push({ k: "clipTool", clip: src.clip.id, tool: "Duplicate", made: id }); continue; }
    }
    if (tool === "studio_clip" && action === "split") {
      const src = clipsWere.get(String(args.clip ?? ""));
      if (src) { steps.push({ k: "clipTool", clip: src.clip.id, tool: "Split", at: clip.start, made: id }); continue; }
    }
    steps.push({ k: "drawClip", track: track.id, clip: id, start: clip.start, length: clip.length, name: clip.name });
    notesFor.push({ clip, track, old: null });
  }

  // The notes, clip by clip: the roll's own buttons for a shift or a clear, else each note placed or taken away.
  let placed = 0;
  for (const { clip, track, old } of notesFor) {
    const drum = isDrumTrack(track);
    const before = old?.notes ?? [];
    if (old && before.length && JSON.stringify(before) === JSON.stringify(clip.notes)) continue;
    const shift = old ? shiftOf(before, clip.notes) : null;
    if (shift !== null && shift !== 0 && !drum) {
      let left = shift;
      while (left !== 0 && steps.length < MAX_HAND_STEPS) {
        const tool = left >= 12 ? "+8" : left <= -12 ? "−8" : left > 0 ? "♯" : "♭";
        steps.push({ k: "rollTool", clip: clip.id, tool });
        left -= tool === "+8" ? 12 : tool === "−8" ? -12 : tool === "♯" ? 1 : -1;
      }
      continue;
    }
    if (old && tool === "studio_notes" && action === "humanize") { steps.push({ k: "rollTool", clip: clip.id, tool: "Humanize" }); continue; }
    if (old && tool === "studio_notes" && action === "quantize" && !drum && (args.strength === undefined || Number(args.strength) === 1)) {
      const grid = Number({ "1/4": 1, "1/8": 0.5, "1/16": 0.25, "1/32": 0.125 }[String(args.grid ?? "1/16")] ?? 0);
      if (grid) { steps.push({ k: "rollTool", clip: clip.id, tool: "Tidy timing", snap: grid }); continue; }
    }
    const keep = new Set(clip.notes.map((n) => n.id));
    const gone = before.filter((n) => !keep.has(n.id));
    const had = new Map(before.map((n) => [n.id, n]));
    // A note moved or reshaped is taken away and placed again, as a person would redraw it.
    const moved = clip.notes.filter((n) => { const o = had.get(n.id); return o && (o.pitch !== n.pitch || !near(o.start, n.start) || !near(o.length, n.length)); });
    const fresh = clip.notes.filter((n) => !had.has(n.id));
    const remove = [...gone, ...moved.map((n) => had.get(n.id)!)].map((n) => ({ pitch: n.pitch, start: n.start }));
    let add = [...moved, ...fresh].map((n) => ({ pitch: n.pitch, start: n.start, length: n.length }));
    if (old && before.length > 0 && gone.length === before.length && remove.length > 6) {
      steps.push({ k: "rollTool", clip: clip.id, tool: "Clear" });
      remove.length = 0;
    }
    const room = Math.max(0, MAX_HAND_NOTES - placed);
    if (add.length > room) { skipped += add.length - room; add = add.slice(0, room); }
    placed += add.length;
    if (!add.length && !remove.length) continue;
    const snap = gridFor(drum ? add.map((n) => n.start) : add.flatMap((n) => [n.start, n.length]));
    steps.push({ k: "notes", clip: clip.id, drum, snap, add, remove });
  }

  if (steps.length > MAX_HAND_STEPS) { skipped += steps.length - MAX_HAND_STEPS; steps.length = MAX_HAND_STEPS; }
  return { steps, skipped };
}

/** One step in a few words, for what the agent is told was done by hand. */
export function stepWords(s: StudioStep): string {
  switch (s.k) {
    case "name": return `named the song "${s.name}" in its name field`;
    case "tempo": return `set the tempo to ${Math.round(s.bpm)} in the Song tray`;
    case "key": return "picked the key in the Song tray";
    case "bars": return `set ${s.bars} bars in the Song tray`;
    case "loop": return s.on ? "turned Loop on" : "turned Loop off";
    case "master": return `moved the master fader to ${Math.round(s.v * 100)}`;
    case "addTrack": return `added a ${s.instrument} track with Add track`;
    case "renameTrack": return `named a track "${s.name}"`;
    case "flag": return `${s.on ? "pressed" : "released"} ${s.which === "mute" ? "M (mute)" : "S (solo)"}`;
    case "mix": return `moved a track's ${s.which} to ${Math.round(s.v * 100)} in the Mixer`;
    case "trackMenu": return `chose ${s.item} in a track's menu`;
    case "drawClip": return "drew a clip on its lane";
    case "moveClip": return "dragged a clip to its place";
    case "resizeClip": return "dragged a clip's end";
    case "renameClip": return `named a clip "${s.name}"`;
    case "clipTool": return `used ${s.tool} on a clip`;
    case "notes": return `${s.add.length ? `placed ${s.add.length} note${s.add.length === 1 ? "" : "s"}` : ""}${s.add.length && s.remove.length ? " and " : ""}${s.remove.length ? `took away ${s.remove.length}` : ""} in the ${s.drum ? "drum grid" : "piano roll"}`;
    case "rollTool": return `pressed ${s.tool} in the piano roll`;
  }
}
