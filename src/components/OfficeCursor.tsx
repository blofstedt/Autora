import { useEffect, useRef, useState } from "react";
import { along, humanRoute, restMs, routeMs, typingDelays, type Point } from "../lib/humanPath";
import { clearCursor, reportCursor } from "../lib/cursorPos";
import type { OfficeCue } from "../lib/officedesk";

/**
 * The agent working in a document, over its editor: a labelled cursor goes to the place the same way the browser's
 * pointer does -- an arc, easing in and out, a tremor that fades, sometimes an overshoot -- rests, clicks, and types
 * the words. Autora Pages, Sheets and Slides all use it.
 *
 * It uses the interface rather than drawing over it: the click is a real click in the editor (the cell is selected,
 * the caret goes into the word), and the words go into the editor's own field a few at a time, as keystrokes, then
 * the edit is left so the document keeps exactly what the agent's change made of it (office/shim/cursor.js).
 *
 * Where the editor cannot say where something is, or has no field to type in, this puts nothing on screen: a place
 * the editor did not confirm is never pointed at (the person asked for this). The words are drawn only where the
 * editor could not take them, over the place it did confirm.
 */

export type Spot = { x: number; y: number; w: number; h: number; size?: number; family?: string; color?: string; bg?: string; weight?: string; /** What the editor itself said is there (an address), when it could say. */ at?: string };
export type Located = { rects: (Spot | null)[]; view: { w: number; h: number } };
/** What the editor itself did about a click or a piece of typing; ok false when it could not take it. */
export type Acted = { ok: boolean; at?: string | null; field?: string; text?: string };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Ghost = { spot: Spot; text: string; caret: boolean; fading: boolean };

export function OfficeCursor({
  cues, seq, locate, click, type, end, onDone,
}: {
  cues: OfficeCue[];
  seq: number;
  /** Ask the editor where these are, in the frame's own pixels. A null rect means it could not say. */
  locate: (cues: OfficeCue[]) => Promise<Located | null>;
  /** Click in the editor, for real: it selects the cell or puts the caret there. */
  click: (at: { x: number; y: number }) => Promise<Acted | null>;
  /** Type into the editor's own field, for real. `ok` is false when the editor has no field to take it. */
  type: (text: string) => Promise<Acted | null>;
  /** Leave the edit, so nothing typed here is committed. */
  end: () => Promise<Acted | null>;
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
  const hit = useRef(click);
  hit.current = click;
  const say = useRef(type);
  say.current = type;
  const leave = useRef(end);
  leave.current = end;

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

    /** The words, in the editor's own field where it has one: a few characters to a keystroke, at a person's pace.
     *  Returns whether the editor took them; when it did not, they are drawn over the confirmed spot instead. */
    const write = async (text: string) => {
      const chars = Array.from(text);
      const gaps = typingDelays(text, 2600);
      let took = false;
      for (let at = 0; at < chars.length && alive(); ) {
        const chunk = chars.slice(at, at + Math.max(1, Math.min(4, Math.round(chars.length / 6)))).join("");
        const said = (await say.current(chunk).catch(() => null)) as Acted | null;
        if (!said?.ok) return false;
        took = true;
        at += chunk.length;
        // A pause per chunk, as long as the keystrokes in it would have taken.
        const gap = gaps.slice(at - chunk.length, at).reduce((a, b) => a + b, 0) || 90;
        await sleep(gap);
      }
      return took;
    };

    void (async () => {
      setGone(false);
      const found = await ask.current(cues).catch(() => null);
      if (!alive()) return;
      const view = found?.view ?? { w: 800, h: 600 };
      const spots = cues.map((_, i) => found?.rects[i] ?? null);
      const first = spots.find(Boolean) as Spot | undefined;
      if (!first) {
        // The editor could not say where any of it is: no cursor at all, rather than a wrong one.
        setGone(true);
        done.current();
        return;
      }
      // It comes in next to the work, not at some invented part of the page.
      let at: Point = { x: Math.min(view.w - 8, Math.max(8, first.x + 70)), y: Math.max(6, first.y - 46) };
      setCursor(at);
      for (let i = 0; i < cues.length && alive(); i++) {
        const cue = cues[i];
        const spot = spots[i];
        if (!spot) continue;
        const target: Point = { x: spot.x + Math.min(spot.w * 0.5, 28 + Math.min(cue.text.length, 30) * 3), y: spot.y + Math.min(spot.h / 2, 18) };
        const route = humanRoute(at, target);
        await tween(routeMs(Math.hypot(target.x - at.x, target.y - at.y)), (p) => setCursor(along(route, p)));
        if (!alive()) return;
        at = target;
        await sleep(restMs());
        // The click is the agent's, in the editor: the cell is selected, the caret sits in the word.
        setRing(target);
        await hit.current(target).catch(() => null);
        await sleep(420);
        setRing(null);
        if (cue.act === "point") continue;
        // Only a cell has a field of its own to type into (its editor or the formula bar). A document's words are not
        // typed: the editor would edit the file a second time, on top of the change the agent's tool already made.
        const took = cue.cell ? await write(cue.text) : false;
        if (!alive()) return;
        if (!took) {
          // No field in the editor to type in (a canvas grid, a slide): the words are drawn here, over the place
          // the editor confirmed, and nowhere else.
          const chars = Array.from(cue.text);
          const gaps = typingDelays(cue.text, 2600);
          for (let n = 0; n <= chars.length && alive(); n++) {
            setGhost({ spot, text: chars.slice(0, n).join(""), caret: true, fading: false });
            if (n < chars.length) await sleep(gaps[n] ?? 40);
          }
          await sleep(380);
          setGhost((g) => (g ? { ...g, caret: false, fading: true } : g));
          await sleep(320);
          setGhost(null);
        } else {
          // The editor is showing them itself: give the person a moment to read what the agent typed.
          await sleep(Math.min(1800, 320 + cue.text.length * 30));
        }
        await leave.current().catch(() => null);
        await sleep(180);
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

/** The words, while they are being typed, drawn the way the editor draws them where it could not take them. */
function GhostText({ ghost }: { ghost: Ghost }) {
  const { spot, text, caret, fading } = ghost;
  return (
    <div
      className={`office-ghost${fading ? " is-fading" : ""}`}
      style={{
        left: spot.x - 2, top: spot.y - 1, width: spot.w + 4, minHeight: spot.h + 2,
        fontSize: spot.size, fontFamily: spot.family, color: spot.color, background: spot.bg, fontWeight: spot.weight as any,
      }}
    >
      {text}
      {caret && <span className="office-caret" />}
    </div>
  );
}
