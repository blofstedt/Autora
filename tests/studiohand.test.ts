/**
 * The steps the agent's hand takes in the Music window (src/lib/studio/handsteps.ts): from the song as it is to the song
 * the tool made, each a thing a person does with the window's controls, and what has no control left for the finished song.
 *
 *   npx tsx tests/studiohand.test.ts
 */
import assert from "node:assert/strict";
import { MAX_HAND_NOTES, studioSteps, stepWords } from "../src/lib/studio/handsteps";
import { newClip, newProject, newTrack, type Project } from "../src/lib/studio/model";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}
const copy = (p: Project) => structuredClone(p);
const kinds = (p: ReturnType<typeof studioSteps>) => p.steps.map((s) => s.k);

const base = newProject("Song");
const keys = newTrack(base, "keys");
base.tracks.push(keys);
const clip = newClip(0, 4, "Keys 1");
clip.notes.push({ id: "n1", pitch: 60, start: 0, length: 1, vel: 0.8 }, { id: "n2", pitch: 64, start: 1, length: 1, vel: 0.8 });
keys.clips.push(clip);

test("the song's tempo, key and name are the Song tray's and the name field's", () => {
  const next = copy(base);
  next.bpm = 96; next.name = "Night"; next.key = { root: 9, scale: "minor" };
  const plan = studioSteps("studio_song", { bpm: 96 }, base, next);
  assert.deepEqual(kinds(plan), ["name", "tempo", "key"]);
  assert.match(stepWords(plan.steps[1]!), /tempo to 96 in the Song tray/);
});

test("a new track is Add track and the instrument, then its name, and its levels checked", () => {
  const next = copy(base);
  const t = newTrack(next, "pad", "Strings");
  next.tracks.push(t);
  const plan = studioSteps("studio_track", { action: "add" }, base, next);
  assert.equal(plan.steps[0]!.k, "addTrack");
  assert.ok(plan.steps.some((s) => s.k === "renameTrack" && s.name === "Strings"));
  assert.equal(plan.steps.filter((s) => s.k === "mix").length, 3);
});

test("a new clip is drawn on its lane, and its notes placed on the grid they sit on", () => {
  const next = copy(base);
  const c = newClip(4, 4, "Line");
  c.notes.push({ id: "a", pitch: 62, start: 0.5, length: 0.5, vel: 0.8 });
  next.tracks[0]!.clips.push(c);
  const plan = studioSteps("studio_clip", { action: "add" }, base, next);
  assert.deepEqual(kinds(plan), ["drawClip", "notes"]);
  const notes = plan.steps[1]!;
  assert.ok(notes.k === "notes" && notes.snap === 0.5 && notes.add.length === 1 && !notes.drum);
});

test("a shift of every note is the roll's own buttons: an octave and a semitone", () => {
  const next = copy(base);
  for (const n of next.tracks[0]!.clips[0]!.notes) n.pitch += 13;
  const plan = studioSteps("studio_notes", { action: "transpose", semitones: 13 }, base, next);
  assert.deepEqual(plan.steps.map((s) => (s.k === "rollTool" ? s.tool : s.k)), ["+8", "♯"]);
});

test("a clip deleted, moved, renamed; a duplicate and a split by the bar's tools", () => {
  const gone = copy(base);
  gone.tracks[0]!.clips = [];
  assert.deepEqual(kinds(studioSteps("studio_clip", { action: "remove", clip: clip.id }, base, gone)), ["clipTool"]);
  const moved = copy(base);
  moved.tracks[0]!.clips[0]!.start = 8;
  moved.tracks[0]!.clips[0]!.name = "Later";
  assert.deepEqual(kinds(studioSteps("studio_clip", { action: "move" }, base, moved)), ["moveClip", "renameClip"]);
  const dup = copy(base);
  dup.tracks[0]!.clips.push({ ...structuredClone(clip), id: "c2", start: 4 });
  const d = studioSteps("studio_clip", { action: "duplicate", clip: clip.id }, base, dup);
  assert.ok(d.steps.length === 1 && d.steps[0]!.k === "clipTool" && d.steps[0]!.tool === "Duplicate" && d.steps[0]!.made === "c2");
});

test("more notes than a hand places in one call: the rest are counted, for the finished song", () => {
  const next = copy(base);
  const c = next.tracks[0]!.clips[0]!;
  for (let i = 0; i < MAX_HAND_NOTES + 10; i++) c.notes.push({ id: `x${i}`, pitch: 48 + (i % 24), start: (i % 16) * 0.25, length: 0.25, vel: 0.8 });
  const plan = studioSteps("studio_notes", { action: "add" }, base, next);
  assert.equal(plan.skipped, 10);
  const notes = plan.steps.find((s) => s.k === "notes");
  assert.ok(notes && notes.k === "notes" && notes.add.length === MAX_HAND_NOTES);
});

test("nothing a hand can do (a velocity) is no steps: the finished song simply goes in", () => {
  const next = copy(base);
  next.tracks[0]!.clips[0]!.notes[0]!.vel = 0.3;
  assert.equal(studioSteps("studio_notes", { action: "velocity" }, base, next).steps.length, 0);
});

console.log(`studiohand: ${passed} passed`);
