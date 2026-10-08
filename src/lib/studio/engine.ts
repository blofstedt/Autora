/**
 * Autora Music's sound: instruments made from oscillators and noise, a mixer, a transport that plays the song, and a
 * bounce to a WAV file. All Web Audio, no samples to download: a song opens and plays at once, and the same code makes
 * the sound on screen and the file (an OfflineAudioContext runs the graph faster than real time).
 *
 * The song is read afresh on every tick (`getProject`), so a note added or a fader moved while it plays is heard on the
 * next beat, with nothing to restart.
 */
import { songBeats, type InstrumentId, type Project, type Track } from "./model";

type Ctx = BaseAudioContext;

const hz = (pitch: number) => 440 * Math.pow(2, (pitch - 69) / 12);

const noiseCache = new WeakMap<Ctx, AudioBuffer>();
/** Two seconds of white noise, made once per context: every drum that hisses plays a piece of it. */
function noise(ctx: Ctx): AudioBuffer {
  let buf = noiseCache.get(ctx);
  if (!buf) {
    buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let seed = 22222;
    // A tiny generator rather than Math.random: a bounce is the same every time.
    for (let i = 0; i < data.length; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      data[i] = seed / 2147483648 - 1;
    }
    noiseCache.set(ctx, buf);
  }
  return buf;
}

/** A reverb tail: noise that fades, a little darker as it goes. */
function impulse(ctx: Ctx, seconds = 2.2): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  let seed = 9187;
  for (let c = 0; c < 2; c++) {
    const data = buf.getChannelData(c);
    let last = 0;
    for (let i = 0; i < len; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const white = seed / 2147483648 - 1;
      const fade = Math.pow(1 - i / len, 2.6);
      last += (white - last) * (0.55 - 0.4 * (i / len));
      data[i] = last * fade * 1.6;
    }
  }
  return buf;
}

// ------------------------------------------------------------ the voices --

/** Opens a gain that rises to `peak`, holds to the end of the note and falls over `release`. Returns when it is silent. */
function envelope(g: GainNode, when: number, dur: number, peak: number, attack: number, release: number, decayTo = 1): number {
  const end = when + Math.max(dur, attack + 0.01);
  g.gain.setValueAtTime(0.0001, when);
  g.gain.linearRampToValueAtTime(peak, when + attack);
  if (decayTo < 1) g.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak * decayTo), end);
  else g.gain.setValueAtTime(peak, end);
  g.gain.exponentialRampToValueAtTime(0.0001, end + release);
  return end + release;
}

function osc(ctx: Ctx, type: OscillatorType, freq: number, detune = 0): OscillatorNode {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  o.detune.value = detune;
  return o;
}

/** One pitched note. Each instrument is a small recipe: oscillators, a filter that closes or opens, an envelope. */
function pitched(ctx: Ctx, out: AudioNode, id: InstrumentId, pitch: number, when: number, dur: number, vel: number): void {
  const f = hz(pitch);
  const amp = 0.14 + vel * 0.5;
  const g = ctx.createGain();
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.connect(g);
  g.connect(out);
  const voices: OscillatorNode[] = [];
  let stop = when;
  switch (id) {
    case "keys": {
      // An electric piano: a pure tone, a bell an octave and a bit above that dies quickly.
      const a = osc(ctx, "sine", f);
      const b = osc(ctx, "sine", f * 2.01);
      const bell = ctx.createGain();
      bell.gain.setValueAtTime(0.35 * vel, when);
      bell.gain.exponentialRampToValueAtTime(0.0001, when + 0.35);
      a.connect(lp);
      b.connect(bell);
      bell.connect(lp);
      lp.frequency.value = 2400 + vel * 3000;
      stop = envelope(g, when, Math.max(dur, 0.15), amp * 0.9, 0.006, 0.35, 0.35);
      voices.push(a, b);
      break;
    }
    case "synth": {
      const a = osc(ctx, "sawtooth", f, -8);
      const b = osc(ctx, "sawtooth", f, 8);
      const c = osc(ctx, "square", f / 2);
      const sub = ctx.createGain();
      sub.gain.value = 0.4;
      a.connect(lp);
      b.connect(lp);
      c.connect(sub);
      sub.connect(lp);
      lp.Q.value = 3;
      lp.frequency.setValueAtTime(600 + vel * 1500, when);
      lp.frequency.exponentialRampToValueAtTime(3200 + vel * 2000, when + 0.08);
      lp.frequency.exponentialRampToValueAtTime(1400, when + Math.max(dur, 0.2));
      stop = envelope(g, when, dur, amp * 0.45, 0.01, 0.18);
      voices.push(a, b, c);
      break;
    }
    case "bass": {
      const a = osc(ctx, "sine", f);
      const b = osc(ctx, "sawtooth", f);
      const mix = ctx.createGain();
      mix.gain.value = 0.35;
      a.connect(lp);
      b.connect(mix);
      mix.connect(lp);
      lp.frequency.setValueAtTime(900 + vel * 700, when);
      lp.frequency.exponentialRampToValueAtTime(260, when + 0.25);
      stop = envelope(g, when, dur, amp * 1.1, 0.008, 0.1);
      voices.push(a, b);
      break;
    }
    case "pluck": {
      const a = osc(ctx, "triangle", f);
      const b = osc(ctx, "sawtooth", f, 5);
      const mix = ctx.createGain();
      mix.gain.value = 0.3;
      a.connect(lp);
      b.connect(mix);
      mix.connect(lp);
      lp.frequency.setValueAtTime(5200, when);
      lp.frequency.exponentialRampToValueAtTime(500, when + 0.3);
      stop = envelope(g, when, Math.min(dur, 0.5), amp * 0.9, 0.003, 0.2, 0.15);
      voices.push(a, b);
      break;
    }
    case "pad": {
      const mix = ctx.createGain();
      mix.gain.value = 0.5;
      mix.connect(lp);
      for (const d of [-12, 0, 12]) {
        const o = osc(ctx, "sawtooth", f, d);
        o.connect(mix);
        voices.push(o);
      }
      lp.frequency.setValueAtTime(500, when);
      lp.frequency.linearRampToValueAtTime(1800 + vel * 600, when + Math.min(0.6, dur / 2 + 0.1));
      stop = envelope(g, when, dur, amp * 0.4, 0.25, 0.7);
      break;
    }
    case "lead": {
      const a = osc(ctx, "sawtooth", f);
      const b = osc(ctx, "square", f, 6);
      const mix = ctx.createGain();
      mix.gain.value = 0.5;
      a.connect(lp);
      b.connect(mix);
      mix.connect(lp);
      lp.frequency.value = 2600 + vel * 2200;
      // A little vibrato that arrives after the note has begun, the way a singer's does.
      const lfo = osc(ctx, "sine", 5.5);
      const depth = ctx.createGain();
      depth.gain.setValueAtTime(0, when);
      depth.gain.linearRampToValueAtTime(f * 0.006, when + 0.25);
      lfo.connect(depth);
      depth.connect(a.frequency);
      depth.connect(b.frequency);
      stop = envelope(g, when, dur, amp * 0.5, 0.02, 0.2);
      voices.push(a, b, lfo);
      break;
    }
    default:
      return;
  }
  for (const v of voices) {
    v.start(when);
    v.stop(stop + 0.05);
  }
  const last = voices[0];
  if (last) last.onended = () => { g.disconnect(); lp.disconnect(); };
}

function burst(ctx: Ctx, out: AudioNode, when: number, dur: number, opts: { type: BiquadFilterType; freq: number; q?: number; peak: number; offset?: number }): void {
  const src = ctx.createBufferSource();
  src.buffer = noise(ctx);
  const f = ctx.createBiquadFilter();
  f.type = opts.type;
  f.frequency.value = opts.freq;
  f.Q.value = opts.q ?? 1;
  const g = ctx.createGain();
  g.gain.setValueAtTime(opts.peak, when);
  g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  src.connect(f);
  f.connect(g);
  g.connect(out);
  src.start(when, opts.offset ?? 0);
  src.stop(when + dur + 0.02);
  src.onended = () => g.disconnect();
}

function thump(ctx: Ctx, out: AudioNode, when: number, from: number, to: number, dur: number, peak: number): void {
  const o = osc(ctx, "sine", from);
  o.frequency.setValueAtTime(from, when);
  o.frequency.exponentialRampToValueAtTime(to, when + dur * 0.5);
  const g = ctx.createGain();
  g.gain.setValueAtTime(peak, when);
  g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  o.connect(g);
  g.connect(out);
  o.start(when);
  o.stop(when + dur + 0.02);
  o.onended = () => g.disconnect();
}

/** One drum hit. The pitch picks the drum (model.ts DRUMS). */
function drum(ctx: Ctx, out: AudioNode, pitch: number, when: number, vel: number): void {
  const v = 0.25 + vel * 0.75;
  switch (pitch) {
    case 36: // kick
      thump(ctx, out, when, 160, 42, 0.38, 1.0 * v);
      burst(ctx, out, when, 0.02, { type: "highpass", freq: 3000, peak: 0.25 * v });
      break;
    case 38: // snare
      thump(ctx, out, when, 220, 150, 0.12, 0.5 * v);
      burst(ctx, out, when, 0.2, { type: "bandpass", freq: 2200, q: 0.8, peak: 0.7 * v });
      break;
    case 39: // clap
      for (const d of [0, 0.011, 0.024]) burst(ctx, out, when + d, 0.05, { type: "bandpass", freq: 1500, q: 1.2, peak: 0.6 * v, offset: d * 40 });
      burst(ctx, out, when + 0.03, 0.22, { type: "bandpass", freq: 1500, q: 1.2, peak: 0.45 * v });
      break;
    case 37: // rim
      thump(ctx, out, when, 820, 560, 0.04, 0.45 * v);
      burst(ctx, out, when, 0.03, { type: "highpass", freq: 4000, peak: 0.3 * v });
      break;
    case 42: // closed hat
      burst(ctx, out, when, 0.05, { type: "highpass", freq: 7500, q: 0.7, peak: 0.34 * v });
      break;
    case 46: // open hat
      burst(ctx, out, when, 0.32, { type: "highpass", freq: 7000, q: 0.7, peak: 0.3 * v });
      break;
    case 41: // low tom
      thump(ctx, out, when, 130, 70, 0.3, 0.8 * v);
      break;
    case 45: // mid tom
      thump(ctx, out, when, 190, 105, 0.26, 0.75 * v);
      break;
    case 49: // crash
      burst(ctx, out, when, 1.4, { type: "highpass", freq: 5200, q: 0.5, peak: 0.28 * v });
      break;
    default:
      thump(ctx, out, when, 300, 120, 0.12, 0.4 * v);
  }
}

/** Sound one note on one instrument, to `out`, at audio time `when`, held for `dur` seconds. */
function playNote(ctx: Ctx, out: AudioNode, instrument: InstrumentId, pitch: number, when: number, dur: number, vel: number): void {
  if (instrument === "kit") drum(ctx, out, pitch, when, vel);
  else pitched(ctx, out, instrument, pitch, when, dur, vel);
}

// ------------------------------------------------------------- the mixer --

interface Strip {
  input: GainNode;
  volume: GainNode;
  pan: StereoPannerNode;
  send: GainNode;
}

interface Rig {
  ctx: Ctx;
  strips: Map<string, Strip>;
  master: GainNode;
  meter: AnalyserNode;
  reverb: ConvolverNode;
}

/** The mixer for a song: a strip per track into a master that is kept from clipping, and a reverb they share. */
function buildRig(ctx: Ctx, project: Project): Rig {
  const master = ctx.createGain();
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -10;
  limiter.knee.value = 8;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.2;
  const meter = ctx.createAnalyser();
  meter.fftSize = 1024;
  master.connect(limiter);
  limiter.connect(meter);
  meter.connect(ctx.destination);
  const reverb = ctx.createConvolver();
  reverb.buffer = impulse(ctx);
  const wet = ctx.createGain();
  wet.gain.value = 0.7;
  reverb.connect(wet);
  wet.connect(master);
  const rig: Rig = { ctx, strips: new Map(), master, meter, reverb };
  for (const t of project.tracks) addStrip(rig, t);
  mix(rig, project);
  return rig;
}

function addStrip(rig: Rig, t: Track): Strip {
  const { ctx } = rig;
  const input = ctx.createGain();
  const volume = ctx.createGain();
  const pan = ctx.createStereoPanner();
  const send = ctx.createGain();
  input.connect(volume);
  volume.connect(pan);
  pan.connect(rig.master);
  volume.connect(send);
  send.connect(rig.reverb);
  const strip = { input, volume, pan, send };
  rig.strips.set(t.id, strip);
  return strip;
}

/** Faders, pans, mutes and solos, from the song: cheap, so it is called on every change. */
function mix(rig: Rig, project: Project): void {
  const now = rig.ctx.currentTime;
  const soloed = project.tracks.some((t) => t.solo);
  for (const t of project.tracks) {
    const strip = rig.strips.get(t.id) ?? addStrip(rig, t);
    const audible = !t.mute && (!soloed || t.solo);
    strip.volume.gain.setTargetAtTime(audible ? Math.pow(t.volume, 1.6) * 1.1 : 0, now, 0.015);
    strip.pan.pan.setTargetAtTime(t.pan, now, 0.015);
    strip.send.gain.setTargetAtTime(t.reverb * 0.8, now, 0.03);
  }
  for (const [id, strip] of rig.strips) {
    if (!project.tracks.some((t) => t.id === id)) {
      strip.input.disconnect();
      strip.volume.disconnect();
      strip.pan.disconnect();
      strip.send.disconnect();
      rig.strips.delete(id);
    }
  }
  rig.master.gain.setTargetAtTime(Math.pow(project.master, 1.6) * 1.2, now, 0.015);
}

/** How loud the master is right now, 0 to 1 (the peak of the last moment). */
function level(rig: Rig, scratch: Float32Array): number {
  rig.meter.getFloatTimeDomainData(scratch as Float32Array<ArrayBuffer>);
  let peak = 0;
  for (let i = 0; i < scratch.length; i++) peak = Math.max(peak, Math.abs(scratch[i]!));
  return Math.min(1, peak);
}

// ------------------------------------------------------------- transport --

interface TransportEvents {
  /** The song reached its end and stopped (it does not fire when looping). */
  onEnd?: () => void;
}

/**
 * Plays a song. `getProject` is read on every tick; notes are scheduled a little ahead of the clock, which is what
 * keeps the timing exact when the page is busy.
 *
 * Time runs on one continuous line of "unwrapped" beats counted from the moment play was pressed; when the song
 * loops, that line is folded back onto the song (`beat % length`) as it is read, so nothing is ever rescheduled.
 */
export class Transport {
  private ctx: AudioContext | null = null;
  private rig: Rig | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** The audio-clock time at which unwrapped beat `anchor` sounds. */
  private t0 = 0;
  private anchor = 0;
  /** Unwrapped beats before this one have been handed to the clock. */
  private cursor = 0;
  private running = false;
  /** Where it was stopped, or last put, in song beats. */
  private parked = 0;
  private clicked = -1;
  metronome = false;

  constructor(private getProject: () => Project, private events: TransportEvents = {}) {}

  get playing() { return this.running; }

  private audio(): AudioContext {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor({ latencyHint: "interactive" });
      this.rig = buildRig(this.ctx, this.getProject());
      this.mixed = this.getProject();
    }
    return this.ctx;
  }

  /** Whether the browser lets us make sound yet (it wants a tap first). */
  async unlock(): Promise<boolean> {
    const ctx = this.audio();
    if (ctx.state !== "running") await ctx.resume().catch(() => undefined);
    return ctx.state === "running";
  }

  /** Where the song is, in beats. */
  position(): number {
    if (!this.running || !this.ctx) return this.parked;
    const p = this.getProject();
    const total = songBeats(p);
    const beat = this.anchor + Math.max(0, this.ctx.currentTime - this.t0) * (p.bpm / 60);
    return p.loop ? beat % total : Math.min(beat, total);
  }

  async play(from?: number): Promise<boolean> {
    if (!(await this.unlock()) || !this.ctx) return false;
    this.halt();
    const p = this.getProject();
    if (from !== undefined) this.parked = Math.max(0, from);
    if (this.parked >= songBeats(p) - 1e-6) this.parked = 0;
    this.running = true;
    this.anchor = this.parked;
    this.cursor = this.parked;
    this.t0 = this.ctx.currentTime + 0.06;
    this.clicked = Math.ceil(this.parked - 1e-6) - 1;
    this.mix();
    this.tick();
    this.timer = setInterval(() => this.tick(), 25);
    return true;
  }

  /** Stop where it is (the playhead stays), or `rewind` to the start. */
  stop(rewind = false): void {
    if (this.running) this.parked = this.position();
    this.halt();
    if (rewind) this.parked = 0;
  }

  seek(beat: number): void {
    this.parked = Math.max(0, beat);
    if (this.running) void this.play();
  }

  /** The song the mixer was last set from: a song is a new object after every edit, so an unchanged one is skipped. */
  private mixed: Project | null = null;

  /** Make the mixer match the song: called when a fader, a mute or a track moves. */
  mix(): void {
    if (!this.rig) return;
    const p = this.getProject();
    if (p === this.mixed) return;
    this.mixed = p;
    mix(this.rig, p);
  }

  /** The master level, for the meter. Zero when nothing has made a sound yet. */
  level(scratch: Float32Array): number {
    return this.rig ? level(this.rig, scratch) : 0;
  }

  /** Play one note now, for the keyboard and for the click of a note being drawn. */
  async preview(trackId: string, pitch: number, vel = 0.8, seconds = 0.35): Promise<void> {
    if (!(await this.unlock()) || !this.ctx || !this.rig) return;
    this.mix();
    const t = this.getProject().tracks.find((x) => x.id === trackId);
    const strip = this.rig.strips.get(trackId);
    if (t && strip) playNote(this.ctx, strip.input, t.instrument, pitch, this.ctx.currentTime + 0.005, seconds, vel);
  }

  dispose(): void {
    this.halt();
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.rig = null;
    this.mixed = null;
  }

  /** One gain per track for the current run, between the notes and the track's strip: silencing it cuts off everything scheduled. */
  private buses = new Map<string, GainNode>();

  private bus(trackId: string, strip: Strip): GainNode {
    let g = this.buses.get(trackId);
    if (!g) {
      g = this.ctx!.createGain();
      g.connect(strip.input);
      this.buses.set(trackId, g);
    }
    return g;
  }

  private halt(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const ctx = this.ctx;
    for (const g of this.buses.values()) {
      if (ctx) g.gain.setTargetAtTime(0, ctx.currentTime, 0.01);
      setTimeout(() => g.disconnect(), 200);
    }
    this.buses.clear();
  }

  private tick(): void {
    const ctx = this.ctx;
    const rig = this.rig;
    if (!this.running || !ctx || !rig) return;
    const p = this.getProject();
    const total = songBeats(p);
    const spb = 60 / p.bpm;
    this.mix();
    const horizon = this.anchor + (ctx.currentTime + 0.18 - this.t0) / spb;
    while (this.cursor < horizon) {
      const cycle = p.loop ? Math.floor(this.cursor / total) : 0;
      const stop = p.loop ? Math.min(horizon, (cycle + 1) * total) : Math.min(horizon, total);
      if (this.cursor >= stop) break;
      const offset = cycle * total;
      this.schedule(p, rig, this.cursor - offset, stop - offset, offset);
      if (this.metronome) this.clicks(p, this.cursor, stop);
      this.cursor = stop;
      if (!p.loop && stop >= total) break;
    }
    // Without a loop, the song is over once the clock passes its end.
    if (!p.loop && ctx.currentTime >= this.t0 + (total - this.anchor) * spb + 0.4) {
      this.halt();
      this.parked = 0;
      this.events.onEnd?.();
    }
  }

  /** Hand every note that starts in [from, to) of the song to the clock. `offset` is how many beats the song has been round. */
  private schedule(p: Project, rig: Rig, from: number, to: number, offset: number): void {
    const ctx = this.ctx!;
    const spb = 60 / p.bpm;
    for (const t of p.tracks) {
      const strip = rig.strips.get(t.id);
      if (!strip) continue;
      for (const c of t.clips) {
        if (c.start >= to || c.start + c.length <= from) continue;
        for (const n of c.notes) {
          const at = c.start + n.start;
          if (at < from || at >= to) continue;
          const when = Math.max(ctx.currentTime, this.t0 + (offset + at - this.anchor) * spb);
          const end = Math.min(c.start + c.length, at + n.length);
          playNote(ctx, this.bus(t.id, strip), t.instrument, n.pitch, when, Math.max(0.03, (end - at) * spb), n.vel);
        }
      }
    }
  }

  /** A click on every beat in the unwrapped range [from, to). */
  private clicks(p: Project, from: number, to: number): void {
    const ctx = this.ctx!;
    const spb = 60 / p.bpm;
    for (let b = Math.max(Math.ceil(from - 1e-6), this.clicked + 1); b < to; b++) {
      this.clicked = b;
      const when = Math.max(ctx.currentTime, this.t0 + (b - this.anchor) * spb);
      const accent = b % p.beatsPerBar === 0;
      const o = osc(ctx, "square", accent ? 1500 : 1000);
      const g = ctx.createGain();
      g.gain.setValueAtTime(accent ? 0.16 : 0.1, when);
      g.gain.exponentialRampToValueAtTime(0.0001, when + 0.04);
      o.connect(g);
      g.connect(ctx.destination);
      o.start(when);
      o.stop(when + 0.05);
      o.onended = () => g.disconnect();
    }
  }
}

// ------------------------------------------------------------------ bounce --

/** Render the whole song to a stereo 16-bit WAV, with a tail so the last note and the reverb can die away. */
export async function bounce(project: Project, sampleRate = 44100): Promise<Blob> {
  const spb = 60 / project.bpm;
  const beats = project.tracks.reduce((m, t) => t.clips.reduce((n, c) => Math.max(n, c.start + c.length), m), 0) || project.bars * project.beatsPerBar;
  const seconds = beats * spb + 2.5;
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate);
  const rig = buildRig(ctx, project);
  const soloed = project.tracks.some((t) => t.solo);
  for (const t of project.tracks) {
    const strip = rig.strips.get(t.id);
    if (!strip || t.mute || (soloed && !t.solo)) continue;
    for (const c of t.clips) {
      for (const n of c.notes) {
        const at = (c.start + n.start) * spb;
        const end = Math.min(c.start + c.length, c.start + n.start + n.length);
        playNote(ctx, strip.input, t.instrument, n.pitch, at, Math.max(0.03, (end - c.start - n.start) * spb), n.vel);
      }
    }
  }
  const rendered = await ctx.startRendering();
  return encodeWav(rendered);
}

function encodeWav(buf: AudioBuffer): Blob {
  const channels = buf.numberOfChannels;
  const length = buf.length;
  const bytes = new ArrayBuffer(44 + length * channels * 2);
  const view = new DataView(bytes);
  const write = (at: number, text: string) => { for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i)); };
  write(0, "RIFF");
  view.setUint32(4, 36 + length * channels * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, buf.sampleRate, true);
  view.setUint32(28, buf.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, length * channels * 2, true);
  const data = Array.from({ length: channels }, (_, c) => buf.getChannelData(c));
  let at = 44;
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < channels; c++) {
      const s = Math.max(-1, Math.min(1, data[c]![i]!));
      view.setInt16(at, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      at += 2;
    }
  }
  return new Blob([bytes], { type: "audio/wav" });
}
