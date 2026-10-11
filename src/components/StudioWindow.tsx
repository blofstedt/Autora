import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useFullscreen } from "../lib/fullscreen";
import { useAgentCursor } from "../lib/agentCursor";
import { centreOf, pointerGo, pointerRest } from "../lib/pointer";
import { onStudioCommand } from "../lib/studio";
import { bounce, Transport } from "../lib/studio/engine";
import {
  addNotes, bassNotes, chordNotes, clamp, contentEnd, copyClip, drumNotes, fitBars, findClip, instrumentOf, isDrumTrack, MAX_BARS,
  MAX_BPM, MIN_BPM, newClip, newTrack, NOTE_NAMES, parseProgression, SCALE_NAMES, tidy,
  INSTRUMENTS, MAX_TRACKS, type Chord, type InstrumentId, type Project, type ScaleName,
} from "../lib/studio/model";
import { Arrangement, headWidth, type Pick } from "./studio/Arrangement";
import { Mixer } from "./studio/Mixer";
import { PianoRoll } from "./studio/PianoRoll";
import { useSong } from "./studio/useSong";
import {
  IconCopy, IconDownload, IconMaximize, IconMetronome, IconMinimize, IconMinus, IconMusic, IconPause, IconPlay, IconPlus, IconRepeat, IconRotateCcw,
  IconRotateCw, IconScissors, IconSearch, IconSkipBack, IconSliders, IconTable, IconTrash, IconX,
} from "./Icons";
import { RailTray, ToolRail } from "./ToolRail";
import { VERB, type RailTool } from "../lib/toolrail";

/** Pixels per beat in the arrangement, from the zoom buttons. */
const ZOOMS = [10, 14, 20, 28, 40, 56, 80];

const timeText = (project: Project, beat: number): string => {
  const bar = Math.floor(beat / project.beatsPerBar + 1e-9);
  const within = beat - bar * project.beatsPerBar;
  const seconds = (beat * 60) / project.bpm;
  const m = Math.floor(seconds / 60);
  return `${bar + 1}.${Math.floor(within) + 1}.${Math.floor((within % 1) * 4) + 1}  ·  ${m}:${(seconds % 60).toFixed(1).padStart(4, "0")}`;
};

/**
 * Autora Music: the music window, beside the conversation.
 *
 * A song is tracks of clips of notes. The arrangement lays clips out; the editor under it is a piano roll (or a drum
 * grid); the mixer sets levels. The sound is made here, in the browser, with Web Audio (lib/studio/engine.ts). The song
 * lives on the server (server/studio.ts), where the agent's studio_* tools work on it too: what the person changes is
 * saved there, and what the agent changes is loaded here, with the clips it touched lit for a moment and the old song
 * one Ctrl+Z away.
 */
export function StudioWindow({ sessionId, phone }: { sessionId: string; phone: boolean }) {
  const song = useSong(sessionId);
  const { project } = song;
  const [pick, setPick] = useState<Pick>({ trackId: null, clipId: null });
  const [zoom, setZoom] = useState(3);
  const [dock, setDock] = useState<"editor" | "mixer" | "closed">("editor");
  /** The rail tool whose options are open: the song's tempo and key, the instruments to add, the zoom. */
  const [trayId, setTrayId] = useState<"song" | "add" | "zoom" | null>(null);
  const [playing, setPlaying] = useState(false);
  const [metro, setMetro] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [asked, setAsked] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [full, setFull] = useFullscreen();
  const root = useRef<HTMLDivElement>(null);
  const clock = useRef<HTMLSpanElement>(null);
  const transport = useRef<Transport | null>(null);
  const base = `/api/studio/${encodeURIComponent(sessionId)}`;
  const bw = ZOOMS[zoom]!;
  const head = headWidth(phone);

  /* The agent's pointer goes to each clip it just made or changed -- the ones lit up -- one after another, and presses
     it, the way a person would pick them. It points only at clips that are on screen. */
  const [cursorOn] = useAgentCursor();
  useEffect(() => {
    if (!cursorOn || song.flash.size === 0) return;
    let dead = false;
    void (async () => {
      await new Promise((r) => setTimeout(r, 140)); // the lit clips are in the page a frame after the set is
      const els = Array.from(root.current?.querySelectorAll(".st-clip.is-flash") ?? []).slice(0, 4);
      for (const el of els) {
        const at = centreOf(el);
        if (dead || !at) continue;
        await pointerGo(at, true, el);
      }
      if (!dead) pointerRest();
    })();
    return () => { dead = true; };
  }, [song.flash, cursorOn]);

  if (!transport.current) transport.current = new Transport(() => song.live.current, { onEnd: () => setPlaying(false) });
  const tp = transport.current;

  // What is picked, if it is still there.
  const hit = useMemo(() => (pick.clipId ? findClip(project, pick.clipId) : null), [project, pick.clipId]);
  const track = hit?.track ?? project.tracks.find((t) => t.id === pick.trackId) ?? null;
  const clip = hit?.clip ?? null;

  // The mixer follows the song.
  useEffect(() => { tp.mix(); }, [project, tp]);
  useEffect(() => { tp.metronome = metro; }, [metro, tp]);
  useEffect(() => () => tp.dispose(), [tp]);

  // The playhead and the meter are painted straight onto the page, 60 times a second, without re-rendering anything.
  useEffect(() => {
    let frame = 0;
    const scratch = new Float32Array(1024);
    let lvl = 0;
    const paint = () => {
      const el = root.current;
      if (el) {
        const beat = tp.position();
        el.style.setProperty("--ph", String(beat));
        lvl = Math.max(tp.level(scratch), lvl * 0.88);
        el.style.setProperty("--lvl", lvl.toFixed(3));
        if (clock.current) clock.current.textContent = timeText(song.live.current, beat);
        if (tp.playing) {
          const sc = el.querySelector<HTMLElement>(".st-arr-scroll");
          const x = head + beat * bw;
          if (sc && (x > sc.scrollLeft + sc.clientWidth - 24 || x < sc.scrollLeft + head)) sc.scrollLeft = Math.max(0, x - head - 40);
        }
      }
      frame = requestAnimationFrame(paint);
    };
    frame = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(frame);
  }, [tp, bw, head, song.live]);

  const play = useCallback(async () => {
    if (tp.playing) {
      tp.stop();
      setPlaying(false);
      return;
    }
    const ok = await tp.play();
    setPlaying(ok);
    if (!ok) setProblem("Your browser is holding the sound back. Tap play again.");
  }, [tp]);

  const stop = useCallback(() => {
    tp.stop(true);
    setPlaying(false);
  }, [tp]);

  const seek = useCallback((beat: number) => tp.seek(tidy(Math.max(0, beat))), [tp]);

  // What the agent asks of this window: the things only a browser can do.
  useEffect(() => {
    const off = onStudioCommand((cmd) => {
      void (async () => {
        const claim = (await fetch(`${base}/claim?id=${encodeURIComponent(cmd.id)}`, { method: "POST" }).then((r) => r.json()).catch(() => null)) as { won?: boolean } | null;
        if (!claim?.won) return;
        const reply = (ok: boolean, value: unknown) =>
          fetch(`${base}/reply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: cmd.id, ok, value }) }).catch(() => undefined);
        try {
          if (cmd.name === "play") {
            const ok = await tp.play(typeof cmd.args.beat === "number" ? cmd.args.beat : undefined);
            setPlaying(ok);
            await reply(true, { playing: ok, blocked: !ok });
          } else if (cmd.name === "stop") {
            tp.stop();
            setPlaying(false);
            await reply(true, { playing: false });
          } else if (cmd.name === "seek") {
            tp.seek(typeof cmd.args.beat === "number" ? cmd.args.beat : 0);
            await reply(true, {});
          } else if (cmd.name === "export") {
            const wav = await bounce(song.live.current);
            const name = typeof cmd.args.name === "string" ? cmd.args.name : "song";
            const res = await fetch(`${base}/deliver?name=${encodeURIComponent(name)}`, { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav });
            const body = await res.json().catch(() => null);
            if (!res.ok) throw new Error(body?.error ?? `Autora answered ${res.status}`);
            await reply(true, body);
          } else await reply(false, { message: `The window does not know ${cmd.name}.` });
        } catch (err) {
          await reply(false, { message: err instanceof Error ? err.message : String(err) });
        }
      })();
    });
    // Only now can a command be taken: say so.
    void fetch(`${base}/ready`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ready: true }) }).catch(() => undefined);
    return () => {
      off();
      void fetch(`${base}/ready`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ready: false }), keepalive: true }).catch(() => undefined);
    };
  }, [base, tp, song.live]);

  // Tell the server which clip is open, so "this clip" means something to the agent.
  useEffect(() => {
    const t = setTimeout(() => {
      void fetch(`${base}/focus`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trackId: pick.trackId, clipId: pick.clipId }) }).catch(() => undefined);
    }, 250);
    return () => clearTimeout(t);
  }, [base, pick.trackId, pick.clipId]);

  // A clip the agent removed stops being picked.
  useEffect(() => {
    if (pick.clipId && !hit) setPick((p) => ({ trackId: p.trackId, clipId: null }));
  }, [hit, pick.clipId]);

  const sendPrompt = useCallback((text: string) => {
    setAsked(text);
    void fetch(`/api/sessions/${encodeURIComponent(sessionId)}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }).then((r) => { if (!r.ok) setAsked(null); }).catch(() => setAsked(null));
    setTimeout(() => setAsked(null), 3500);
  }, [sessionId]);

  const preview = useCallback((trackId: string, pitch: number, vel?: number) => { void tp.preview(trackId, pitch, vel); }, [tp]);

  /** A first part, with something in it, so there is something to hear straight away. */
  const starter = useCallback((kind: "drums" | "chords" | "bass" | "melody") => {
    const p = song.live.current;
    const minor = ["minor", "dorian", "phrygian", "harmonic minor", "minor pentatonic", "blues"].includes(p.key.scale);
    const parsed = parseProgression(minor ? "i VI III VII" : "I V vi IV", p.key);
    const chords: Chord[] = Array.isArray(parsed) ? parsed : [];
    const instrument: InstrumentId = kind === "drums" ? "kit" : kind === "bass" ? "bass" : kind === "melody" ? "lead" : "keys";
    const t = newTrack(p, instrument, kind === "drums" ? "Drums" : kind === "chords" ? "Chords" : kind === "bass" ? "Bass" : "Melody");
    const c = newClip(0, 4 * p.beatsPerBar, kind === "melody" ? "Melody" : kind === "drums" ? "Beat" : kind === "chords" ? "Chords" : "Bass line");
    if (kind === "drums") addNotes(c, drumNotes({ style: "rock", bars: 4, beatsPerBar: p.beatsPerBar, seed: 3 }));
    if (kind === "chords") addNotes(c, chordNotes(chords, { style: "block", octave: 3, beatsEach: p.beatsPerBar }));
    if (kind === "bass") addNotes(c, bassNotes(chords, { style: "eighths", octave: 2, beatsEach: p.beatsPerBar }));
    t.clips.push(c);
    song.edit((d) => { d.tracks.push(t); });
    setPick({ trackId: t.id, clipId: c.id });
    setDock("editor");
  }, [song]);

  const addTrack = (instrument: InstrumentId) => {
    const t = newTrack(song.live.current, instrument);
    song.edit((p) => { if (p.tracks.length < MAX_TRACKS) p.tracks.push(t); });
    setPick({ trackId: t.id, clipId: null });
    setTrayId(null);
  };

  const removeClip = () => {
    if (!clip || !track) return;
    song.edit((d) => { const t = d.tracks.find((x) => x.id === track.id); if (t) t.clips = t.clips.filter((c) => c.id !== clip.id); });
    setPick({ trackId: track.id, clipId: null });
  };

  const onKey = (e: ReactKeyboardEvent) => {
    const target = e.target as HTMLElement;
    const typing = target.closest("input, textarea, select") !== null && !(target instanceof HTMLInputElement && target.type === "range");
    if (typing) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) song.redo(); else song.undo(); }
    else if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); song.redo(); }
    // On a focused button Space already means "press it".
    else if (e.key === " " && !target.closest("button")) { e.preventDefault(); void play(); }
    else if (e.key === "Home") { e.preventDefault(); stop(); }
    else if ((e.key === "Delete" || e.key === "Backspace") && clip && track && !target.closest(".st-roll")) {
      e.preventDefault();
      removeClip();
    } else if (mod && e.key.toLowerCase() === "d" && clip && track) {
      e.preventDefault();
      duplicate();
    }
  };

  const duplicate = () => {
    if (!clip || !track) return;
    const copy = copyClip(clip, clip.start + clip.length);
    song.edit((d) => { d.tracks.find((t) => t.id === track.id)?.clips.push(copy); });
    setPick({ trackId: track.id, clipId: copy.id });
  };

  const split = () => {
    if (!clip || !track) return;
    let at = Math.round(tp.position() * 4) / 4;
    if (at <= clip.start + 0.0001 || at >= clip.start + clip.length - 0.0001) at = clip.start + clip.length / 2;
    const inside = at - clip.start;
    const right = newClip(at, clip.length - inside, `${clip.name} b`);
    song.edit((d) => {
      const t = d.tracks.find((x) => x.id === track.id);
      const c = t?.clips.find((x) => x.id === clip.id);
      if (!t || !c) return;
      for (const n of c.notes) {
        if (n.start >= inside) right.notes.push({ ...n, id: `${n.id}b`, start: tidy(n.start - inside) });
        else if (n.start + n.length > inside) n.length = tidy(inside - n.start);
      }
      c.notes = c.notes.filter((n) => n.start < inside);
      c.length = tidy(inside);
      t.clips.push(right);
    });
  };

  const exportWav = async () => {
    setRendering(true);
    setProblem(null);
    try {
      const wav = await bounce(song.live.current);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(wav);
      a.download = `${project.name.replace(/[\\/:*?"<>|]+/g, "-") || "song"}.wav`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    } catch (err) {
      setProblem(`The song could not be exported: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRendering(false);
    }
  };

  const asks = clip
    ? ["Fix the timing of this clip", "Make this clip groove more", "Suggest how to vary this clip", "Explain what is in this clip"]
    : project.tracks.length > 0
      ? ["What should I add next?", "Balance the mix", "Make the bass follow the chords", "Check the song for mistakes"]
      : [];

  const empty = contentEnd(project) === 0;
  // With nothing to edit the dock stays out of the way of the buttons that start a song.
  const shownDock = project.tracks.length === 0 ? "closed" : dock;
  const note = song.notice ?? problem;
  const ended = Math.ceil(contentEnd(project) / project.beatsPerBar);
  const hasClip = !!(clip && track);
  const toggleTray = (id: "song" | "add" | "zoom") => setTrayId((cur) => (cur === id ? null : id));
  const full_ = project.tracks.length >= MAX_TRACKS;

  const tools: RailTool[] = [
    { id: "add", label: "Add track", group: "Build", icon: <IconPlus size={20} />, color: VERB.draw, phone: true, on: trayId === "add", disabled: full_, about: "A new instrument", run: () => toggleTray("add") },
    { id: "split", label: "Split", group: "Edit the clip", icon: <IconScissors size={20} />, color: VERB.shape, phone: true, disabled: !hasClip, about: "Cut the clip in two at the playhead (or the middle)", run: split },
    { id: "duplicate", label: "Duplicate", group: "Edit the clip", icon: <IconCopy size={20} />, color: VERB.text, phone: true, disabled: !hasClip, about: "Copy it straight after itself (Ctrl+D)", run: duplicate },
    { id: "delete", label: "Delete", group: "Edit the clip", icon: <IconTrash size={20} />, color: VERB.remove, phone: true, disabled: !hasClip, about: "Delete the clip (Delete)", run: removeClip },
    { id: "song", label: "Song", group: "Song", icon: <IconMusic size={20} />, color: VERB.select, phone: true, on: trayId === "song", about: "Tempo, key and length", run: () => toggleTray("song") },
    { id: "mixer", label: "Mixer", group: "Song", icon: <IconSliders size={20} />, color: VERB.highlight, phone: true, on: dock === "mixer", about: "Levels, pan, mute and solo", run: () => setDock(dock === "mixer" ? "editor" : "mixer") },
    { id: "zoom", label: "Zoom", group: "View", icon: <IconSearch size={20} />, color: VERB.note, phone: true, on: trayId === "zoom", about: "How wide a beat is", run: () => toggleTray("zoom") },
    { id: "editor", label: "Piano roll", group: "View", icon: <IconTable size={20} />, color: VERB.note, desktop: true, on: dock === "editor", about: "The notes of the open clip", run: () => setDock(dock === "editor" ? "closed" : "editor") },
    { id: "loop", label: "Loop", group: "Playback", icon: <IconRepeat size={20} />, color: VERB.insert, desktop: true, on: project.loop, about: "Loop the song", run: () => song.edit((d) => { d.loop = !d.loop; }) },
    { id: "metronome", label: "Metronome", group: "Playback", icon: <IconMetronome size={20} />, color: VERB.stamp, desktop: true, on: metro, about: "Click track", run: () => setMetro(!metro) },
  ];
  const trayTool = trayId ? tools.find((t) => t.id === trayId) ?? null : null;

  return (
    <div
      ref={root}
      className={`pdf-window st-window has-rail ${phone ? "is-phone" : "is-desk"}${phone && full ? " is-full" : ""}`}
      tabIndex={0}
      onKeyDown={onKey}
      aria-label="Autora Music"
    >
      <div className="pdf-bar">
        <span className="pdf-bar-ico" aria-hidden="true"><IconMusic size={14} /></span>
        <span className="pdf-bar-app">Autora Music</span>
        <input
          className="st-song-name"
          value={project.name}
          maxLength={80}
          aria-label="Song name"
          onChange={(e) => song.edit((d) => { d.name = e.target.value; }, "name")}
        />
        <span className={`pdf-bar-note st-save is-${song.save}`}>{song.save === "saving" ? "Saving…" : song.save === "error" ? "Not saved" : "Saved as you go"}</span>
        <div className="spacer" />
        <button className="st-tool st-export" onClick={() => void exportWav()} disabled={rendering || empty} title="Save the song as a WAV file" aria-label="Export as WAV"><IconDownload size={13} /><span className="st-export-text">{rendering ? "Rendering…" : "Export"}</span></button>
        {phone && (
          <button className="btn icon ghost pdf-full-btn" onClick={() => setFull(!full)} title={full ? "Back to the conversation" : "Full screen"} aria-label={full ? "Back to the conversation" : "Full screen"} aria-pressed={full}>
            {full ? <IconMinimize size={14} /> : <IconMaximize size={14} />}
          </button>
        )}
      </div>

      <div className="st-transport">
        <div className="st-trow">
          <button className="st-play" onClick={() => void play()} aria-label={playing ? "Pause" : "Play"} title={playing ? "Pause (Space)" : "Play (Space)"}>
            {playing ? <IconPause size={18} /> : <IconPlay size={18} />}
          </button>
          <button className="st-icon" onClick={stop} aria-label="Back to the start" title="Back to the start (Home)"><IconSkipBack size={15} /></button>
          <span className="st-clock" ref={clock} aria-label="Position">1.1.1  ·  0:00.0</span>
          <div className="spacer" />
          <button className="st-icon" onClick={song.undo} disabled={!song.canUndo} aria-label="Undo" title="Undo (Ctrl+Z)"><IconRotateCcw size={14} /></button>
          <button className="st-icon" onClick={song.redo} disabled={!song.canRedo} aria-label="Redo" title="Redo (Ctrl+Shift+Z)"><IconRotateCw size={14} /></button>
          <div className="st-meter-h" aria-hidden="true"><i /></div>
        </div>
      </div>

      {note && (
        <div className="pdf-problem" role="status">
          {note}
          <button className="st-x" onClick={() => { setProblem(null); song.dismiss(); }} aria-label="Dismiss"><IconX size={11} /></button>
        </div>
      )}

      <Arrangement
        project={project}
        bw={bw}
        head={head}
        edit={song.edit}
        pick={pick}
        onPick={setPick}
        flash={song.flash}
        onSeek={seek}
        hold={song.hold}
        sendPrompt={sendPrompt}
        starter={starter}
      />

      <div className={`st-dock is-${shownDock}${shownDock === "editor" && !clip ? " is-idle" : ""}`}>
        {clip && track && shownDock === "editor" && (
          <div className="st-dock-bar">
            <b className="st-dock-title">{isDrumTrack(track) ? "Drums" : "Piano roll"}</b>
            <input className="st-clip-name-input" value={clip.name} maxLength={40} aria-label="Clip name"
              onChange={(e) => song.edit((d) => { const c = findClip(d, clip.id); if (c) c.clip.name = e.target.value; }, `cn-${clip.id}`)} />
            <span className="st-hint">{(clip.length / project.beatsPerBar).toFixed(clip.length % project.beatsPerBar ? 2 : 0)} bars · {clip.notes.length} notes · {instrumentOf(track.instrument).name}</span>
          </div>
        )}
        {shownDock === "editor" && (
          <div className="st-dock-body">
            {clip && track ? (
              <PianoRoll project={project} track={track} clip={clip} bw={Math.max(24, Math.min(80, bw * 2))} edit={song.edit} hold={song.hold} preview={preview} />
            ) : (
              <p className="st-hint st-pad">
                {project.tracks.length === 0
                  ? "Start with one of the buttons above."
                  : track
                    ? `Click a clip on ${track.name} to edit its notes, or drag across its lane to make a new one.`
                    : "Click a clip to edit its notes, or drag across a track's lane to make a new one."}
              </p>
            )}
          </div>
        )}
        {shownDock === "mixer" && (
          <div className="st-dock-body"><Mixer project={project} edit={song.edit} sendPrompt={sendPrompt} /></div>
        )}
      </div>

      {trayTool && (
        <RailTray tool={trayTool} onClose={() => setTrayId(null)}>
          {trayId === "add" && INSTRUMENTS.map((i) => (
            <button key={i.id} className="st-add-chip" disabled={full_} title={i.about} onClick={() => addTrack(i.id)}>{i.name}</button>
          ))}
          {trayId === "song" && (
            <div className="st-song">
              <label className="st-field"><span className="st-label">Tempo</span>
                <span className="st-stepper">
                  <button onClick={() => song.edit((d) => { d.bpm = clamp(d.bpm - 1, MIN_BPM, MAX_BPM); }, "bpm")} aria-label="Slower"><IconMinus size={11} /></button>
                  <input type="number" min={MIN_BPM} max={MAX_BPM} value={Math.round(project.bpm)} aria-label="Tempo in beats per minute"
                    onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v) && v > 0) song.edit((d) => { d.bpm = clamp(v, MIN_BPM, MAX_BPM); }, "bpm"); }} />
                  <button onClick={() => song.edit((d) => { d.bpm = clamp(d.bpm + 1, MIN_BPM, MAX_BPM); }, "bpm")} aria-label="Faster"><IconPlus size={11} /></button>
                </span>
                <span className="st-unit">bpm</span>
              </label>
              <label className="st-field"><span className="st-label">Key</span>
                <span className="st-keypick">
                  <select value={project.key.root} aria-label="Key note" onChange={(e) => song.edit((d) => { d.key.root = Number(e.target.value); })}>
                    {NOTE_NAMES.map((n, i) => <option key={n} value={i}>{n}</option>)}
                  </select>
                  <select value={project.key.scale} aria-label="Scale" onChange={(e) => song.edit((d) => { d.key.scale = e.target.value as ScaleName; })}>
                    {SCALE_NAMES.map((sc) => <option key={sc} value={sc}>{sc}</option>)}
                  </select>
                </span>
              </label>
              <label className="st-field"><span className="st-label">Bars</span>
                <span className="st-stepper">
                  <button disabled={project.bars <= Math.max(1, ended)} onClick={() => song.edit((d) => { d.bars = Math.max(Math.max(1, ended), d.bars - 1); })} aria-label="Fewer bars"><IconMinus size={11} /></button>
                  <input type="number" min={1} max={MAX_BARS} value={project.bars} aria-label="Bars"
                    onChange={(e) => { const v = Math.round(Number(e.target.value)); if (Number.isFinite(v)) song.edit((d) => { d.bars = clamp(v, Math.max(1, Math.ceil(contentEnd(d) / d.beatsPerBar)), MAX_BARS); fitBars(d); }, "bars"); }} />
                  <button disabled={project.bars >= MAX_BARS} onClick={() => song.edit((d) => { d.bars = Math.min(MAX_BARS, d.bars + 1); })} aria-label="More bars"><IconPlus size={11} /></button>
                </span>
                <span className="st-unit">bars</span>
              </label>
            </div>
          )}
          {trayId === "zoom" && (
            <span className="st-stepper">
              <button onClick={() => setZoom(Math.max(0, zoom - 1))} disabled={zoom === 0} aria-label="Zoom out"><IconMinus size={11} /></button>
              <button onClick={() => setZoom(Math.min(ZOOMS.length - 1, zoom + 1))} disabled={zoom === ZOOMS.length - 1} aria-label="Zoom in"><IconPlus size={11} /></button>
            </span>
          )}
        </RailTray>
      )}
      <ToolRail
        app="music" phone={phone} tools={tools}
        extra={(close) => asks.length > 0 || asked ? (
          <section>
            <h4>Ask Autora</h4>
            {asked
              ? <p className="rail-grid-hint">Sent to Autora: “{asked.slice(0, 60)}{asked.length > 60 ? "…" : ""}”. Watch the song and the thread.</p>
              : <div className="rail-asks">{asks.map((a) => <button key={a} type="button" className="rail-ask" onClick={() => { close(); sendPrompt(a); }}>{a}</button>)}</div>}
          </section>
        ) : null}
      />
    </div>
  );
}
