/**
 * Autora Studio: the music window. The song lives on the server (server/studio.ts) and in the window beside the chat;
 * these tools are the agent's hands on the same song, so the person watches the clips appear and can change anything
 * by hand. Times are in bars and beats, pitches are note names ("C4", "F#3") or MIDI numbers, drums are named
 * ("kick", "snare", "hat").
 */

import type { ToolSpec } from "../tools";

const NOTE = {
  type: "object",
  properties: {
    pitch: { type: ["string", "number"], description: "A note name (\"C4\", \"F#3\", \"Bb2\"), a MIDI number (60 is middle C), or on a drum track the drum: kick, snare, clap, rim, hat, openhat, tomlow, tommid, crash." },
    start: { type: "number", description: "Beats from the start of the clip (0 is the first beat; 0.5 is the offbeat; 4 is the start of bar two in 4/4)." },
    length: { type: "number", description: "How long, in beats. Default 1; drums ignore it." },
    vel: { type: "number", description: "How hard, 0 to 1. Default 0.8." },
  },
  required: ["pitch", "start"],
};

export const studioSPECS: ToolSpec[] = [
  {
    name: "studio_open",
    group: "files",
    description:
      "Open Autora Studio (the music window) beside the chat. With no arguments it opens on this chat's song and " +
      "returns it. Pass `new` (a name) to start a fresh, empty song, with optional `bpm` and `key`; if the song " +
      "already has notes in it, the person's work would be lost, so that needs `replace: true` -- only when they " +
      "asked to start over. The other studio tools open the window themselves.",
    parameters: {
      type: "object",
      properties: {
        new: { type: "string", description: "A name for a new, empty song." },
        bpm: { type: "number", description: "Tempo of the new song, 30 to 300. Default 100." },
        key: { type: "string", description: "Key of the new song: \"C\", \"A minor\", \"F# dorian\"..." },
        replace: { type: "boolean", description: "Allow `new` to throw away a song that has notes in it." },
      },
    },
  },
  {
    name: "studio_look",
    group: "files",
    description:
      "Read the song: tempo, key, every track and clip with its id and position, and a few honest observations " +
      "(a clip with no notes, notes outside the key, no bass, tracks far apart in volume). Pass `clip` to see that " +
      "clip's notes, beat by beat. Also says which clip the person has open in the editor, so \"this clip\" and " +
      "\"fix that bass\" mean something. Read it before you change anything and again after; the person edits " +
      "the same song. You cannot hear it: this and its observations are how you check your work, and only the " +
      "person can say how it sounds. Changes nothing.",
    parameters: {
      type: "object",
      properties: { clip: { type: "string", description: "A clip id: list its notes." } },
    },
  },
  {
    name: "studio_song",
    group: "files",
    risky: true,
    description:
      "Change the song as a whole: `name`, `bpm` (30-300), `key` (\"A minor\", \"C\", \"D dorian\"; scales: major, minor, " +
      "dorian, phrygian, lydian, mixolydian, harmonic minor, major pentatonic, minor pentatonic, blues), `beats_per_bar` " +
      "(3 for waltz time, default 4), `bars` (how long the song is), `master` volume 0-1.2 and `loop` (on = repeats). " +
      "Changing the tempo or the key does not move or change any notes; transposing is studio_notes.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        bpm: { type: "number" },
        key: { type: "string" },
        beats_per_bar: { type: "integer" },
        bars: { type: "integer" },
        master: { type: "number" },
        loop: { type: "boolean" },
      },
    },
  },
  {
    name: "studio_track",
    group: "files",
    risky: true,
    description:
      "Tracks and the mixer. `action`:\n" +
      "- add: a new track. instrument (keys, synth, bass, pluck, pad, lead, kit = drums); optional name, and any of " +
      "the mixer settings below.\n" +
      "- set: change a track (`track` is its id or name): name, instrument, volume (0-1.2, 0.75 is normal), pan (-1 " +
      "left to 1 right), reverb (0-1), mute, solo, color (#rrggbb).\n" +
      "- duplicate: copy a track with its clips.  clear: remove its clips, keep the track.  remove: delete it.\n" +
      "To balance a mix, set volumes and pans here; keep drums and bass centred.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "set", "duplicate", "clear", "remove"] },
        track: { type: "string", description: "A track id or its name." },
        instrument: { type: "string", enum: ["keys", "synth", "bass", "pluck", "pad", "lead", "kit"] },
        name: { type: "string" },
        volume: { type: "number" },
        pan: { type: "number" },
        reverb: { type: "number" },
        mute: { type: "boolean" },
        solo: { type: "boolean" },
        color: { type: "string" },
      },
      required: ["action"],
    },
  },
  {
    name: "studio_clip",
    group: "files",
    risky: true,
    description:
      "Clips: the blocks on a track that hold notes. `action`:\n" +
      "- add: a clip on `track`. `bar` (1 is the first bar; or `start` in beats) and `bars` (or `length` in beats); " +
      "optional `name` and `notes` (same shape as studio_notes add).\n" +
      "- move: `clip`, to `bar`/`start`, optionally to another `track`.  resize: `clip`, `bars`/`length` (notes past the " +
      "new end are cut).  rename: `clip`, `name`.\n" +
      "- duplicate: copy `clip` straight after itself `times` times (default 1), or to `bar`/`start`.\n" +
      "- split: cut `clip` in two at `bar`/`start`.  remove: delete `clip`.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "move", "resize", "rename", "duplicate", "split", "remove"] },
        track: { type: "string" },
        clip: { type: "string" },
        bar: { type: "number", description: "Bar number, counting from 1 (fractions allowed: 2.5 is the middle of bar two)." },
        start: { type: "number", description: "Position in beats from the start of the song (0-based). Overrides bar." },
        bars: { type: "number" },
        length: { type: "number", description: "Length in beats. Overrides bars." },
        name: { type: "string" },
        times: { type: "integer" },
        notes: { type: "array", items: NOTE },
      },
      required: ["action"],
    },
  },
  {
    name: "studio_notes",
    group: "files",
    risky: true,
    description:
      "The notes inside a clip. `action`:\n" +
      "- add: `notes` ([{pitch, start, length, vel}], times in beats from the clip's start). Notes past the clip's end " +
      "are skipped, and it says so.\n" +
      "- replace: all of the clip's notes become `notes`.  clear: remove them all.\n" +
      "- remove: by `ids` (from studio_look clip), or everything in a window: `from`/`to` (beats) and `low`/`high` pitch.\n" +
      "- transpose: `semitones` (negative is down), for the whole clip or the same window.  A drum clip is never transposed.\n" +
      "- quantize: pull timing onto a grid. `grid` (\"1/4\", \"1/8\", \"1/16\", \"1/8t\"), `strength` 0-1 (default 1), " +
      "`lengths` true to snap lengths too.  humanize: loosen timing and velocity by `amount` 0-1 (default 0.5).\n" +
      "- velocity: set `vel` on the notes in the window.\n" +
      "A tune the person is writing is theirs: write notes of a melody when they ask you to, otherwise help with the " +
      "backing (studio_make) and the editing.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "replace", "clear", "remove", "transpose", "quantize", "humanize", "velocity"] },
        clip: { type: "string", description: "A clip id." },
        notes: { type: "array", items: NOTE },
        ids: { type: "array", items: { type: "string" } },
        from: { type: "number" },
        to: { type: "number" },
        low: { type: ["string", "number"], description: "Lowest pitch of the window (a note name or number, or a drum name)." },
        high: { type: ["string", "number"], description: "Highest pitch of the window." },
        semitones: { type: "number" },
        grid: { type: "string" },
        strength: { type: "number" },
        lengths: { type: "boolean" },
        amount: { type: "number" },
        vel: { type: "number" },
      },
      required: ["action", "clip"],
    },
  },
  {
    name: "studio_make",
    group: "files",
    risky: true,
    description:
      "Lay down a backing part in one step: chords, a bass line that follows them, or a drum beat. It makes a clip " +
      "(on `track`, which it creates with the right instrument if you name none that exists) and fills it. `kind`:\n" +
      "- chords: `progression` as chord names (\"Am F C G\", \"Cmaj7 G/B Am7\") or numerals in the song's key " +
      "(\"vi IV I V\", \"i VI III VII\"), one chord per bar unless `beats_each` says otherwise. `style`: block, arpeggio, " +
      "strum, pulse, offbeat. `octave` (default 3), `spread` for an open voicing.\n" +
      "- bass: the same `progression`; `style`: root, octaves, eighths, walking, syncopated. `octave` default 2.\n" +
      "- drums: `style`: four_on_floor, rock, boom_bap, trap, half_time, breakbeat, shuffle; `swing` 0-0.5, `fill` for a " +
      "fill every fourth bar, `feel` 0-0.5 for looseness.\n" +
      "`bar` is where the clip goes (default 1), `bars` how long (chords and bass default to the progression's length, " +
      "repeating it to fill `bars`; drums default 4). Pass `clip` to rewrite an existing clip instead of adding one. " +
      "These are the scaffolding; the melody and the choices are the person's. Offer options (\"want it moodier or " +
      "brighter?\") instead of deciding for them when it is a matter of taste.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["chords", "bass", "drums"] },
        track: { type: "string", description: "A track id or name; made if there is no such track." },
        clip: { type: "string", description: "An existing clip to rewrite." },
        progression: { type: "string" },
        style: { type: "string" },
        bar: { type: "number" },
        bars: { type: "number" },
        beats_each: { type: "number", description: "Beats each chord lasts (default: a bar)." },
        octave: { type: "integer" },
        spread: { type: "boolean" },
        swing: { type: "number" },
        fill: { type: "boolean" },
        feel: { type: "number" },
        name: { type: "string" },
      },
      required: ["kind"],
    },
  },
  {
    name: "studio_play",
    group: "files",
    description:
      "Play the song in the person's window, stop it, or move the playhead (`action`: play, stop, seek; `bar` to start " +
      "or seek from). You cannot hear it: playing is for the person, who may need to tap play once before the " +
      "browser lets a page make sound, and the tool says if that is the case. Use studio_look to check what " +
      "is in the song.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["play", "stop", "seek"] },
        bar: { type: "number", description: "Bar to play or seek from, counting from 1." },
      },
      required: ["action"],
    },
  },
  {
    name: "studio_export",
    group: "files",
    risky: true,
    description:
      "Bounce the song to a stereo WAV file (16-bit, 44.1 kHz) and put it in the thread to play and download. Only " +
      "when the person asks for a file. The window does the rendering, so it opens if it is not.",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "File name, without the extension. Default: the song's name." } },
    },
  },
];
