/**
 * Autora Music's song, and everything that can be worked out about it without a sound card.
 *
 * A song is tracks, each holding clips, each holding notes. Times are in beats (a quarter note is 1), so changing the
 * tempo never moves anything. The model is plain JSON: the window (components/StudioWindow.tsx) edits it and plays it
 * with Web Audio (lib/studio/engine.ts), and the server (server/studio.ts) keeps it per chat and edits it for the agent's
 * `studio_*` tools. Both import this file, so there is one idea of what a valid song is.
 *
 * No DOM, no React, no Node: it must run in the browser, in the server and in a test.
 */

// ------------------------------------------------------------------ types --

export type InstrumentId = "keys" | "synth" | "bass" | "pluck" | "pad" | "lead" | "kit";

export interface Note {
  id: string;
  /** MIDI number: 60 is middle C (C4). On a drum track it picks the drum (see DRUMS). */
  pitch: number;
  /** Beats from the start of its clip. */
  start: number;
  length: number;
  /** How hard, 0 to 1. */
  vel: number;
}

export interface Clip {
  id: string;
  name: string;
  /** Beats from the start of the song. */
  start: number;
  length: number;
  notes: Note[];
}

export interface Track {
  id: string;
  name: string;
  instrument: InstrumentId;
  color: string;
  /** 0 to 1.2. */
  volume: number;
  /** -1 (left) to 1 (right). */
  pan: number;
  mute: boolean;
  solo: boolean;
  /** How much goes to the reverb, 0 to 1. */
  reverb: number;
  clips: Clip[];
}

export type ScaleName =
  | "major" | "minor" | "dorian" | "phrygian" | "lydian" | "mixolydian" | "harmonic minor" | "major pentatonic" | "minor pentatonic" | "blues";

export interface Project {
  v: 1;
  name: string;
  bpm: number;
  beatsPerBar: number;
  key: { root: number; scale: ScaleName };
  /** How many bars the song shows and loops over (it grows to hold a clip placed past it). */
  bars: number;
  /** Master volume, 0 to 1.2. */
  master: number;
  loop: boolean;
  tracks: Track[];
}

// -------------------------------------------------------------- the basics --

export const MAX_TRACKS = 24;
export const MAX_CLIPS_PER_TRACK = 200;
export const MAX_NOTES_PER_CLIP = 4000;
export const MAX_BARS = 256;
export const MIN_BPM = 30;
export const MAX_BPM = 300;

export const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;

export const INSTRUMENTS: ReadonlyArray<{ id: InstrumentId; name: string; about: string; drums: boolean; range: [number, number] }> = [
  { id: "keys", name: "Keys", about: "A soft electric piano", drums: false, range: [48, 84] },
  { id: "synth", name: "Synth", about: "A bright, buzzy analogue-style synth", drums: false, range: [48, 84] },
  { id: "bass", name: "Bass", about: "A round, low bass", drums: false, range: [28, 55] },
  { id: "pluck", name: "Pluck", about: "A short, plucked note", drums: false, range: [48, 84] },
  { id: "pad", name: "Pad", about: "A slow, warm pad for held chords", drums: false, range: [48, 84] },
  { id: "lead", name: "Lead", about: "A singing lead for melodies", drums: false, range: [60, 96] },
  { id: "kit", name: "Drums", about: "A drum kit: kick, snare, hats and more", drums: true, range: [36, 51] },
];

export const instrumentOf = (id: InstrumentId) => INSTRUMENTS.find((i) => i.id === id) ?? INSTRUMENTS[0]!;
export const isDrumTrack = (t: Pick<Track, "instrument">) => t.instrument === "kit";

/** The drums a kit track has, lowest first. A drum note's pitch is the one of the drum it hits. */
export const DRUMS: ReadonlyArray<{ pitch: number; id: string; name: string }> = [
  { pitch: 36, id: "kick", name: "Kick" },
  { pitch: 38, id: "snare", name: "Snare" },
  { pitch: 39, id: "clap", name: "Clap" },
  { pitch: 37, id: "rim", name: "Rim" },
  { pitch: 42, id: "hat", name: "Hi-hat" },
  { pitch: 46, id: "openhat", name: "Open hat" },
  { pitch: 41, id: "tomlow", name: "Low tom" },
  { pitch: 45, id: "tommid", name: "Mid tom" },
  { pitch: 49, id: "crash", name: "Crash" },
];

const TRACK_COLORS = ["#7c8cff", "#34d399", "#fb7185", "#fbbf24", "#38bdf8", "#c084fc", "#f97316", "#2dd4bf"];

export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
/** Beats are kept to a 1/96 grid, which holds triplets and sixteenths without drift. */
export const tidy = (beats: number) => Math.round(beats * 96) / 96;

let counter = 0;
export function uid(prefix: string): string {
  counter = (counter + 1) % 1_679_616;
  const time = Date.now().toString(36).slice(-4);
  const rand = Math.floor(Math.random() * 1296).toString(36).padStart(2, "0");
  return `${prefix}${time}${counter.toString(36).padStart(2, "0")}${rand}`;
}

export const pitchName = (p: number): string => `${NOTE_NAMES[((p % 12) + 12) % 12]}${Math.floor(p / 12) - 1}`;

/** "C4", "f#3", "Bb2" or 60: a MIDI number, or null when it is not one. */
export function parsePitch(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? Math.round(v) : null;
  if (typeof v !== "string") return null;
  const m = /^\s*([A-Ga-g])([#b♯♭]?)(-?\d)\s*$/.exec(v);
  if (!m) return /^\s*-?\d+\s*$/.test(v) ? Math.round(Number(v)) : null;
  const base: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const accidental = m[2] === "#" || m[2] === "♯" ? 1 : m[2] === "b" || m[2] === "♭" ? -1 : 0;
  return (Number(m[3]) + 1) * 12 + base[m[1]!.toUpperCase()]! + accidental;
}

/** A drum, by name ("kick", "hat", "snare") or by pitch. */
export function parseDrum(v: unknown): number | null {
  if (typeof v === "number") return DRUMS.some((d) => d.pitch === v) ? v : null;
  if (typeof v !== "string") return null;
  const key = v.toLowerCase().replace(/[^a-z]/g, "");
  const aliases: Record<string, string> = { bd: "kick", bassdrum: "kick", sd: "snare", cp: "clap", hh: "hat", closedhat: "hat", hihat: "hat", oh: "openhat", ohh: "openhat", lowtom: "tomlow", midtom: "tommid", tom: "tommid", rimshot: "rim", cymbal: "crash" };
  const id = aliases[key] ?? key;
  return DRUMS.find((d) => d.id === id || d.name.toLowerCase().replace(/[^a-z]/g, "") === key)?.pitch ?? null;
}

// --------------------------------------------------------------- scales --

const SCALES: Record<ScaleName, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  "harmonic minor": [0, 2, 3, 5, 7, 8, 11],
  "major pentatonic": [0, 2, 4, 7, 9],
  "minor pentatonic": [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
};
export const SCALE_NAMES = Object.keys(SCALES) as ScaleName[];

/** Whether a pitch belongs to the key. */
export function inKey(key: Project["key"], pitch: number): boolean {
  const offset = (((pitch - key.root) % 12) + 12) % 12;
  return SCALES[key.scale].includes(offset);
}

/** "A minor", "C", "F# major", "Bb dorian": a key, or null. */
export function parseKey(v: unknown): Project["key"] | null {
  if (!v || typeof v !== "object" && typeof v !== "string") return null;
  if (typeof v === "object") {
    const k = v as { root?: unknown; scale?: unknown };
    const root = typeof k.root === "number" ? k.root : typeof k.root === "string" ? parsePitch(`${k.root}4`) : null;
    const scale = typeof k.scale === "string" ? matchScale(k.scale) : null;
    return root === null || !scale ? null : { root: ((root % 12) + 12) % 12, scale };
  }
  const m = /^\s*([A-Ga-g][#b♯♭]?)\s*(.*)$/.exec(v);
  if (!m) return null;
  const root = parsePitch(`${m[1]}4`);
  const rest = m[2]!.trim().toLowerCase();
  const scale = rest ? matchScale(rest) : "major";
  return root === null || !scale ? null : { root: ((root % 12) + 12) % 12, scale };
}

function matchScale(s: string): ScaleName | null {
  const v = s.toLowerCase().trim().replace(/-/g, " ");
  if (v === "min" || v === "m" || v === "aeolian" || v === "natural minor") return "minor";
  if (v === "maj" || v === "ionian") return "major";
  if (v === "pentatonic") return "major pentatonic";
  return SCALE_NAMES.find((n) => n === v) ?? null;
}

export const keyName = (k: Project["key"]) => `${NOTE_NAMES[k.root]} ${k.scale}`;

// ----------------------------------------------------------------- chords --

const CHORDS: Record<string, number[]> = {
  "": [0, 4, 7], maj: [0, 4, 7], m: [0, 3, 7], min: [0, 3, 7], "-": [0, 3, 7],
  "7": [0, 4, 7, 10], maj7: [0, 4, 7, 11], M7: [0, 4, 7, 11], m7: [0, 3, 7, 10], min7: [0, 3, 7, 10],
  m9: [0, 3, 7, 10, 14], "9": [0, 4, 7, 10, 14], maj9: [0, 4, 7, 11, 14], add9: [0, 4, 7, 14],
  dim: [0, 3, 6], dim7: [0, 3, 6, 9], m7b5: [0, 3, 6, 10], aug: [0, 4, 8], "+": [0, 4, 8],
  sus2: [0, 2, 7], sus4: [0, 5, 7], "5": [0, 7], "6": [0, 4, 7, 9], m6: [0, 3, 7, 9],
};

export interface Chord {
  /** Its root and quality: "Am7". */
  name: string;
  /** Pitch class of the root, 0 to 11. */
  root: number;
  intervals: number[];
}

/** "Am", "F#m7", "Bbmaj7", "C/E" (the slash bass is ignored: the bass line has its own say). */
export function parseChord(text: string): Chord | null {
  const m = /^\s*([A-Ga-g][#b♯♭]?)([^/\s]*)(?:\/[A-Ga-g][#b♯♭]?)?\s*$/.exec(text);
  if (!m) return null;
  const root = parsePitch(`${m[1]}4`);
  const written = m[2]!;
  const quality = CHORDS[written] ? written : CHORDS[written.toLowerCase()] ? written.toLowerCase() : null;
  if (root === null || quality === null) return null;
  const pc = ((root % 12) + 12) % 12;
  const plain = quality === "maj" ? "" : quality === "min" || quality === "-" ? "m" : quality === "M7" ? "maj7" : quality === "min7" ? "m7" : quality;
  return { name: `${NOTE_NAMES[pc]}${plain}`, root: pc, intervals: CHORDS[quality]! };
}

/**
 * The chord a handful of notes spell, or null when they spell none. Each root among the notes is tried against the
 * common chord shapes; a shape scores for every note it explains and loses for every note it does not, and a chord
 * whose root is the lowest note wins ties.
 */
export function detectChord(pitches: number[]): Chord | null {
  if (pitches.length === 0) return null;
  const classes = new Set(pitches.map((p) => ((p % 12) + 12) % 12));
  const lowest = ((Math.min(...pitches) % 12) + 12) % 12;
  const shapes: Array<[string, number[]]> = [["", [0, 4, 7]], ["m", [0, 3, 7]], ["7", [0, 4, 7, 10]], ["maj7", [0, 4, 7, 11]], ["m7", [0, 3, 7, 10]], ["dim", [0, 3, 6]], ["sus4", [0, 5, 7]], ["sus2", [0, 2, 7]], ["5", [0, 7]]];
  let best: { chord: Chord; score: number } | null = null;
  for (const root of classes) {
    for (const [quality, intervals] of shapes) {
      const have = new Set(intervals.map((i) => (root + i) % 12));
      let hit = 0;
      for (const c of classes) if (have.has(c)) hit++;
      const missing = intervals.length - hit;
      const extra = classes.size - hit;
      // The third matters most: a chord with no third is a power chord only when that is all there is.
      const score = hit * 2 - extra * 2.5 - missing * 1.2 + (root === lowest ? 1.5 : 0) - (intervals.length > 3 ? 0.3 : 0);
      if (hit >= Math.min(2, intervals.length) && (!best || score > best.score)) {
        best = { chord: { name: `${NOTE_NAMES[root]}${quality}`, root, intervals }, score };
      }
    }
  }
  return best && best.score > 0 ? best.chord : null;
}

/** "vi", "IV", "bVII", "ii7", "V7": a chord in the key. Capitals are major, lower case minor. */
function romanChord(text: string, key: Project["key"]): Chord | null {
  const m = /^\s*([b#♭♯]?)(VII|VI|IV|V|III|II|I|vii|vi|iv|v|iii|ii|i)(°|o|dim)?(maj7|M7|m7|7|9|sus2|sus4|add9|6)?\s*$/.exec(text);
  if (!m) return null;
  const degree = ["i", "ii", "iii", "iv", "v", "vi", "vii"].indexOf(m[2]!.toLowerCase());
  const minorKey = ["minor", "dorian", "phrygian", "harmonic minor", "minor pentatonic", "blues"].includes(key.scale);
  const offsets = minorKey ? SCALES.minor : SCALES.major;
  const accidental = m[1] === "b" || m[1] === "♭" ? -1 : m[1] === "#" || m[1] === "♯" ? 1 : 0;
  const root = (((key.root + offsets[degree]! + accidental) % 12) + 12) % 12;
  const lower = m[2] === m[2]!.toLowerCase();
  const extra = m[4] ?? "";
  const minorExtras: Record<string, string> = { "7": "m7", "6": "m6", "9": "m9" };
  const quality = m[3] ? (extra === "7" ? "dim7" : "dim") : lower ? (minorExtras[extra] ?? (extra || "m")) : extra;
  const intervals = CHORDS[quality];
  return intervals ? { name: `${NOTE_NAMES[root]}${quality}`, root, intervals } : null;
}

/** A progression, as chord names ("Am F C G") or numerals ("vi IV I V"), separated by spaces, commas or dashes. */
export function parseProgression(text: string, key: Project["key"]): Chord[] | { error: string } {
  const parts = text.split(/[\s,|\-–]+/).filter(Boolean);
  if (parts.length === 0) return { error: "The progression is empty." };
  const out: Chord[] = [];
  for (const part of parts) {
    const chord = romanChord(part, key) ?? parseChord(part);
    if (!chord) return { error: `"${part}" is not a chord I know (try Am, F, C7, Gmaj7 or numerals like vi IV I V).` };
    out.push(chord);
  }
  return out;
}

export const chordLabel = (c: Chord) => c.name;

/** The pitches of a chord with its root in the octave whose C is `octave` (4 puts the root at C4..B4). */
function voice(chord: Chord, octave: number, spread = false): number[] {
  const base = (octave + 1) * 12 + chord.root;
  const pitches = chord.intervals.map((i) => base + i);
  if (spread && pitches.length > 2) {
    // Open voicing: the middle note an octave up, so it is not a block.
    pitches[1] = pitches[1]! + 12;
  }
  return pitches.sort((a, b) => a - b);
}

// ------------------------------------------------------------ generators --

type Sketch = Array<Omit<Note, "id">>;

/** Mulberry32: the same seed gives the same "human" feel every time, so a pattern made twice is the same pattern. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const CHORD_STYLES = ["block", "arpeggio", "strum", "pulse", "offbeat"] as const;
export type ChordStyle = (typeof CHORD_STYLES)[number];

/** Chords, one per `beatsEach`, laid out in the style. Notes are relative to the clip's start. */
export function chordNotes(chords: Chord[], opts: { style?: ChordStyle; octave?: number; beatsEach?: number; beatsPerBar?: number; spread?: boolean; vel?: number }): Sketch {
  const style = opts.style ?? "block";
  const each = opts.beatsEach ?? opts.beatsPerBar ?? 4;
  const octave = opts.octave ?? 3;
  const vel = opts.vel ?? 0.7;
  const out: Sketch = [];
  chords.forEach((chord, i) => {
    const at = i * each;
    const pitches = voice(chord, octave, opts.spread);
    switch (style) {
      case "block":
        for (const pitch of pitches) out.push({ pitch, start: at, length: each * 0.95, vel });
        break;
      case "strum":
        pitches.forEach((pitch, n) => out.push({ pitch, start: at + n * 0.06, length: each * 0.95 - n * 0.06, vel: vel * (1 - n * 0.04) }));
        break;
      case "arpeggio": {
        const step = 0.5;
        const order = [...pitches, ...pitches.slice(1, -1).reverse()];
        for (let t = 0, n = 0; t < each - 1e-6; t += step, n++) {
          out.push({ pitch: order[n % order.length]!, start: at + t, length: step * 0.9, vel: vel * (t % 1 === 0 ? 1 : 0.8) });
        }
        break;
      }
      case "pulse":
        for (let t = 0; t < each - 1e-6; t += 1) for (const pitch of pitches) out.push({ pitch, start: at + t, length: 0.45, vel: vel * (t % 2 === 0 ? 1 : 0.8) });
        break;
      case "offbeat":
        for (let t = 0.5; t < each; t += 1) for (const pitch of pitches) out.push({ pitch, start: at + t, length: 0.4, vel: vel * 0.9 });
        break;
    }
  });
  return out;
}

export const BASS_STYLES = ["root", "octaves", "eighths", "walking", "syncopated"] as const;
export type BassStyle = (typeof BASS_STYLES)[number];

/** A bass line under the chords. The bass sits in the octave whose C is `octave` (2 is a good low). */
export function bassNotes(chords: Chord[], opts: { style?: BassStyle; octave?: number; beatsEach?: number; beatsPerBar?: number; vel?: number }): Sketch {
  const style = opts.style ?? "root";
  const each = opts.beatsEach ?? opts.beatsPerBar ?? 4;
  const octave = opts.octave ?? 2;
  const vel = opts.vel ?? 0.85;
  const out: Sketch = [];
  chords.forEach((chord, i) => {
    const at = i * each;
    const root = (octave + 1) * 12 + chord.root;
    const fifth = root + 7;
    const third = root + (chord.intervals[1] ?? 4);
    switch (style) {
      case "root":
        out.push({ pitch: root, start: at, length: each * 0.9, vel });
        break;
      case "octaves":
        for (let t = 0; t < each - 1e-6; t += 0.5) out.push({ pitch: Number.isInteger(t) ? root : root + 12, start: at + t, length: 0.45, vel: vel * (t % 1 === 0 ? 1 : 0.8) });
        break;
      case "eighths":
        for (let t = 0; t < each - 1e-6; t += 0.5) out.push({ pitch: root, start: at + t, length: 0.4, vel: vel * (t % 1 === 0 ? 1 : 0.75) });
        break;
      case "walking": {
        const next = chords[(i + 1) % chords.length]!;
        const approach = (octave + 1) * 12 + next.root;
        const line = [root, third, fifth, approach + (approach > root ? -1 : 1)];
        for (let t = 0; t < each - 1e-6; t += 1) out.push({ pitch: line[Math.floor(t) % line.length]!, start: at + t, length: 0.95, vel });
        break;
      }
      case "syncopated": {
        const hits: Array<[number, number, number]> = [[0, 0.75, root], [0.75, 0.75, root], [1.5, 0.5, fifth], [2.5, 0.5, root], [3, 0.75, root + 12], [3.75, 0.25, fifth]];
        for (const [t, length, pitch] of hits) if (t < each) out.push({ pitch, start: at + t, length, vel: vel * (t === 0 ? 1 : 0.85) });
        break;
      }
    }
  });
  return out;
}

export const DRUM_STYLES = ["four_on_floor", "rock", "boom_bap", "trap", "half_time", "breakbeat", "shuffle"] as const;
export type DrumStyle = (typeof DRUM_STYLES)[number];

/**
 * A drum beat, `bars` long, in 4/4 steps of a sixteenth. `fill` adds a short fill at the end of every fourth bar
 * (and the last), `swing` pushes the offbeat sixteenths late, `feel` loosens the velocities a little.
 */
export function drumNotes(opts: { style?: DrumStyle; bars?: number; beatsPerBar?: number; swing?: number; fill?: boolean; feel?: number; seed?: number }): Sketch {
  const style = opts.style ?? "rock";
  const bars = opts.bars ?? 1;
  const bpb = opts.beatsPerBar ?? 4;
  const rand = rng(opts.seed ?? 7);
  const feel = clamp(opts.feel ?? 0.12, 0, 0.5);
  const swing = clamp(opts.swing ?? 0, 0, 0.5);
  const K = 36, S = 38, C = 39, H = 42, O = 46, T1 = 41, T2 = 45, CR = 49;
  // One bar, as [sixteenth step, drum, velocity].
  const bar: Array<[number, number, number]> = [];
  const every = (step: number, drum: number, vel: number, from = 0) => { for (let s = from; s < 16; s += step) bar.push([s, drum, vel]); };
  switch (style) {
    case "four_on_floor":
      every(4, K, 1);
      every(8, C, 0.9, 4);
      every(4, O, 0.65, 2);
      every(2, H, 0.4, 1);
      break;
    case "rock":
      bar.push([0, K, 1], [8, K, 0.95], [10, K, 0.7], [4, S, 1], [12, S, 1]);
      every(2, H, 0.6);
      break;
    case "boom_bap":
      bar.push([0, K, 1], [7, K, 0.8], [10, K, 0.9], [4, S, 1], [12, S, 1]);
      every(2, H, 0.55);
      bar.push([14, O, 0.5]);
      break;
    case "trap":
      bar.push([0, K, 1], [7, K, 0.8], [11, K, 0.9], [8, S, 1], [8, C, 0.7]);
      every(2, H, 0.5);
      bar.push([13, H, 0.6], [14, H, 0.6], [15, H, 0.5]);
      break;
    case "half_time":
      bar.push([0, K, 1], [10, K, 0.8], [8, S, 1]);
      every(2, H, 0.55);
      break;
    case "breakbeat":
      bar.push([0, K, 1], [6, K, 0.85], [10, K, 0.9], [4, S, 1], [12, S, 1], [15, S, 0.5]);
      every(2, H, 0.55);
      break;
    case "shuffle":
      bar.push([0, K, 1], [8, K, 0.9], [4, S, 1], [12, S, 1]);
      for (let s = 0; s < 16; s += 4) bar.push([s, H, 0.6], [s + 3, H, 0.45]);
      break;
  }
  const stepsPerBar = Math.round(bpb * 4);
  const out: Sketch = [];
  for (let b = 0; b < bars; b++) {
    let notes: Sketch = [];
    for (const [step, drum, v] of bar) {
      if (step >= stepsPerBar) continue;
      const late = step % 2 === 1 ? swing * 0.5 : 0;
      const vel = clamp(v * (1 - feel * rand()), 0.1, 1);
      notes.push({ pitch: drum, start: b * bpb + step / 4 + late, length: drum === O || drum === CR ? 0.5 : 0.2, vel });
    }
    const filled = Boolean(opts.fill) && bpb >= 4 && (b % 4 === 3 || b === bars - 1);
    if (filled) {
      // The last beat becomes four sixteenths on the snare and toms, building into the next bar.
      const base = b * bpb + (bpb - 1);
      notes = notes.filter((n) => n.start < base);
      [S, S, T2, T1].forEach((drum, n) => notes.push({ pitch: drum, start: base + n / 4, length: 0.2, vel: 0.65 + n * 0.1 }));
    }
    // A crash opens the song and lands on the one after each fill.
    if (opts.fill && (b === 0 || (b % 4 === 0))) notes.push({ pitch: CR, start: b * bpb, length: 1, vel: 0.7 });
    out.push(...notes);
  }
  return out;
}

// ----------------------------------------------------------- the project --

export function newProject(name = "Untitled song"): Project {
  return {
    v: 1,
    name,
    bpm: 100,
    beatsPerBar: 4,
    key: { root: 0, scale: "major" },
    bars: 8,
    master: 0.9,
    loop: true,
    tracks: [],
  };
}

export function newTrack(project: Project, instrument: InstrumentId, name?: string): Track {
  const inst = instrumentOf(instrument);
  const same = project.tracks.filter((t) => t.instrument === instrument).length;
  return {
    id: uid("t"),
    name: (name ?? inst.name) + (name || same === 0 ? "" : ` ${same + 1}`),
    instrument,
    color: TRACK_COLORS[project.tracks.length % TRACK_COLORS.length]!,
    volume: instrument === "kit" ? 0.85 : instrument === "pad" ? 0.55 : 0.75,
    pan: 0,
    mute: false,
    solo: false,
    reverb: instrument === "pad" ? 0.4 : instrument === "kit" || instrument === "bass" ? 0.05 : 0.2,
    clips: [],
  };
}

export function newClip(start: number, length: number, name = "Clip", notes: Sketch = []): Clip {
  return { id: uid("c"), name, start: tidy(Math.max(0, start)), length: tidy(Math.max(0.25, length)), notes: notes.map((n) => ({ ...n, id: uid("n") })) };
}

/** How long the song is, in beats: the bars it shows, or further if a clip runs past them. */
export function songBeats(p: Project): number {
  let end = p.bars * p.beatsPerBar;
  for (const t of p.tracks) for (const c of t.clips) end = Math.max(end, c.start + c.length);
  return end;
}

/** Where the last clip ends, in beats (0 for an empty song). */
export function contentEnd(p: Project): number {
  let end = 0;
  for (const t of p.tracks) for (const c of t.clips) end = Math.max(end, c.start + c.length);
  return end;
}

/** Grow `bars` to hold every clip; nothing is ever dropped for being past the end. */
export function fitBars(p: Project): void {
  const needed = Math.ceil(contentEnd(p) / p.beatsPerBar - 1e-9);
  if (needed > p.bars) p.bars = Math.min(MAX_BARS, needed);
}

/** A song from anything: the parts that are wrong are repaired or left out, never trusted. Null when it is not a song at all. */
export function normalizeProject(raw: unknown): Project | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, any>;
  if (!Array.isArray(r.tracks)) return null;
  const project = newProject(typeof r.name === "string" && r.name.trim() ? r.name.trim().slice(0, 80) : "Untitled song");
  project.bpm = clamp(Math.round(num(r.bpm, 100) * 100) / 100, MIN_BPM, MAX_BPM);
  project.beatsPerBar = clamp(Math.round(num(r.beatsPerBar, 4)), 2, 12);
  project.key = parseKey(r.key) ?? project.key;
  project.bars = clamp(Math.round(num(r.bars, 8)), 1, MAX_BARS);
  project.master = clamp(num(r.master, 0.9), 0, 1.2);
  project.loop = r.loop !== false;
  const trackIds = new Set<string>();
  for (const t of r.tracks.slice(0, MAX_TRACKS)) {
    if (!t || typeof t !== "object") continue;
    const instrument = INSTRUMENTS.some((i) => i.id === t.instrument) ? (t.instrument as InstrumentId) : "keys";
    let id = typeof t.id === "string" && /^[\w-]{1,24}$/.test(t.id) ? t.id : uid("t");
    if (trackIds.has(id)) id = uid("t");
    trackIds.add(id);
    const track: Track = {
      id,
      name: typeof t.name === "string" && t.name.trim() ? t.name.trim().slice(0, 40) : instrumentOf(instrument).name,
      instrument,
      color: typeof t.color === "string" && /^#[0-9a-fA-F]{6}$/.test(t.color) ? t.color : TRACK_COLORS[trackIds.size % TRACK_COLORS.length]!,
      volume: clamp(num(t.volume, 0.75), 0, 1.2),
      pan: clamp(num(t.pan, 0), -1, 1),
      mute: t.mute === true,
      solo: t.solo === true,
      reverb: clamp(num(t.reverb, 0.15), 0, 1),
      clips: [],
    };
    const clipIds = new Set<string>();
    for (const c of Array.isArray(t.clips) ? t.clips.slice(0, MAX_CLIPS_PER_TRACK) : []) {
      if (!c || typeof c !== "object") continue;
      let cid = typeof c.id === "string" && /^[\w-]{1,24}$/.test(c.id) ? c.id : uid("c");
      if (clipIds.has(cid)) cid = uid("c");
      clipIds.add(cid);
      const length = tidy(clamp(num(c.length, project.beatsPerBar), 0.25, MAX_BARS * 12));
      const clip: Clip = { id: cid, name: typeof c.name === "string" ? c.name.trim().slice(0, 40) || "Clip" : "Clip", start: tidy(clamp(num(c.start, 0), 0, MAX_BARS * 12)), length, notes: [] };
      const noteIds = new Set<string>();
      for (const n of Array.isArray(c.notes) ? c.notes.slice(0, MAX_NOTES_PER_CLIP) : []) {
        if (!n || typeof n !== "object") continue;
        const pitch = parsePitch(n.pitch);
        if (pitch === null || pitch < 0 || pitch > 127) continue;
        const start = tidy(num(n.start, 0));
        if (start < 0 || start >= length) continue;
        let nid = typeof n.id === "string" && /^[\w-]{1,24}$/.test(n.id) ? n.id : uid("n");
        if (noteIds.has(nid)) nid = uid("n");
        noteIds.add(nid);
        clip.notes.push({ id: nid, pitch, start, length: tidy(clamp(num(n.length, 0.5), 0.05, length - start)), vel: clamp(num(n.vel, 0.8), 0.05, 1) });
      }
      track.clips.push(clip);
    }
    project.tracks.push(track);
  }
  fitBars(project);
  return project;
}

// ------------------------------------------------------------- editing --

/** Notes of a clip that overlap a time range [from, to) in clip beats and, when given, a pitch range. */
export function notesIn(clip: Clip, from: number, to: number, low = -Infinity, high = Infinity): Note[] {
  return clip.notes.filter((n) => n.start < to && n.start + n.length > from && n.pitch >= low && n.pitch <= high);
}

/** Add notes to a clip, clipped to its length; notes that start past the end are not added. Returns how many were. */
export function addNotes(clip: Clip, notes: Sketch): number {
  let added = 0;
  for (const n of notes) {
    if (clip.notes.length >= MAX_NOTES_PER_CLIP) break;
    const start = tidy(n.start);
    if (start < 0 || start >= clip.length - 1e-6) continue;
    clip.notes.push({ id: uid("n"), pitch: clamp(Math.round(n.pitch), 0, 127), start, length: tidy(clamp(n.length, 0.05, clip.length - start)), vel: clamp(n.vel, 0.05, 1) });
    added++;
  }
  clip.notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  return added;
}

/** Snap note starts (and optionally lengths) to a grid of `grid` beats, `strength` 0..1 of the way. */
export function quantize(clip: Clip, grid: number, strength = 1, lengths = false): void {
  for (const n of clip.notes) {
    const snapped = Math.round(n.start / grid) * grid;
    n.start = tidy(clamp(n.start + (snapped - n.start) * strength, 0, Math.max(0, clip.length - 0.05)));
    if (lengths) n.length = tidy(Math.max(grid / 2, Math.round(n.length / grid) * grid));
    n.length = tidy(clamp(n.length, 0.05, clip.length - n.start));
  }
}

/** Nudge timing and velocity by a small, repeatable random amount, so a pattern stops sounding like a machine. */
export function humanize(clip: Clip, amount = 0.5, seed = 1): void {
  const rand = rng(seed);
  for (const n of clip.notes) {
    n.start = tidy(clamp(n.start + (rand() - 0.5) * 0.08 * amount, 0, Math.max(0, clip.length - 0.05)));
    n.vel = clamp(n.vel + (rand() - 0.5) * 0.25 * amount, 0.1, 1);
    n.length = tidy(clamp(n.length, 0.05, clip.length - n.start));
  }
}

/** A copy of a clip with new ids, so it can be placed somewhere else. */
export function copyClip(clip: Clip, start: number): Clip {
  return { ...clip, id: uid("c"), start: tidy(start), notes: clip.notes.map((n) => ({ ...n, id: uid("n") })) };
}

export function findTrack(p: Project, ref: unknown): Track | null {
  if (typeof ref !== "string" || !ref.trim()) return null;
  const key = ref.trim().toLowerCase();
  return p.tracks.find((t) => t.id === ref) ?? p.tracks.find((t) => t.name.toLowerCase() === key) ?? p.tracks.find((t) => t.instrument === key) ?? null;
}

export function findClip(p: Project, ref: unknown): { track: Track; clip: Clip } | null {
  if (typeof ref !== "string") return null;
  for (const track of p.tracks) {
    const clip = track.clips.find((c) => c.id === ref);
    if (clip) return { track, clip };
  }
  return null;
}

// --------------------------------------------------------------- reading --

const fmt = (n: number) => `${Math.round(n * 100) / 100}`;
/** A beat as "bar 3 beat 2", counting from 1. */
export const barBeat = (p: Project, beat: number) => `${Math.floor(beat / p.beatsPerBar + 1e-9) + 1}.${fmt((beat % p.beatsPerBar) + 1)}`;

/** A clip's notes, compact enough to read: one line per moment, "beat: pitch(length)". */
function clipText(p: Project, track: Track, clip: Clip, limit = 160): string {
  const drums = isDrumTrack(track);
  const byStart = new Map<number, Note[]>();
  for (const n of [...clip.notes].sort((a, b) => a.start - b.start || a.pitch - b.pitch)) {
    const list = byStart.get(n.start) ?? [];
    list.push(n);
    byStart.set(n.start, list);
  }
  const lines: string[] = [];
  for (const [start, list] of byStart) {
    if (lines.length >= limit) {
      lines.push(`... ${clip.notes.length} notes in all; ask for a narrower range to see the rest`);
      break;
    }
    lines.push(`    ${fmt(start)}: ${list.map((n) => (drums ? DRUMS.find((d) => d.pitch === n.pitch)?.id ?? pitchName(n.pitch) : `${pitchName(n.pitch)}(${fmt(n.length)})`)).join(" ")}`);
  }
  return lines.join("\n");
}

/** The song in words the agent can act on: every id it needs, and enough of the notes to know what is there. */
export function describeProject(p: Project, opts: { clip?: string; focus?: { trackId?: string | null; clipId?: string | null } | null } = {}): string {
  const lines = [
    `Song "${p.name}": ${fmt(p.bpm)} bpm, ${p.beatsPerBar}/4, key ${keyName(p.key)}, ${p.bars} bars (${fmt(songBeats(p))} beats), master ${Math.round(p.master * 100)}%${p.loop ? ", looping" : ""}.`,
  ];
  if (p.tracks.length === 0) lines.push("No tracks yet (studio_track add).");
  const soloed = p.tracks.some((t) => t.solo);
  for (const t of p.tracks) {
    const flags = [t.mute ? "muted" : "", t.solo ? "solo" : "", soloed && !t.solo ? "silent (another track is solo)" : ""].filter(Boolean).join(", ");
    lines.push(`Track ${t.id} "${t.name}" (${instrumentOf(t.instrument).name}): volume ${Math.round(t.volume * 100)}, pan ${fmt(t.pan)}, reverb ${Math.round(t.reverb * 100)}${flags ? `, ${flags}` : ""}`);
    if (t.clips.length === 0) lines.push("    no clips");
    for (const c of t.clips) {
      const notes = c.notes.length;
      const pitches = c.notes.map((n) => n.pitch);
      const range = notes && !isDrumTrack(t) ? `, ${pitchName(Math.min(...pitches))}-${pitchName(Math.max(...pitches))}` : "";
      lines.push(`  Clip ${c.id} "${c.name}": bar ${barBeat(p, c.start)} for ${fmt(c.length)} beats (${fmt(c.length / p.beatsPerBar)} bars), ${notes} note${notes === 1 ? "" : "s"}${range}`);
      if (opts.clip === c.id) lines.push(clipText(p, t, c));
    }
  }
  const f = opts.focus;
  if (f?.clipId || f?.trackId) {
    const hit = f.clipId ? findClip(p, f.clipId) : null;
    if (hit) lines.push(`The person has clip ${hit.clip.id} ("${hit.clip.name}" on ${hit.track.name}) open in the editor: "this clip" means that one.`);
    else if (f.trackId && findTrack(p, f.trackId)) lines.push(`The person has track ${f.trackId} selected.`);
  }
  return lines.join("\n");
}

/** Things worth saying about the song, from its numbers alone: for the agent to look at, or to offer. */
export function review(p: Project): string[] {
  const out: string[] = [];
  const used = p.tracks.filter((t) => t.clips.some((c) => c.notes.length));
  if (used.length === 0) return ["Nothing is written yet."];
  for (const t of p.tracks) {
    if (t.clips.length && !t.clips.some((c) => c.notes.length)) out.push(`${t.name} has clips with no notes in them.`);
    const sorted = [...t.clips].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i]!.start < sorted[i - 1]!.start + sorted[i - 1]!.length - 1e-6) {
        out.push(`${t.name}: clips "${sorted[i - 1]!.name}" and "${sorted[i]!.name}" overlap, so they play together.`);
        break;
      }
    }
    if (!isDrumTrack(t)) {
      const all = t.clips.flatMap((c) => c.notes);
      const off = all.filter((n) => !inKey(p.key, n.pitch));
      if (all.length >= 4 && off.length / all.length > 0.25) {
        out.push(`${t.name}: ${Math.round((off.length / all.length) * 100)}% of its notes are outside ${keyName(p.key)} (fine if intended; otherwise check the key).`);
      }
      const [lo, hi] = instrumentOf(t.instrument).range;
      const out_ = all.filter((n) => n.pitch < lo - 12 || n.pitch > hi + 12);
      if (out_.length) out.push(`${t.name}: ${out_.length} note${out_.length === 1 ? " is" : "s are"} far outside the usual range of ${instrumentOf(t.instrument).name.toLowerCase()}.`);
    }
  }
  const loud = used.filter((t) => !t.mute).map((t) => t.volume);
  if (loud.length > 1 && Math.max(...loud) / Math.max(0.01, Math.min(...loud)) > 2.5) out.push("The track volumes are far apart; the loudest is over twice the quietest.");
  const bass = used.find((t) => t.instrument === "bass");
  const kit = used.find((t) => t.instrument === "kit");
  if (!kit && used.length >= 2) out.push("There are no drums.");
  if (!bass && used.length >= 3) out.push("There is no bass.");
  const empty = p.bars - Math.ceil(contentEnd(p) / p.beatsPerBar);
  if (empty >= 2) out.push(`The last ${empty} bars are empty.`);
  return out;
}
