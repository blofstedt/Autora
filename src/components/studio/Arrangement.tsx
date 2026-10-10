import { memo, useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  copyClip, DRUMS, instrumentOf, isDrumTrack, MAX_CLIPS_PER_TRACK, MAX_TRACKS, newClip, newTrack, songBeats, tidy,
  type Clip, type Project, type Track,
} from "../../lib/studio/model";
import type { Editor } from "./useSong";
import { IconCopy, IconMoreH, IconTrash } from "../Icons";

/** Width of the track-name column, in px (narrower on a phone). */
export const headWidth = (phone: boolean) => (phone ? 132 : 176);

export type Pick = { trackId: string | null; clipId: string | null };

/** The notes of a clip, drawn small: a picture of the pattern, not an editor. */
const Mini = memo(function Mini({ clip, track }: { clip: Clip; track: Track }) {
  if (clip.notes.length === 0) return null;
  const drums = isDrumTrack(track);
  let lo = 127;
  let hi = 0;
  const rows = DRUMS.length;
  if (!drums) for (const n of clip.notes) { lo = Math.min(lo, n.pitch); hi = Math.max(hi, n.pitch); }
  const span = Math.max(11, hi - lo + 1);
  const shown = clip.notes.length > 500 ? clip.notes.filter((_, i) => i % Math.ceil(clip.notes.length / 500) === 0) : clip.notes;
  return (
    <svg className="st-mini" viewBox={`0 0 ${clip.length} ${drums ? rows : span}`} preserveAspectRatio="none" aria-hidden="true">
      {shown.map((n) => {
        const y = drums ? Math.max(0, DRUMS.findIndex((d) => d.pitch === n.pitch)) : hi - n.pitch;
        return <rect key={n.id} x={n.start} y={y + 0.1} width={Math.max(0.12, n.length)} height={0.8} opacity={0.45 + n.vel * 0.55} />;
      })}
    </svg>
  );
});

type Ghost = { clipId: string; start: number; length: number; trackId: string };

export function Arrangement({
  project, bw, head: HEAD, edit, pick, onPick, flash, onSeek, hold, sendPrompt, starter,
}: {
  project: Project;
  /** Width of the track-name column. */
  head: number;
  /** Pixels per beat. */
  bw: number;
  edit: Editor;
  pick: Pick;
  onPick: (pick: Pick) => void;
  flash: ReadonlySet<string>;
  onSeek: (beat: number) => void;
  hold: (on: boolean) => void;
  sendPrompt: (text: string) => void;
  starter: (kind: "drums" | "chords" | "bass" | "melody") => void;
}) {
  const bpb = project.beatsPerBar;
  const total = songBeats(project) + bpb * 2;
  const lanes = useRef(new Map<string, HTMLDivElement>());
  const [ghost, setGhost] = useState<Ghost | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const drag = useRef<null | { kind: "move" | "size" | "draw"; clipId: string; trackId: string; x0: number; clip: Clip; at?: number }>(null);

  // A menu closes on any click outside it.
  useEffect(() => {
    if (!menu) return;
    const close = () => { setMenu(null); };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menu]);

  const laneAt = (clientY: number): string | null => {
    for (const [id, el] of lanes.current) {
      const r = el.getBoundingClientRect();
      if (clientY >= r.top && clientY < r.bottom) return id;
    }
    return null;
  };

  const beatAt = (e: { clientX: number }, trackId: string) => {
    const r = lanes.current.get(trackId)?.getBoundingClientRect();
    return r ? (e.clientX - r.left) / bw : 0;
  };

  const startClip = (e: ReactPointerEvent, track: Track, clip: Clip, kind: "move" | "size") => {
    e.stopPropagation();
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { kind, clipId: clip.id, trackId: track.id, x0: e.clientX, clip };
    hold(true);
    onPick({ trackId: track.id, clipId: clip.id });
  };

  const moveClip = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const delta = (e.clientX - d.x0) / bw;
    if (d.kind === "move") {
      const over = laneAt(e.clientY);
      const from = project.tracks.find((t) => t.id === d.trackId)!;
      const to = project.tracks.find((t) => t.id === over);
      const trackId = to && isDrumTrack(to) === isDrumTrack(from) ? to.id : d.trackId;
      setGhost({ clipId: d.clipId, start: Math.max(0, Math.round(d.clip.start + delta)), length: d.clip.length, trackId });
    } else if (d.kind === "size") {
      const step = e.shiftKey ? bpb : 1;
      setGhost({ clipId: d.clipId, start: d.clip.start, length: Math.max(step, Math.round((d.clip.length + delta) / step) * step), trackId: d.trackId });
    }
  };

  const endClip = (e: ReactPointerEvent) => {
    const d = drag.current;
    drag.current = null;
    const g = ghost;
    setGhost(null);
    hold(false);
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* already released */ }
    if (!d || !g) return;
    if (g.start === d.clip.start && g.length === d.clip.length && g.trackId === d.trackId) return;
    edit((p) => {
      const from = p.tracks.find((t) => t.id === d.trackId);
      const to = p.tracks.find((t) => t.id === g.trackId);
      const clip = from?.clips.find((c) => c.id === d.clipId);
      if (!from || !to || !clip) return;
      clip.start = g.start;
      if (d.kind === "size") {
        clip.length = g.length;
        clip.notes = clip.notes.filter((n) => n.start < clip.length - 1e-6);
        for (const n of clip.notes) n.length = tidy(Math.min(n.length, clip.length - n.start));
      }
      if (to !== from && to.clips.length < MAX_CLIPS_PER_TRACK) {
        from.clips.splice(from.clips.indexOf(clip), 1);
        to.clips.push(clip);
      }
    });
    if (g.trackId !== d.trackId) onPick({ trackId: g.trackId, clipId: d.clipId });
  };

  // Drawing a new clip across empty space, snapped to bars.
  const startDraw = (e: ReactPointerEvent, track: Track) => {
    if (e.button !== 0 || e.target !== e.currentTarget) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const at = Math.floor(beatAt(e, track.id) / bpb) * bpb;
    drag.current = { kind: "draw", clipId: "", trackId: track.id, x0: e.clientX, clip: newClip(at, bpb), at };
    onPick({ trackId: track.id, clipId: null });
  };
  const moveDraw = (e: ReactPointerEvent, track: Track) => {
    const d = drag.current;
    if (!d || d.kind !== "draw" || d.trackId !== track.id) return;
    const end = Math.ceil(beatAt(e, track.id) / bpb) * bpb;
    const start = d.at ?? 0;
    if (end - start > 0 && Math.abs(e.clientX - d.x0) > 4) setGhost({ clipId: "", start, length: Math.max(bpb, end - start), trackId: track.id });
  };
  const endDraw = (e: ReactPointerEvent, track: Track) => {
    const d = drag.current;
    drag.current = null;
    const g = ghost;
    setGhost(null);
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    if (!d || d.kind !== "draw" || !g || g.clipId !== "") return;
    makeClip(track.id, g.start, g.length);
  };

  const makeClip = useCallback((trackId: string, start: number, length: number) => {
    const clip = newClip(start, length, "New clip");
    edit((p) => {
      const t = p.tracks.find((x) => x.id === trackId);
      if (!t || t.clips.length >= MAX_CLIPS_PER_TRACK) return;
      clip.name = `${t.name} ${t.clips.length + 1}`;
      t.clips.push(clip);
    });
    onPick({ trackId, clipId: clip.id });
  }, [edit, onPick]);

  const patch = (id: string, fn: (t: Track) => void, key?: string) => edit((p) => { const t = p.tracks.find((x) => x.id === id); if (t) fn(t); }, key);

  const ticks: number[] = [];
  for (let b = 0; b < total; b += bpb) ticks.push(b);
  const labelEvery = bw * bpb < 34 ? (bw * bpb < 17 ? 4 : 2) : 1;
  const full = project.tracks.length >= MAX_TRACKS;

  if (project.tracks.length === 0) {
    return (
      <div className="st-empty">
        <div className="st-empty-card">
          <h3>Start a song</h3>
          <p>Pick a first part, or just tell Autora what you want to hear.</p>
          <div className="st-starts">
            <button className="st-start" onClick={() => starter("drums")}><b>Beat</b><span>A drum pattern to build on</span></button>
            <button className="st-start" onClick={() => starter("chords")}><b>Chords</b><span>A progression in your key</span></button>
            <button className="st-start" onClick={() => starter("bass")}><b>Bass</b><span>A low line to ground it</span></button>
            <button className="st-start" onClick={() => starter("melody")}><b>Melody</b><span>An empty track to write on</span></button>
          </div>
          <button className="st-link" onClick={() => sendPrompt("Let's make a song. Ask me a couple of questions about the mood and style I want, then suggest how to start.")}>
            Or have Autora ask what you have in mind
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="st-arr">
      <div className="st-arr-scroll">
        <div className="st-arr-inner" style={{ width: HEAD + total * bw }}>
          <div className="st-rowhead st-ruler-row">
            <div className="st-corner" style={{ width: HEAD }} />
            <div className="st-ruler" style={{ width: total * bw }} onPointerDown={(e) => onSeek(Math.max(0, (e.clientX - e.currentTarget.getBoundingClientRect().left) / bw))}>
              {ticks.map((b, i) => (
                <span key={b} className="st-tick" style={{ left: b * bw }}>{i % labelEvery === 0 ? i + 1 : ""}</span>
              ))}
            </div>
          </div>
          {project.tracks.map((t) => {
            const picked = pick.trackId === t.id;
            const soloed = project.tracks.some((x) => x.solo);
            const quiet = t.mute || (soloed && !t.solo);
            return (
              <div key={t.id} className={`st-row${picked ? " is-picked" : ""}${quiet ? " is-quiet" : ""}`} style={{ ["--tc" as string]: t.color }}>
                <div className={`st-head${menu === t.id ? " is-open" : ""}`} style={{ width: HEAD }} onPointerDown={() => onPick({ trackId: t.id, clipId: pick.trackId === t.id ? pick.clipId : null })}>
                  <i className="st-swatch" />
                  <div className="st-head-main">
                    {renaming === t.id ? (
                      <input
                        className="st-name-input"
                        autoFocus
                        defaultValue={t.name}
                        maxLength={40}
                        onPointerDown={(e) => e.stopPropagation()}
                        onBlur={(e) => { patch(t.id, (x) => { x.name = e.currentTarget.value.trim() || x.name; }); setRenaming(null); }}
                        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") setRenaming(null); }}
                      />
                    ) : (
                      <b className="st-name" onDoubleClick={() => setRenaming(t.id)} title="Double-click to rename">{t.name}</b>
                    )}
                    <span className="st-inst">{instrumentOf(t.instrument).name}</span>
                  </div>
                  <button className={`st-ms${t.mute ? " is-on is-mute" : ""}`} title={t.mute ? "Unmute" : "Mute"} aria-pressed={t.mute} onPointerDown={(e) => e.stopPropagation()} onClick={() => patch(t.id, (x) => { x.mute = !x.mute; })}>M</button>
                  <button className={`st-ms${t.solo ? " is-on is-solo" : ""}`} title={t.solo ? "Unsolo" : "Solo: hear only this"} aria-pressed={t.solo} onPointerDown={(e) => e.stopPropagation()} onClick={() => patch(t.id, (x) => { x.solo = !x.solo; })}>S</button>
                  <div className="st-menu-wrap" onPointerDown={(e) => e.stopPropagation()}>
                    <button className="st-ms st-more" title="More" aria-label={`More for ${t.name}`} aria-expanded={menu === t.id} onClick={() => setMenu(menu === t.id ? null : t.id)}><IconMoreH size={13} /></button>
                    {menu === t.id && (
                      <div className="st-menu" role="menu">
                        <button role="menuitem" onClick={() => { setMenu(null); setRenaming(t.id); }}>Rename</button>
                        <button role="menuitem" onClick={() => {
                          setMenu(null);
                          if (full) return;
                          edit((p) => {
                            const i = p.tracks.findIndex((x) => x.id === t.id);
                            const src = p.tracks[i];
                            if (src) p.tracks.splice(i + 1, 0, { ...src, id: newTrack(p, src.instrument).id, name: `${src.name} copy`.slice(0, 40), solo: false, clips: src.clips.map((c) => copyClip(c, c.start)) });
                          });
                        }}><IconCopy size={12} /> Duplicate</button>
                        <button role="menuitem" onClick={() => { setMenu(null); patch(t.id, (x) => { x.clips = []; }); onPick({ trackId: t.id, clipId: null }); }}>Clear clips</button>
                        <button role="menuitem" className="is-danger" onClick={() => { setMenu(null); edit((p) => { p.tracks = p.tracks.filter((x) => x.id !== t.id); }); onPick({ trackId: null, clipId: null }); }}><IconTrash size={12} /> Delete track</button>
                      </div>
                    )}
                  </div>
                </div>
                <div
                  className="st-lane"
                  ref={(el) => { if (el) lanes.current.set(t.id, el); else lanes.current.delete(t.id); }}
                  style={{ width: total * bw, ["--beat" as string]: `${bw}px`, ["--bar" as string]: `${bw * bpb}px` }}
                  onPointerDown={(e) => startDraw(e, t)}
                  onPointerMove={(e) => moveDraw(e, t)}
                  onPointerUp={(e) => endDraw(e, t)}
                  onDoubleClick={(e) => {
                    if (e.target !== e.currentTarget) return;
                    makeClip(t.id, Math.floor(beatAt(e, t.id) / bpb) * bpb, bpb);
                  }}
                >
                  {t.clips.map((c) => {
                    const g = ghost && ghost.clipId === c.id ? ghost : null;
                    const here = g ? g.trackId === t.id : true;
                    if (!here) return null;
                    const start = g ? g.start : c.start;
                    const length = g ? g.length : c.length;
                    return (
                      <div
                        key={c.id}
                        className={`st-clip${pick.clipId === c.id ? " is-picked" : ""}${flash.has(c.id) ? " is-flash" : ""}${g ? " is-drag" : ""}`}
                        style={{ left: start * bw, width: Math.max(10, length * bw - 1) }}
                        onPointerDown={(e) => startClip(e, t, c, "move")}
                        onPointerMove={moveClip}
                        onPointerUp={endClip}
                        onPointerCancel={endClip}
                        title={`${c.name}: ${c.notes.length} notes`}
                      >
                        <span className="st-clip-name">{c.name}</span>
                        <Mini clip={c} track={t} />
                        <span
                          className="st-clip-size"
                          onPointerDown={(e) => startClip(e, t, c, "size")}
                          onPointerMove={moveClip}
                          onPointerUp={endClip}
                          onPointerCancel={endClip}
                          title="Drag to change the length"
                        />
                      </div>
                    );
                  })}
                  {ghost && ghost.clipId === "" && ghost.trackId === t.id && (
                    <div className="st-clip is-ghost" style={{ left: ghost.start * bw, width: ghost.length * bw - 1 }} />
                  )}
                  {t.clips.length === 0 && <span className="st-lane-hint">Drag here to make a clip{isDrumTrack(t) ? " for a beat" : ""}</span>}
                </div>
              </div>
            );
          })}
          <div className="st-playhead" style={{ ["--head" as string]: `${HEAD}px`, ["--bw" as string]: `${bw}px` }} />
        </div>
      </div>
    </div>
  );
}
