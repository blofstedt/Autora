/**
 * Autora Music: the song model, the agent's studio_* tools, and the routes between the server and the window.
 *
 * Sound is made by the browser (Web Audio), so what is checked here is everything that decides what is played:
 * music theory, the generators, the edits, and the wire.
 *
 *   npx tsx tests/studio.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Chord, Project } from "../src/lib/studio/model";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autora-studio-"));
process.env.AUTORA_STATE_DIR = dir;

const express = (await import("express")).default;
const m = await import("../src/lib/studio/model");
const studio = await import("../server/studio");
const { studioSPECS } = await import("../server/specs/studio");
const { windowOff, toolSettings } = await import("../server/tools");
const { loadedFamilies, withoutUnloaded } = await import("../server/toolload");
const { looksOnly: isLooking } = await import("../server/modes");
const { getArtifact } = await import("../server/artifacts");

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

// ------------------------------------------------------------ the theory --

await test("notes are named the way musicians name them", () => {
  assert.equal(m.parsePitch("C4"), 60);
  assert.equal(m.parsePitch("a4"), 69);
  assert.equal(m.parsePitch("F#3"), 54);
  assert.equal(m.parsePitch("Bb2"), 46);
  assert.equal(m.parsePitch(61), 61);
  assert.equal(m.parsePitch("nope"), null);
  assert.equal(m.pitchName(60), "C4");
  assert.equal(m.pitchName(46), "A#2");
});

await test("drums are found by name and by what they are usually called", () => {
  assert.equal(m.parseDrum("kick"), 36);
  assert.equal(m.parseDrum("Hi-hat"), 42);
  assert.equal(m.parseDrum("hh"), 42);
  assert.equal(m.parseDrum("open hat"), 46);
  assert.equal(m.parseDrum("banjo"), null);
});

await test("keys: a note and a scale, in plain words", () => {
  assert.deepEqual(m.parseKey("A minor"), { root: 9, scale: "minor" });
  assert.deepEqual(m.parseKey("C"), { root: 0, scale: "major" });
  assert.deepEqual(m.parseKey("F# dorian"), { root: 6, scale: "dorian" });
  assert.deepEqual(m.parseKey("Bb min"), { root: 10, scale: "minor" });
  assert.equal(m.parseKey("H sharp"), null);
  const aMinor = m.parseKey("A minor")!;
  assert.ok(m.inKey(aMinor, 69) && m.inKey(aMinor, 72) && !m.inKey(aMinor, 70));
});

await test("chords: names, numerals in the key, and what a handful of notes spell", () => {
  assert.deepEqual(m.parseChord("Am7")!.intervals, [0, 3, 7, 10]);
  assert.equal(m.parseChord("F#m")!.root, 6);
  assert.equal(m.parseChord("C/E")!.root, 0, "the slash bass is the bass line's business");
  assert.equal(m.parseChord("Hm"), null);
  const c = m.parseProgression("I V vi IV", { root: 0, scale: "major" });
  assert.ok(Array.isArray(c));
  assert.deepEqual((c as Chord[]).map((x) => m.chordLabel(x)), ["C", "G", "Am", "F"]);
  const minor = m.parseProgression("i VI III VII", { root: 9, scale: "minor" }) as Chord[];
  assert.deepEqual(minor.map((x) => m.chordLabel(x)), ["Am", "F", "C", "G"]);
  assert.deepEqual((m.parseProgression("ii7 V7", { root: 0, scale: "major" }) as Chord[]).map((x) => m.chordLabel(x)), ["Dm7", "G7"]);
  assert.ok("error" in (m.parseProgression("C Q G", { root: 0, scale: "major" }) as object));
  assert.equal(m.chordLabel(m.detectChord([60, 64, 67])!), "C");
  assert.equal(m.chordLabel(m.detectChord([57, 60, 64])!), "Am");
  assert.equal(m.chordLabel(m.detectChord([55, 59, 62, 65])!), "G7");
  assert.equal(m.detectChord([]), null);
});

await test("the generators make what they say, the same way every time", () => {
  const chords = m.parseProgression("Am F C G", { root: 9, scale: "minor" }) as Chord[];
  const block = m.chordNotes(chords, { style: "block", octave: 3, beatsEach: 4 });
  assert.equal(block.length, 12);
  assert.ok(block.every((n) => n.start >= 0 && n.start < 16 && n.start + n.length <= 16));
  const arp = m.chordNotes(chords, { style: "arpeggio", beatsEach: 4 });
  assert.equal(arp.length, 32, "eighth notes, four beats, four chords");
  const bass = m.bassNotes(chords, { style: "root", octave: 2, beatsEach: 4 });
  assert.deepEqual(bass.map((n) => m.pitchName(n.pitch)), ["A2", "F2", "C2", "G2"]);
  const walk = m.bassNotes(chords, { style: "walking", beatsEach: 4 });
  assert.equal(walk.length, 16);
  const a = m.drumNotes({ style: "rock", bars: 2, seed: 5 });
  const b = m.drumNotes({ style: "rock", bars: 2, seed: 5 });
  assert.deepEqual(a, b);
  assert.ok(a.some((n) => n.pitch === 36 && n.start === 0), "kick on the one");
  assert.deepEqual([...new Set(a.filter((n) => n.pitch === 38).map((n) => n.start % 4))].sort(), [1, 3], "snare on two and four");
  const floor = m.drumNotes({ style: "four_on_floor", bars: 1 });
  assert.equal(floor.filter((n) => n.pitch === 36).length, 4);
  const filled = m.drumNotes({ style: "rock", bars: 4, fill: true });
  assert.ok(filled.some((n) => n.pitch === 49), "a crash");
  assert.ok(filled.some((n) => n.pitch === 45 && n.start >= 15), "a fill in the last beat of bar four");
});

await test("a song from anything is repaired, never trusted", () => {
  assert.equal(m.normalizeProject(null), null);
  assert.equal(m.normalizeProject({ nope: 1 }), null);
  const p = m.normalizeProject({
    name: "  Mine  ", bpm: 9999, beatsPerBar: 4, key: "D dorian", bars: 2, master: 5, loop: false,
    tracks: [
      { id: "a", name: "Bass", instrument: "bass", volume: 9, pan: -4, clips: [
        { id: "c1", start: 0, length: 4, notes: [
          { id: "n1", pitch: "C2", start: 0, length: 99 },
          { id: "n1", pitch: 40, start: 1 },
          { pitch: 200, start: 0 },
          { pitch: 40, start: 99 },
          "junk",
        ] },
        { id: "c2", start: 30, length: 8, notes: [] },
      ] },
      { id: "a", instrument: "theremin", clips: "no" },
      7,
    ],
  })!;
  assert.equal(p.name, "Mine");
  assert.equal(p.bpm, m.MAX_BPM);
  assert.equal(p.master, 1.2);
  assert.equal(p.loop, false);
  assert.deepEqual(p.key, { root: 2, scale: "dorian" });
  assert.equal(p.tracks.length, 2);
  assert.notEqual(p.tracks[0]!.id, p.tracks[1]!.id, "ids stay unique");
  assert.equal(p.tracks[1]!.instrument, "keys", "an unknown instrument becomes keys");
  assert.equal(p.tracks[0]!.volume, 1.2);
  assert.equal(p.tracks[0]!.pan, -1);
  const notes = p.tracks[0]!.clips[0]!.notes;
  assert.equal(notes.length, 2, "an out-of-range pitch and a note past the end are dropped");
  assert.equal(notes[0]!.length, 4, "a note cannot run past its clip");
  assert.notEqual(notes[0]!.id, notes[1]!.id);
  assert.equal(p.bars, 10, "the song grows to hold a clip placed beyond it");
});

// ------------------------------------------------------------------ specs --

await test("every spec is a studio_ tool with a description and an object schema", () => {
  assert.equal(studioSPECS.length, 9);
  for (const s of studioSPECS) {
    assert.match(s.name, /^studio_[a-z_]+$/);
    assert.ok(s.description.length > 40, s.name);
    assert.equal(s.parameters.type, "object", s.name);
  }
  assert.equal(new Set(studioSPECS.map((s) => s.name)).size, studioSPECS.length);
});

await test("the tools are a family of their own, brought in by the person's words or by use", () => {
  const specs = studioSPECS.map((s) => ({ name: s.name }));
  assert.equal(withoutUnloaded(specs, loadedFamilies({ events: [], said: "what's the weather" , lazy: true})).length, 0);
  for (const said of ["make a beat for me", "open Autora Music", "I want a chord progression in A minor", "write a bassline", "set the bpm to 90", "a song about summer"]) {
    assert.equal(withoutUnloaded(specs, loadedFamilies({ events: [], said, lazy: true })).length, specs.length, said);
  }
  assert.equal(withoutUnloaded(specs, loadedFamilies({ events: [{ kind: "tool.call", payload: { name: "studio_look" } }], lazy: true })).length, specs.length);
});

await test("the Tools page switch turns them off; reading is looking, writing is not", () => {
  assert.equal(windowOff("studio_look"), false);
  assert.equal(windowOff("studio_look", { ...toolSettings(), studio: { enabled: false } }), true);
  assert.equal(windowOff("video_look", { ...toolSettings(), studio: { enabled: false } }), false);
  assert.equal(isLooking("studio_look", {}), true);
  assert.equal(isLooking("studio_play", {}), true);
  assert.equal(isLooking("studio_open", {}), true);
  assert.equal(isLooking("studio_open", { new: "x" }), false);
  assert.equal(isLooking("studio_notes", {}), false);
  assert.equal(isLooking("studio_export", {}), false);
});

// ------------------------------------------------------------------ tools --

const S = "studiotest1";
const shown: Array<{ id: string; name: string; mime: string; size: number }> = [];
const run = (name: string, args: Record<string, any> = {}) => studio.runStudioTool(S, name, args, { showFile: (f) => shown.push(f) });
const states: unknown[] = [];
studio.onStudioChange((id) => { if (id === S) states.push(studio.studioState(S)); });
const song = async (): Promise<Project> => JSON.parse(JSON.stringify((await call("GET", `/api/studio/${S}/doc`)).body.doc)) as Project;

// ----------------------------------------------------------------- routes --

const app = express();
const sent: Array<Record<string, any>> = [];
studio.studioRoutes(app, {
  exists: (id) => id === S || id === "studiotest2" || id === "studiotest3",
  incognito: (id) => id === "studiotest2",
  off: () => false,
  push: (_id, message) => { sent.push(message); },
});
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const call = async (method: string, url: string, body?: unknown, raw?: Buffer): Promise<{ status: number; body: any }> => {
  const res = await fetch(base + url, {
    method,
    headers: { "content-type": raw ? "audio/wav" : "application/json" },
    body: raw ? new Uint8Array(raw) : body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};

await test("a tool call opens the window and starts a song", async () => {
  assert.equal(studio.studioState(S).open, false);
  const out = await run("studio_open", { new: "Night drive", bpm: 92, key: "A minor" });
  assert.ok(out.ok, out.summary);
  assert.match(out.summary, /Night drive/);
  assert.match(out.summary, /92 bpm/);
  assert.match(out.summary, /A minor/);
  const state = studio.studioState(S);
  assert.equal(state.open, true);
  assert.equal(state.by, "agent");
  assert.ok(states.length > 0, "the page is told");
});

await test("chords, a bass that follows them and a beat: one call each", async () => {
  const chords = await run("studio_make", { kind: "chords", progression: "i VI III VII", style: "arpeggio", bars: 8 });
  assert.ok(chords.ok, chords.summary);
  assert.match(chords.summary, /Am F C G Am F C G/);
  let p = await song();
  assert.equal(p.tracks.length, 1);
  assert.equal(p.tracks[0]!.instrument, "keys");
  assert.equal(p.tracks[0]!.clips[0]!.length, 32);
  assert.equal(p.bars, 8);

  const bass = await run("studio_make", { kind: "bass", style: "eighths", bars: 4 });
  assert.ok(bass.ok, bass.summary);
  assert.match(bass.summary, /read from the chords already in the song/);
  assert.match(bass.summary, /Am F C G/);
  p = await song();
  const b = p.tracks.find((t) => t.instrument === "bass")!;
  assert.ok(b, "the bass track was made");
  assert.equal(m.pitchName(b.clips[0]!.notes[0]!.pitch), "A2");

  const drums = await run("studio_make", { kind: "drums", style: "boom_bap", bars: 4, fill: true, track: "Beat" });
  assert.ok(drums.ok, drums.summary);
  p = await song();
  const d = p.tracks.find((t) => t.instrument === "kit")!;
  assert.equal(d.name, "Beat");
  assert.ok(d.clips[0]!.notes.some((n) => n.pitch === 36));
  assert.equal(p.tracks.length, 3);
});

await test("bad requests say what to do instead", async () => {
  const noProg = await run("studio_make", { kind: "chords" });
  assert.equal(noProg.ok, false);
  assert.match(noProg.summary, /progression/);
  const badChord = await run("studio_make", { kind: "chords", progression: "C Zz G" });
  assert.equal(badChord.ok, false);
  assert.match(badChord.summary, /"Zz" is not a chord/);
  const badStyle = await run("studio_make", { kind: "drums", style: "polka" });
  assert.match(badStyle.summary, /rock/);
  const noClip = await run("studio_notes", { action: "clear", clip: "nope" });
  assert.equal(noClip.ok, false);
  assert.match(noClip.summary, /studio_look/);
  const noTrack = await run("studio_track", { action: "set", track: "Kazoo", volume: 1 });
  assert.match(noTrack.summary, /Tracks: /);
  assert.equal((await run("studio_track", { action: "fly" })).ok, false);
  assert.equal((await run("studio_nonsense")).ok, false);
  assert.equal((await run("studio_song", {})).ok, false);
  const before = (await song()).tracks.length;
  assert.equal((await run("studio_song", { key: "Q sharp" })).ok, false);
  assert.equal((await song()).tracks.length, before, "a refused call changes nothing");
});

await test("looking tells the song, the observations, and which clip the person has open", async () => {
  const p = await song();
  const clip = p.tracks[0]!.clips[0]!;
  assert.equal((await call("POST", `/api/studio/${S}/focus`, { trackId: p.tracks[0]!.id, clipId: clip.id })).status, 200);
  const out = await run("studio_look", { clip: clip.id });
  assert.ok(out.ok);
  assert.match(out.summary, /Song "Night drive"/);
  assert.match(out.summary, new RegExp(clip.id));
  assert.match(out.summary, /"this clip" means that one/);
  assert.match(out.summary, /0: A3\(0\.45\)/, "the notes, beat by beat");
  assert.equal((await run("studio_look", { clip: "nope" })).ok, false);
});

await test("notes: add, transpose a window, quantize, humanize, velocity, remove", async () => {
  await run("studio_track", { action: "add", instrument: "lead", name: "Tune" });
  let p = await song();
  const lead = p.tracks.find((t) => t.name === "Tune")!;
  const made = await run("studio_clip", { action: "add", track: "Tune", bar: 2, bars: 2, name: "Hook", notes: [
    { pitch: "A4", start: 0.1, length: 1 }, { pitch: "C5", start: 1.02, length: 1 }, { pitch: "E5", start: 2, length: 2, vel: 0.5 }, { pitch: "G5", start: 9, length: 1 },
  ] });
  assert.ok(made.ok, made.summary);
  assert.match(made.summary, /1 note was past the clip's end/);
  p = await song();
  const clip = p.tracks.find((t) => t.id === lead.id)!.clips[0]!;
  assert.equal(clip.start, 4, "bar 2 in 4/4 is beat 4");
  assert.equal(clip.notes.length, 3);

  assert.ok((await run("studio_notes", { action: "quantize", clip: clip.id, grid: "1/4" })).ok);
  p = await song();
  assert.deepEqual(p.tracks.find((t) => t.id === lead.id)!.clips[0]!.notes.map((n) => n.start), [0, 1, 2]);

  assert.ok((await run("studio_notes", { action: "transpose", clip: clip.id, semitones: 12, from: 2, to: 4 })).ok);
  p = await song();
  assert.deepEqual(p.tracks.find((t) => t.id === lead.id)!.clips[0]!.notes.map((n) => m.pitchName(n.pitch)), ["A4", "C5", "E6"]);

  assert.ok((await run("studio_notes", { action: "velocity", clip: clip.id, vel: 0.3, low: "E6" })).ok);
  p = await song();
  assert.equal(p.tracks.find((t) => t.id === lead.id)!.clips[0]!.notes[2]!.vel, 0.3);

  const before = JSON.stringify(p.tracks.find((t) => t.id === lead.id)!.clips[0]!.notes.map((n) => n.start));
  assert.ok((await run("studio_notes", { action: "humanize", clip: clip.id, amount: 1 })).ok);
  p = await song();
  assert.notEqual(JSON.stringify(p.tracks.find((t) => t.id === lead.id)!.clips[0]!.notes.map((n) => n.start)), before);

  const first = p.tracks.find((t) => t.id === lead.id)!.clips[0]!.notes[0]!;
  assert.ok((await run("studio_notes", { action: "remove", clip: clip.id, ids: [first.id] })).ok);
  assert.equal((await run("studio_notes", { action: "remove", clip: clip.id })).ok, false, "remove with no target is refused, not everything");
  p = await song();
  assert.equal(p.tracks.find((t) => t.id === lead.id)!.clips[0]!.notes.length, 2);

  const bad = await run("studio_notes", { action: "add", clip: clip.id, notes: [{ pitch: "Z9", start: 0 }] });
  assert.equal(bad.ok, false);
  assert.match(bad.summary, /not a note/);
});

await test("drum notes take drum names; drums are never transposed", async () => {
  const p = await song();
  const kit = p.tracks.find((t) => t.instrument === "kit")!;
  const clip = kit.clips[0]!;
  const out = await run("studio_notes", { action: "replace", clip: clip.id, notes: [{ pitch: "kick", start: 0 }, { pitch: "snare", start: 1 }, { pitch: "hat", start: 0.5 }] });
  assert.ok(out.ok, out.summary);
  const after = (await song()).tracks.find((t) => t.id === kit.id)!.clips[0]!.notes.map((n) => n.pitch).sort();
  assert.deepEqual(after, [36, 38, 42]);
  assert.equal((await run("studio_notes", { action: "transpose", clip: clip.id, semitones: 2 })).ok, false);
  assert.equal((await run("studio_notes", { action: "add", clip: clip.id, notes: [{ pitch: "tuba", start: 0 }] })).ok, false);
});

await test("clips: move, resize (notes past the end are cut), split, duplicate, rename, remove", async () => {
  let p = await song();
  const bass = p.tracks.find((t) => t.instrument === "bass")!;
  const clip = bass.clips[0]!;
  assert.ok((await run("studio_clip", { action: "split", clip: clip.id, bar: 3 })).ok);
  p = await song();
  const parts = p.tracks.find((t) => t.id === bass.id)!.clips;
  assert.equal(parts.length, 2);
  assert.equal(parts[0]!.length, 8);
  assert.equal(parts[1]!.start, 8);
  assert.equal(parts[0]!.notes.length + parts[1]!.notes.length, clip.notes.length, "no note lost in a split");
  assert.ok(parts[1]!.notes.every((n) => n.start < parts[1]!.length));
  assert.equal((await run("studio_clip", { action: "split", clip: parts[0]!.id, bar: 9 })).ok, false, "a cut outside the clip is refused");

  assert.ok((await run("studio_clip", { action: "resize", clip: parts[1]!.id, bars: 1 })).ok);
  assert.ok((await run("studio_clip", { action: "move", clip: parts[1]!.id, bar: 6 })).ok);
  assert.ok((await run("studio_clip", { action: "rename", clip: parts[1]!.id, name: "Outro" })).ok);
  const dup = await run("studio_clip", { action: "duplicate", clip: parts[1]!.id, times: 2 });
  assert.ok(dup.ok, dup.summary);
  p = await song();
  const after = p.tracks.find((t) => t.id === bass.id)!.clips;
  assert.equal(after.length, 4);
  assert.deepEqual(after.filter((c) => c.name === "Outro").map((c) => c.start).sort((a, b) => a - b), [20, 24, 28]);
  assert.equal(new Set(after.flatMap((c) => c.notes.map((n) => n.id))).size, after.reduce((n, c) => n + c.notes.length, 0), "copies have their own note ids");
  assert.ok((await run("studio_clip", { action: "remove", clip: parts[0]!.id })).ok);
});

await test("tracks: the mixer, instruments that fit the notes, duplicate, clear, remove", async () => {
  let p = await song();
  const keys = p.tracks.find((t) => t.instrument === "keys")!;
  const set = await run("studio_track", { action: "set", track: keys.name, volume: 0.5, pan: -0.3, reverb: 0.6, mute: true, name: "Chords" });
  assert.ok(set.ok, set.summary);
  p = await song();
  const t = p.tracks.find((x) => x.id === keys.id)!;
  assert.deepEqual([t.name, t.volume, t.pan, t.reverb, t.mute], ["Chords", 0.5, -0.3, 0.6, true]);
  assert.ok((await run("studio_track", { action: "set", track: "Chords", volume: 5 })).ok);
  assert.equal((await song()).tracks.find((x) => x.id === keys.id)!.volume, 1.2, "clamped, not refused");
  const wrong = await run("studio_track", { action: "set", track: "Chords", instrument: "kit" });
  assert.equal(wrong.ok, false, "drums and pitched notes are not interchangeable");
  assert.ok((await run("studio_track", { action: "set", track: "Chords", instrument: "pad" })).ok);
  assert.ok((await run("studio_track", { action: "duplicate", track: "Chords" })).ok);
  p = await song();
  const copy = p.tracks.find((x) => x.name === "Chords copy")!;
  assert.ok(copy && copy.clips.length === 1 && copy.clips[0]!.id !== t.clips[0]!.id);
  assert.ok((await run("studio_track", { action: "clear", track: copy.id })).ok);
  assert.ok((await run("studio_track", { action: "remove", track: copy.id })).ok);
  assert.equal((await song()).tracks.some((x) => x.id === copy.id), false);
});

await test("the song: tempo and key change, notes do not move", async () => {
  const before = JSON.stringify((await song()).tracks);
  const out = await run("studio_song", { bpm: 120, key: "D dorian", beats_per_bar: 4, master: 0.8, loop: false, name: "Night drive 2" });
  assert.ok(out.ok, out.summary);
  const p = await song();
  assert.equal(p.bpm, 120);
  assert.deepEqual(p.key, { root: 2, scale: "dorian" });
  assert.equal(p.loop, false);
  assert.equal(JSON.stringify(p.tracks), before);
  assert.equal((await run("studio_song", { bpm: 5000 })).ok, true);
  assert.equal((await song()).bpm, m.MAX_BPM);
});

await test("a song with a problem is told about it", async () => {
  await run("studio_track", { action: "add", instrument: "bass", name: "Low" });
  const p = await song();
  const low = p.tracks.find((t) => t.name === "Low")!;
  await run("studio_clip", { action: "add", track: low.id, bar: 1, bars: 1, notes: [
    { pitch: "C#2", start: 0 }, { pitch: "D#2", start: 1 }, { pitch: "F#2", start: 2 }, { pitch: "G#2", start: 3 },
  ] });
  await run("studio_track", { action: "set", track: low.id, volume: 0.1 });
  const out = await run("studio_look");
  assert.match(out.summary, /outside D dorian/);
  assert.match(out.summary, /volumes are far apart/);
});

await test("starting a new song never throws away notes unasked", async () => {
  const refused = await run("studio_open", { new: "Fresh" });
  assert.equal(refused.ok, false);
  assert.match(refused.summary, /replace: true/);
  assert.equal((await song()).name, "Night drive 2");
  const ok = await run("studio_open", { new: "Fresh", replace: true });
  assert.ok(ok.ok, ok.summary);
  const p = await song();
  assert.equal(p.name, "Fresh");
  assert.equal(p.tracks.length, 0);
  const second = await run("studio_open", { new: "Another" });
  assert.ok(second.ok, "an empty song may be replaced");
});

await test("a chat with the window open is told so at the start of a turn", async () => {
  const note = studio.studioTurnNote(S)!;
  assert.match(note, /music window is open on "Another"/);
  assert.equal(studio.studioTurnNote("nobody"), null);
  assert.match(studio.studioBriefing(true), /tools_enable studio/);
  assert.match(studio.studioBriefing(false), /switched off/);
});

// ----------------------------------------------------------- the window --

await test("the window reads the song the agent made", async () => {
  await run("studio_make", { kind: "drums", style: "rock", bars: 1 });
  const r = await call("GET", `/api/studio/${S}/doc`);
  assert.equal(r.status, 200);
  assert.equal(r.body.doc.tracks.length, 1);
  assert.equal(r.body.rev, studio.studioState(S).rev);
});

await test("a change made in the window is marked as the person's", async () => {
  const { body } = await call("GET", `/api/studio/${S}/doc`);
  body.doc.tracks[0].name = "My kit";
  body.doc.bpm = 77;
  const put = await call("PUT", `/api/studio/${S}/doc`, { doc: body.doc, rev: body.rev });
  assert.equal(put.status, 200);
  assert.equal(studio.studioState(S).by, "person");
  assert.equal(studio.studioState(S).bpm, 77);
  const look = await run("studio_look");
  assert.match(look.summary, /My kit/);
  assert.match(look.summary, /77 bpm/);
});

await test("a save from a window that has not seen the agent's latest change is refused", async () => {
  const { body } = await call("GET", `/api/studio/${S}/doc`);
  await run("studio_song", { bpm: 140 });
  const stale = await call("PUT", `/api/studio/${S}/doc`, { doc: body.doc, rev: body.rev });
  assert.equal(stale.status, 409);
  assert.equal((await song()).bpm, 140, "the agent's change stands");
  const fresh = await call("GET", `/api/studio/${S}/doc`);
  assert.equal((await call("PUT", `/api/studio/${S}/doc`, { doc: fresh.body.doc, rev: fresh.body.rev })).status, 200);
  // And after the person's own save, a second one from the same window is fine.
  assert.equal((await call("PUT", `/api/studio/${S}/doc`, { doc: fresh.body.doc, rev: fresh.body.rev })).status, 200);
});

await test("a song that is not one is refused and nothing changes", async () => {
  const before = studio.studioState(S).rev;
  assert.equal((await call("PUT", `/api/studio/${S}/doc`, { doc: { nope: 1 } })).status, 400);
  assert.equal((await call("PUT", `/api/studio/${S}/doc`, {})).status, 400);
  assert.equal(studio.studioState(S).rev, before);
});

await test("an unknown chat is refused", async () => {
  assert.equal((await call("GET", "/api/studio/nobody")).status, 404);
  assert.equal((await call("GET", "/api/studio/..%2Fx/doc")).status, 404);
});

await test("an incognito chat gets no window; others open one from the toolbox", async () => {
  const no = await call("POST", "/api/studio/studiotest2/open");
  assert.equal(no.status, 409);
  assert.equal(studio.studioState("studiotest2").open, false);
  const yes = await call("POST", "/api/studio/studiotest3/open");
  assert.equal(yes.status, 200);
  assert.equal(yes.body.open, true);
  studio.dropStudio("studiotest3");
});

await test("play, stop and export are commands to the open window, answered by it", async () => {
  // The window has not said it is up: the tool says so instead of hanging.
  await call("POST", `/api/studio/${S}/close`);
  await call("POST", `/api/studio/${S}/open`);
  await call("POST", `/api/studio/${S}/ready`, { ready: true });

  sent.length = 0;
  const playing = run("studio_play", { action: "play", bar: 2 });
  await new Promise((r) => setTimeout(r, 60));
  const cmd = sent.find((x) => x.type === "studio.command")!;
  assert.equal(cmd.name, "play");
  assert.equal(cmd.args.beat, 4);
  assert.equal((await call("POST", `/api/studio/${S}/claim?id=${cmd.id}`)).body.won, true);
  assert.equal((await call("POST", `/api/studio/${S}/claim?id=${cmd.id}`)).body.won, false, "only the first tab does it");
  await call("POST", `/api/studio/${S}/reply`, { id: cmd.id, ok: true, value: { playing: true } });
  const done = await playing;
  assert.ok(done.ok && /Playing from bar 2/.test(done.summary), done.summary);

  sent.length = 0;
  const blocked = run("studio_play", { action: "play" });
  await new Promise((r) => setTimeout(r, 60));
  const c2 = sent.find((x) => x.type === "studio.command")!;
  await call("POST", `/api/studio/${S}/claim?id=${c2.id}`);
  await call("POST", `/api/studio/${S}/reply`, { id: c2.id, ok: true, value: { playing: false, blocked: true } });
  assert.match((await blocked).summary, /tapped something/);

  sent.length = 0;
  const exporting = run("studio_export", { name: "Night / drive" });
  await new Promise((r) => setTimeout(r, 60));
  const c3 = sent.find((x) => x.type === "studio.command")!;
  assert.equal(c3.name, "export");
  assert.equal(c3.args.name, "Night - drive");
  await call("POST", `/api/studio/${S}/claim?id=${c3.id}`);
  const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(200)]);
  const delivered = await call("POST", `/api/studio/${S}/deliver?name=${encodeURIComponent("Night - drive")}`, undefined, wav);
  assert.equal(delivered.status, 200);
  await call("POST", `/api/studio/${S}/reply`, { id: c3.id, ok: true, value: delivered.body });
  const out = await exporting;
  assert.ok(out.ok, out.summary);
  assert.equal(shown.length, 1);
  const art = getArtifact(shown[0]!.id)!;
  assert.equal(art.name, "Night - drive.wav");
  assert.equal(art.mime, "audio/wav");
  assert.equal(art.size, wav.length);
});

await test("an empty song has nothing to export; a closed window rejects what is waiting on it", async () => {
  await run("studio_open", { new: "Silence", replace: true });
  assert.match((await run("studio_export")).summary, /nothing to export/);
  await call("POST", `/api/studio/${S}/ready`, { ready: true });
  await run("studio_make", { kind: "drums", style: "rock" });
  sent.length = 0;
  const waiting = run("studio_export");
  await new Promise((r) => setTimeout(r, 60));
  await call("POST", `/api/studio/${S}/close`);
  const out = await waiting;
  assert.equal(out.ok, false);
  assert.match(out.summary, /closed/);
});

await test("the song is kept: another start of the server finds it", async () => {
  const { flushStore } = await import("../server/store");
  flushStore();
  const file = path.join(dir, `studio-${S}.json`);
  assert.ok(fs.existsSync(file), "saved");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved.project.name, "Silence");
  studio.dropStudio(S);
  assert.equal(fs.existsSync(file), false, "and gone with the chat");
});

server.close();
console.log(`\n${passed} studio tests passed`);
process.exit(0);
