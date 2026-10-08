import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  addNotes, clamp, DRUMS, humanize, inKey, instrumentOf, isDrumTrack, MAX_NOTES_PER_CLIP, NOTE_NAMES, pitchName, quantize, tidy,
  type Clip, type Note, type Project, type Track,
} from "../../lib/studio/model";
import type { Editor } from "./useSong";
import { IconCopy, IconTrash } from "../Icons";

const ROW = 16;
const DRUM_ROW = 28;
const KEYS = 52;

const GRIDS: Array<[string, number]> = [["1/4", 1], ["1/8", 0.5], ["1/16", 0.25], ["1/32", 0.125]];

type Props = {
  project: Project;
  track: Track;
  clip: Clip;
  /** Pixels per beat in the editor. */
  bw: number;
  edit: Editor;
  hold: (on: boolean) => void;
  preview: (trackId: string, pitch: number, vel?: number) => void;
};

type Drag =
  | { kind: "draw"; id: string; pitch: number; start: number }
  | { kind: "move"; ids: string[]; from: Map<string, { start: number; pitch: number }>; x0: number; y0: number; moved: boolean }
  | { kind: "size"; ids: string[]; from: Map<string, number>; x0: number };

/**
 * The note editor for a clip. A click on empty space makes a note, a drag on a note moves it, the edge makes it
 * longer, and Delete (or a right-click) removes it. Rows in the song's key are lighter, so the notes that belong are
 * easy to find. Nothing is changed in the song until the pointer comes up, so a drag is one step of undo.
 */
export function PianoRoll({ project, track, clip, bw, edit, hold, preview }: Props) {
  const drums = isDrumTrack(track);
  return drums ? <DrumGrid project={project} track={track} clip={clip} edit={edit} hold={hold} preview={preview} /> : <Roll project={project} track={track} clip={clip} bw={bw} edit={edit} hold={hold} preview={preview} />;
}

function Toolbar({ children }: { children: ReactNode }) {
  return <div className="st-roll-tools">{children}</div>;
}

function Roll({ project, track, clip, bw, edit, hold, preview }: Props) {
  const [snap, setSnap] = useState(0.25);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [ghost, setGhost] = useState<Map<string, Partial<Note>> | null>(null);
  const [drawn, setDrawn] = useState<Note | null>(null);
  const drag = useRef<Drag | null>(null);
  const lastLength = useRef(1);
  const grid = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  // A different clip starts with nothing selected.
  useEffect(() => { setSelected(new Set()); }, [clip.id]);

  const inst = instrumentOf(track.instrument);
  const [lo, hi] = useMemo(() => {
    let a = inst.range[0] - 5;
    let b = inst.range[1] + 5;
    for (const n of clip.notes) { a = Math.min(a, n.pitch - 3); b = Math.max(b, n.pitch + 3); }
    return [clamp(a, 0, 120), clamp(b, 12, 127)] as const;
  }, [clip.notes, inst.range]);
  const rows = hi - lo + 1;
  const width = clip.length * bw;
  const height = rows * ROW;

  // Open scrolled to the notes (or the middle of the instrument's range).
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const mid = clip.notes.length ? clip.notes.reduce((s, n) => s + n.pitch, 0) / clip.notes.length : (inst.range[0] + inst.range[1]) / 2;
    el.scrollTop = Math.max(0, (hi - mid) * ROW - el.clientHeight / 2);
    // Only when the clip changes: scrolling on every edit would fight the person.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip.id]);

  const view = useMemo(() => clip.notes.map((n) => (ghost?.has(n.id) ? { ...n, ...ghost.get(n.id)! } : n)), [clip.notes, ghost]);

  const at = (e: { clientX: number; clientY: number }) => {
    const r = grid.current!.getBoundingClientRect();
    return { beat: (e.clientX - r.left) / bw, pitch: hi - Math.floor((e.clientY - r.top) / ROW) };
  };
  const snapped = (beat: number) => tidy(Math.floor(beat / snap + 1e-6) * snap);

  const down = (e: ReactPointerEvent) => {
    if (e.button === 2) return;
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-note]");
    const { beat, pitch } = at(e);
    grid.current!.setPointerCapture(e.pointerId);
    hold(true);
    if (el) {
      const id = el.dataset.note!;
      const edge = el.dataset.edge === "1" || (e.target as HTMLElement).dataset.edge === "1";
      const group = selected.has(id) ? [...selected] : [id];
      if (e.shiftKey) setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
      else if (!selected.has(id)) setSelected(new Set([id]));
      const notes = clip.notes.filter((n) => group.includes(n.id));
      const first = clip.notes.find((n) => n.id === id);
      if (first) preview(track.id, first.pitch, first.vel);
      drag.current = edge
        ? { kind: "size", ids: group, from: new Map(notes.map((n) => [n.id, n.length])), x0: e.clientX }
        : { kind: "move", ids: group, from: new Map(notes.map((n) => [n.id, { start: n.start, pitch: n.pitch }])), x0: e.clientX, y0: e.clientY, moved: false };
      return;
    }
    // Empty space: a new note, whose length is set by dragging.
    setSelected(new Set());
    if (pitch < lo || pitch > hi || beat < 0 || beat >= clip.length) { hold(false); return; }
    const start = snapped(beat);
    const id = "new";
    drag.current = { kind: "draw", id, pitch, start };
    preview(track.id, pitch, 0.8);
    setDrawn({ id, pitch, start, length: Math.min(lastLength.current, clip.length - start), vel: 0.8 });
  };

  const move = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const { beat } = at(e);
    if (d.kind === "draw") {
      const end = Math.max(d.start + snap, Math.ceil(beat / snap - 1e-6) * snap);
      setDrawn({ id: d.id, pitch: d.pitch, start: d.start, length: tidy(Math.min(end, clip.length) - d.start), vel: 0.8 });
    } else if (d.kind === "move") {
      const dx = Math.round((e.clientX - d.x0) / bw / snap) * snap;
      const dy = Math.round(-(e.clientY - d.y0) / ROW);
      if (!d.moved && dx === 0 && dy === 0) return;
      const next = new Map<string, Partial<Note>>();
      for (const [id, o] of d.from) {
        const n = clip.notes.find((x) => x.id === id)!;
        next.set(id, { start: tidy(clamp(o.start + dx, 0, clip.length - snap)), pitch: clamp(o.pitch + dy, lo, hi), length: Math.min(n.length, clip.length - clamp(o.start + dx, 0, clip.length - snap)) });
      }
      const first = [...next.values()][0];
      const was = ghost ? [...ghost.values()][0] : null;
      if (first?.pitch !== undefined && first.pitch !== (was?.pitch ?? [...d.from.values()][0]!.pitch)) preview(track.id, first.pitch);
      d.moved = true;
      setGhost(next);
    } else {
      const dx = (e.clientX - d.x0) / bw;
      const next = new Map<string, Partial<Note>>();
      for (const [id, len] of d.from) {
        const n = clip.notes.find((x) => x.id === id)!;
        next.set(id, { length: tidy(clamp(Math.round((len + dx) / snap) * snap, snap, clip.length - n.start)) });
      }
      setGhost(next);
    }
  };

  const up = (e: ReactPointerEvent) => {
    const d = drag.current;
    drag.current = null;
    try { grid.current?.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    const g = ghost;
    const made = drawn;
    setGhost(null);
    setDrawn(null);
    hold(false);
    if (!d) return;
    if (d.kind === "draw" && made) {
      lastLength.current = made.length;
      edit((p) => {
        const c = p.tracks.find((t) => t.id === track.id)?.clips.find((x) => x.id === clip.id);
        if (c && c.notes.length < MAX_NOTES_PER_CLIP) addNotes(c, [{ pitch: made.pitch, start: made.start, length: made.length, vel: made.vel }]);
      });
    } else if (g && g.size) {
      edit((p) => {
        const c = p.tracks.find((t) => t.id === track.id)?.clips.find((x) => x.id === clip.id);
        if (!c) return;
        for (const n of c.notes) { const o = g.get(n.id); if (o) Object.assign(n, o); }
      });
    }
  };

  const remove = (ids: Iterable<string>) => {
    const gone = new Set(ids);
    if (gone.size === 0) return;
    edit((p) => {
      const c = p.tracks.find((t) => t.id === track.id)?.clips.find((x) => x.id === clip.id);
      if (c) c.notes = c.notes.filter((n) => !gone.has(n.id));
    });
    setSelected(new Set());
  };

  const act = (fn: (c: Clip) => void, key?: string) => edit((p) => {
    const c = p.tracks.find((t) => t.id === track.id)?.clips.find((x) => x.id === clip.id);
    if (c) fn(c);
  }, key);

  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); remove(selected); }
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") { e.preventDefault(); setSelected(new Set(clip.notes.map((n) => n.id))); }
    else if (e.key.startsWith("Arrow") && selected.size) {
      e.preventDefault();
      const dp = e.key === "ArrowUp" ? (e.shiftKey ? 12 : 1) : e.key === "ArrowDown" ? (e.shiftKey ? -12 : -1) : 0;
      const dt = e.key === "ArrowRight" ? snap : e.key === "ArrowLeft" ? -snap : 0;
      act((c) => { for (const n of c.notes) if (selected.has(n.id)) { n.pitch = clamp(n.pitch + dp, 0, 127); n.start = tidy(clamp(n.start + dt, 0, c.length - snap)); } }, "nudge");
      const first = clip.notes.find((n) => selected.has(n.id));
      if (first && dp) preview(track.id, first.pitch + dp, first.vel);
    }
  };

  const chosen = clip.notes.filter((n) => selected.has(n.id));
  const rowsList = Array.from({ length: rows }, (_, i) => hi - i);
  const barPx = project.beatsPerBar * bw;

  return (
    <div className="st-roll" tabIndex={0} onKeyDown={onKey}>
      <Toolbar>
        <label className="st-field">Snap
          <select value={snap} onChange={(e) => setSnap(Number(e.target.value))}>
            {GRIDS.map(([name, v]) => <option key={name} value={v}>{name}</option>)}
          </select>
        </label>
        <span className="st-sep" />
        <button className="st-tool" onClick={() => act((c) => quantize(c, snap, 1))} title="Pull every note onto the grid">Tidy timing</button>
        <button className="st-tool" onClick={() => act((c) => humanize(c, 0.5, 1 + c.notes.length))} title="Loosen timing and force a little, so it feels played">Humanize</button>
        <span className="st-sep" />
        <button className="st-tool" onClick={() => act((c) => { for (const n of c.notes) if (selected.size === 0 || selected.has(n.id)) n.pitch = clamp(n.pitch - 1, 0, 127); })} title="Down a semitone (the selection, or all)">♭</button>
        <button className="st-tool" onClick={() => act((c) => { for (const n of c.notes) if (selected.size === 0 || selected.has(n.id)) n.pitch = clamp(n.pitch + 1, 0, 127); })} title="Up a semitone (the selection, or all)">♯</button>
        <button className="st-tool" onClick={() => act((c) => { for (const n of c.notes) if (selected.size === 0 || selected.has(n.id)) n.pitch = clamp(n.pitch + 12, 0, 127); })} title="Up an octave">+8</button>
        <button className="st-tool" onClick={() => act((c) => { for (const n of c.notes) if (selected.size === 0 || selected.has(n.id)) n.pitch = clamp(n.pitch - 12, 0, 127); })} title="Down an octave">−8</button>
        <span className="st-sep" />
        {chosen.length > 0 && (
          <label className="st-field">Force
            <input type="range" min={5} max={100} value={Math.round(chosen[0]!.vel * 100)} onChange={(e) => act((c) => { for (const n of c.notes) if (selected.has(n.id)) n.vel = Number(e.target.value) / 100; }, "vel")} />
          </label>
        )}
        <button className="st-tool" disabled={selected.size === 0} onClick={() => remove(selected)} title="Delete the selected notes"><IconTrash size={12} /> Delete</button>
        <button className="st-tool" disabled={clip.notes.length === 0} onClick={() => act((c) => { c.notes = []; })} title="Remove every note">Clear</button>
        <button className="st-tool" disabled={selected.size === 0} onClick={() => {
          const copy = clip.notes.filter((n) => selected.has(n.id));
          const len = Math.max(...copy.map((n) => n.start + n.length)) - Math.min(...copy.map((n) => n.start));
          act((c) => addNotes(c, copy.map((n) => ({ pitch: n.pitch, start: n.start + len, length: n.length, vel: n.vel }))));
        }} title="Repeat the selected notes straight after themselves"><IconCopy size={12} /> Repeat</button>
      </Toolbar>
      <div className="st-roll-scroll" ref={scroller}>
        <div className="st-roll-body" style={{ width: KEYS + width, height }}>
          <div className="st-keys" style={{ width: KEYS, height }}>
            {rowsList.map((p) => {
              const black = [1, 3, 6, 8, 10].includes(p % 12);
              return (
                <button
                  key={p}
                  className={`st-key${black ? " is-black" : ""}${p % 12 === project.key.root ? " is-root" : ""}`}
                  style={{ height: ROW }}
                  onPointerDown={() => preview(track.id, p)}
                  tabIndex={-1}
                  aria-label={pitchName(p)}
                >
                  {p % 12 === 0 || p % 12 === project.key.root ? pitchName(p) : ""}
                </button>
              );
            })}
          </div>
          <div
            className="st-grid"
            ref={grid}
            style={{ width, height, ["--row" as string]: `${ROW}px`, ["--beat" as string]: `${bw * snap}px`, ["--bar" as string]: `${barPx}px`, ["--quarter" as string]: `${bw}px` }}
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={up}
            onContextMenu={(e) => {
              e.preventDefault();
              const el = (e.target as HTMLElement).closest<HTMLElement>("[data-note]");
              if (el) remove([el.dataset.note!]);
            }}
          >
            {rowsList.map((p, i) => (
              <i key={p} className={`st-lane-row${inKey(project.key, p) ? " in-key" : ""}${p % 12 === project.key.root ? " is-root" : ""}`} style={{ top: i * ROW, height: ROW }} />
            ))}
            {[...view, ...(drawn ? [drawn] : [])].map((n) => (
              <div
                key={n.id}
                data-note={n.id}
                className={`st-note${selected.has(n.id) ? " is-selected" : ""}${inKey(project.key, n.pitch) ? "" : " is-off"}${n.id === "new" ? " is-new" : ""}`}
                style={{ left: n.start * bw, top: (hi - n.pitch) * ROW + 1, width: Math.max(4, n.length * bw - 1), height: ROW - 2, opacity: 0.5 + n.vel * 0.5 }}
                title={`${pitchName(n.pitch)}  ·  ${NOTE_NAMES[n.pitch % 12]}`}
              >
                <span data-edge="1" className="st-note-edge" />
              </div>
            ))}
            <i className="st-roll-playhead" style={{ left: `calc((var(--ph, 0) - ${clip.start}) * ${bw}px)` }} />
          </div>
        </div>
      </div>
    </div>
  );
}

function DrumGrid({ project, track, clip, edit, hold, preview }: Omit<Props, "bw">) {
  const [snap, setSnap] = useState(0.25);
  const paint = useRef<null | "on" | "off">(null);
  const steps = Math.max(1, Math.round(clip.length / snap));
  const cell = Math.max(18, Math.min(34, snap >= 0.5 ? 40 : 26));
  const hit = (pitch: number, step: number) => clip.notes.filter((n) => n.pitch === pitch && Math.abs(n.start - step * snap) < snap / 2 - 1e-6);

  const set = (pitch: number, step: number, on: boolean) => {
    edit((p) => {
      const c = p.tracks.find((t) => t.id === track.id)?.clips.find((x) => x.id === clip.id);
      if (!c) return;
      const here = c.notes.filter((n) => n.pitch === pitch && Math.abs(n.start - step * snap) < snap / 2 - 1e-6);
      if (on && here.length === 0) addNotes(c, [{ pitch, start: tidy(step * snap), length: Math.min(0.25, snap), vel: 0.85 }]);
      if (!on && here.length) { const ids = new Set(here.map((n) => n.id)); c.notes = c.notes.filter((n) => !ids.has(n.id)); }
    });
  };

  const down = (pitch: number, step: number) => {
    const on = hit(pitch, step).length === 0;
    paint.current = on ? "on" : "off";
    hold(true);
    set(pitch, step, on);
    if (on) preview(track.id, pitch, 0.85);
  };
  const enter = (pitch: number, step: number, buttons: number) => {
    if (!paint.current || buttons === 0) return;
    const on = paint.current === "on";
    if ((hit(pitch, step).length > 0) === on) return;
    set(pitch, step, on);
    if (on) preview(track.id, pitch, 0.85);
  };
  const release = () => {
    if (paint.current) hold(false);
    paint.current = null;
  };
  useEffect(() => {
    window.addEventListener("pointerup", release);
    return () => window.removeEventListener("pointerup", release);
  });

  const perBar = Math.round(project.beatsPerBar / snap);
  return (
    <div className="st-roll st-drums">
      <Toolbar>
        <label className="st-field">Steps
          <select value={snap} onChange={(e) => setSnap(Number(e.target.value))}>
            {GRIDS.map(([name, v]) => <option key={name} value={v}>{name}</option>)}
          </select>
        </label>
        <span className="st-sep" />
        <button className="st-tool" onClick={() => edit((p) => { const c = p.tracks.find((t) => t.id === track.id)?.clips.find((x) => x.id === clip.id); if (c) humanize(c, 0.5, 1 + c.notes.length); })} title="Loosen timing and force a little, so it feels played">Humanize</button>
        <button className="st-tool" disabled={clip.notes.length === 0} onClick={() => edit((p) => { const c = p.tracks.find((t) => t.id === track.id)?.clips.find((x) => x.id === clip.id); if (c) c.notes = []; })}>Clear</button>
        <span className="st-hint">Click or drag across the squares to place hits.</span>
      </Toolbar>
      <div className="st-roll-scroll">
        <div className="st-drum-body">
          {DRUMS.map((d) => (
            <div key={d.pitch} className="st-drum-row" style={{ height: DRUM_ROW }}>
              <button className="st-drum-name" onPointerDown={() => preview(track.id, d.pitch, 0.85)} tabIndex={-1}>{d.name}</button>
              <div className="st-steps">
                {Array.from({ length: steps }, (_, s) => {
                  const h = hit(d.pitch, s)[0];
                  return (
                    <button
                      key={s}
                      className={`st-step${h ? " is-on" : ""}${s % perBar === 0 ? " is-bar" : s % Math.max(1, Math.round(1 / snap)) === 0 ? " is-beat" : ""}`}
                      style={{ width: cell, opacity: h ? 0.55 + h.vel * 0.45 : 1 }}
                      onPointerDown={(e) => { e.preventDefault(); down(d.pitch, s); }}
                      onPointerEnter={(e) => enter(d.pitch, s, e.buttons)}
                      aria-label={`${d.name}, step ${s + 1}`}
                      aria-pressed={!!h}
                      tabIndex={-1}
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
