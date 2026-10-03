import { useEffect, useRef, useState } from "react";
import { along, humanRoute, restMs, routeMs, typingDelays, type Point } from "../lib/humanPath";
import { clearCursor, reportCursor } from "../lib/cursorPos";
import type { OfficeCue } from "../lib/officedesk";

/**
 * The agent working in a document, played over its editor: a labelled cursor
 * goes to the place the same way the browser's pointer does -- an arc, easing
 * in and out, a tremor that fades, sometimes an overshoot -- rests, and types
 * the words with the uneven rhythm of a person, then lets the real text show
 * through. Autora Pages, Sheets and Slides all use it.
 *
 * Only a presentation of a change that has already been made: the document is
 * the real one, the words typed here are drawn over the same words in it, and
 * nothing here takes a pointer event. The editor lives in a frame that cannot
 * be reached from here, so where things are is asked of it (office/shim/cursor.js)
 * and, when it cannot say, the cursor goes to a plausible spot with the words in
 * a small caption beside it instead.
 */

export type Spot = { x: number; y: number; w: number; h: number; size?: number; family?: string; color?: string; bg?: string; weight?: string };
export type Located = { rects: (Spot | null)[]; view: { w: number; h: number } };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Ghost = { spot: Spot; text: string; caret: boolean; fading: boolean; caption: boolean };

export function OfficeCursor({
  cues, seq, locate, onDone,
}: {
  cues: OfficeCue[];
  seq: number;
  /** Ask the editor where these are, in the frame's own pixels. */
  locate: (cues: OfficeCue[]) => Promise<Located | null>;
  onDone: () => void;
}) {
  const [cursor, setCursor] = useState<Point | null>(null);
  const [ghost, setGhost] = useState<Ghost | null>(null);
  const [ring, setRing] = useState<Point | null>(null);
  const [gone, setGone] = useState(false);
  const done = useRef(onDone);
  done.current = onDone;
  const layer = useRef<HTMLDivElement>(null);
  const ask = useRef(locate);
  ask.current = locate;

  useEffect(() => {
    let dead = false;
    const alive = () => !dead;
    /** Play `ms` of an animation, calling `step` with 0..1 on every frame. */
    const tween = (ms: number, step: (p: number) => void) => new Promise<void>((resolve) => {
      const started = performance.now();
      const frame = () => {
        if (dead) { resolve(); return; }
        const p = Math.min(1, (performance.now() - started) / ms);
        step(p);
        if (p < 1) requestAnimationFrame(frame); else resolve();
      };
      requestAnimationFrame(frame);
    });

    void (async () => {
      setGone(false);
      const found = await ask.current(cues).catch(() => null);
      if (!alive()) return;
      const view = found?.view ?? { w: 800, h: 600 };
      let at: Point = { x: view.w * 0.85, y: view.h * 0.12 };
      setCursor(at);
      for (let i = 0; i < cues.length && alive(); i++) {
        const cue = cues[i];
        const real = found?.rects[i] ?? null;
        // Not found: a spot down the middle of the page, the words in a caption.
        const spot: Spot = real ?? { x: view.w * 0.18, y: view.h * (0.22 + 0.07 * i), w: view.w * 0.5, h: 26 };
        const target: Point = { x: spot.x + Math.min(spot.w * 0.5, 28 + Math.min(cue.text.length, 30) * 3), y: spot.y + Math.min(spot.h / 2, 18) };
        const route = humanRoute(at, target);
        await tween(routeMs(Math.hypot(target.x - at.x, target.y - at.y)), (p) => setCursor(along(route, p)));
        if (!alive()) return;
        at = target;
        await sleep(restMs());
        if (cue.act === "point") {
          setRing(target);
          await sleep(420);
          setRing(null);
          continue;
        }
        const chars = Array.from(cue.text);
        const gaps = typingDelays(cue.text, 2600);
        for (let n = 0; n <= chars.length && alive(); n++) {
          setGhost({ spot, text: chars.slice(0, n).join(""), caret: true, fading: false, caption: !real });
          if (n < chars.length) await sleep(gaps[n] ?? 40);
        }
        await sleep(380);
        setGhost((g) => (g ? { ...g, caret: false, fading: true } : g));
        await sleep(320);
        setGhost(null);
        await sleep(160);
      }
      if (!alive()) return;
      await sleep(700);
      setGone(true);
      done.current();
    })();

    return () => { dead = true; setGhost(null); setRing(null); setCursor(null); };
  }, [cues, seq]);

  // Where it is on screen, for the line the agent says beside it.
  useEffect(() => {
    const r = layer.current?.getBoundingClientRect();
    if (cursor && r) reportCursor(r.left + cursor.x, r.top + cursor.y);
  }, [cursor]);
  useEffect(() => clearCursor, []);

  if (!cursor) return null;
  return (
    <div ref={layer} className="office-cursor-layer" aria-hidden="true" data-office-cursor={gone ? "gone" : "on"}>
      {ghost && <GhostText ghost={ghost} />}
      {ring && <span className="office-click" style={{ left: ring.x - 14, top: ring.y - 14 }} />}
      <div className="office-cursor" style={{ transform: `translate(${cursor.x}px, ${cursor.y}px)`, opacity: gone ? 0 : 1 }}>
        <svg width="16" height="20" viewBox="0 0 16 20" style={{ display: "block", filter: "drop-shadow(0 1px 2px rgba(0,0,0,.35))" }}>
          <path d="M1 1 L1 15 L5 11.5 L8 18 L10.5 17 L7.5 10.5 L13 10.5 Z" fill="#7c5cff" stroke="#fff" strokeWidth="1.2" strokeLinejoin="round" />
        </svg>
        <span className="office-cursor-name">Autora</span>
      </div>
    </div>
  );
}

/** The words as they are being typed: over the same words in the document, drawn the way the editor draws them. */
function GhostText({ ghost }: { ghost: Ghost }) {
  const { spot, text, caret, fading, caption } = ghost;
  const style = caption
    ? { left: spot.x, top: spot.y, maxWidth: spot.w }
    : {
      left: spot.x - 2, top: spot.y - 1, width: spot.w + 4, minHeight: spot.h + 2,
      fontSize: spot.size, fontFamily: spot.family, color: spot.color, background: spot.bg, fontWeight: spot.weight as any,
    };
  return (
    <div className={`office-ghost${caption ? " is-caption" : ""}${fading ? " is-fading" : ""}`} style={style}>
      {caption && <b>Autora is typing </b>}
      {text}
      {caret && <span className="office-caret" />}
    </div>
  );
}
