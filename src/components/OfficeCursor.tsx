import { useEffect, useRef, useState } from "react";
import { along, humanRoute, restMs, routeMs, typingDelays, type Point } from "../lib/humanPath";
import { clearCursor, reportCursor } from "../lib/cursorPos";
import type { OfficeCue } from "../lib/officedesk";

/**
 * The agent working in a document, over its editor: a labelled cursor goes to the place the same way the browser's
 * pointer does -- an arc, easing in and out, a tremor that fades, sometimes an overshoot -- rests, clicks, and types.
 * Autora Pages, Sheets and Slides all use it.
 *
 * The typing is the change. The window is showing the document as it was, and every run of words the cursor types is
 * a step the server hands the editor (server/officestage.ts): the document really has those words in it, drawn by the
 * editor itself, and the cursor waits for each step before it goes on, so it is never ahead of the document. The last
 * step is the file the agent's tool made. In a workbook the words also go into the cell's own field first, as keystrokes,
 * before the cell takes its value.
 *
 * Where the editor cannot say where something is, this puts no cursor on screen: a place the editor did not confirm
 * is never pointed at (the person asked for this). The document still changes.
 */

export type Spot = { x: number; y: number; w: number; h: number; size?: number; family?: string; color?: string; bg?: string; weight?: string; /** What the editor itself said is there (an address), when it could say. */ at?: string; /** Where the text there ends, when it is text. */ end?: { x: number; y: number } | null };
export type Located = { rects: (Spot | null)[]; view: { w: number; h: number } };
/** What the editor itself did about a click or a piece of typing; ok false when it could not take it. */
export type Acted = { ok: boolean; at?: string | null; field?: string; text?: string };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function OfficeCursor({
  cues, seq, locate, click, type, end, stage, stages, onDone,
}: {
  cues: OfficeCue[];
  seq: number;
  /** Ask the editor where these are, in the frame's own pixels. A null rect means it could not say. `once`: take the first answer, found or not. */
  locate: (cues: OfficeCue[], once?: boolean) => Promise<Located | null>;
  /** Click in the editor, for real: it selects the cell or puts the caret there. */
  click: (at: { x: number; y: number }) => Promise<Acted | null>;
  /** Type into the editor's own field, for real. `ok` is false when the editor has no field to take it. */
  type: (text: string) => Promise<Acted | null>;
  /** Leave the edit, so nothing typed here is committed. */
  end: () => Promise<Acted | null>;
  /** Make the document be this step of the agent's change; false when the steps are over. */
  stage: (step: number) => Promise<boolean>;
  /** How many steps there are (the last is the finished document); 0 when the change is not shown in steps. */
  stages: number;
  onDone: () => void;
}) {
  const [cursor, setCursor] = useState<Point | null>(null);
  const [ring, setRing] = useState<Point | null>(null);
  const [gone, setGone] = useState(false);
  /** What the cursor is doing right now, shown the way the browser's pointer shows it. */
  const [doing, setDoing] = useState<"" | "press" | "type">("");
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
  const step = useRef(stage);
  step.current = stage;

  useEffect(() => {
    let dead = false;
    const alive = () => !dead;
    /** Play `ms` of an animation, calling `step` with 0..1 on every frame. */
    const tween = (ms: number, frame: (p: number) => void) => new Promise<void>((resolve) => {
      const started = performance.now();
      const tick = () => {
        if (dead) { resolve(); return; }
        const p = Math.min(1, (performance.now() - started) / ms);
        frame(p);
        if (p < 1) requestAnimationFrame(tick); else resolve();
      };
      requestAnimationFrame(tick);
    });

    /** The words of a cell, in the editor's own field: a few characters to a keystroke, at a person's pace. */
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
        const gap = gaps.slice(at - chunk.length, at).reduce((a, b) => a + b, 0) || 90;
        await sleep(gap);
      }
      return took;
    };

    const staged = stages > 0;
    const finish = async () => {
      // The last step is the finished document: whatever the steps did, it ends exactly as the agent's tool made it.
      if (staged) await step.current(stages - 1).catch(() => false);
    };

    void (async () => {
      setGone(false);
      let at: Point | null = null;
      let view = { w: 800, h: 600 };

      /** Go to a spot the way a hand does, and press there. */
      const goTo = async (target: Point, press: boolean) => {
        if (!at) at = { x: Math.min(view.w - 8, Math.max(8, target.x + 70)), y: Math.max(6, target.y - 46) };
        setCursor(at);
        const route = humanRoute(at, target);
        await tween(routeMs(Math.hypot(target.x - at.x, target.y - at.y)), (p) => setCursor(along(route, p)));
        if (!alive()) return;
        at = target;
        if (!press) return;
        await sleep(restMs());
        setRing(target);
        setDoing("press");
        await hit.current(target).catch(() => null);
        await sleep(160);
        setDoing("");
        await sleep(260);
        setRing(null);
      };

      /** Where the editor says something is, or null. */
      const find = async (cue: OfficeCue, first: boolean) => {
        const found = await ask.current([cue], !first).catch(() => null);
        if (found?.view) view = found.view;
        return found?.rects[0] ?? null;
      };

      for (let i = 0; i < cues.length && alive(); i++) {
        const cue = cues[i];
        const steps = staged && cue.step !== undefined && cue.steps ? cue.steps : 0;
        // Typing goes where the paragraph before ends; a cell or a box is where it is. Before anything is typed, the
        // words themselves are not there to be found.
        const near: OfficeCue = steps > 0 && cue.near && !cue.cell && !cue.box ? { ...cue, text: cue.near } : cue;
        const spot = steps > 0 && !cue.near && !cue.cell && !cue.box ? null : await find(near, i === 0);
        if (!alive()) return;
        if (spot) {
          const anchor = spot.end && !cue.cell && !cue.box && cue.near ? spot.end : null;
          const target: Point = anchor
            ? { x: Math.min(view.w - 8, anchor.x + 2), y: anchor.y }
            : { x: spot.x + Math.min(spot.w * 0.5, 28 + Math.min(cue.text.length, 30) * 3), y: spot.y + Math.min(spot.h / 2, 18) };
          await goTo(target, true);
          if (!alive()) return;
        }
        if (cue.act === "point" || steps === 0) {
          await sleep(300);
          continue;
        }
        setDoing("type");
        if (cue.cell) {
          // Into the cell's own field first, as keystrokes; then the cell takes its value.
          await write(cue.text);
          if (!alive()) return;
          await leave.current().catch(() => null);
        }
        const gaps = typingDelays(cue.text, 2600);
        const per = Math.max(1, Math.ceil(cue.text.length / steps));
        for (let k = 0; k < steps && alive(); k++) {
          if (!(await step.current(cue.step! + k))) { setDoing(""); return; }
          if (!alive()) return;
          // The typed words are in the document now: the cursor is at the end of them, where the caret would be.
          if (cue.lead && !cue.cell && !cue.box) {
            const typed = await find({ ...cue, text: cue.lead }, false);
            if (typed?.end) {
              const to = { x: Math.min(view.w - 8, typed.end.x + 2), y: typed.end.y };
              const from = at ?? to;
              at = to;
              await tween(140, (p) => setCursor({ x: from.x + (to.x - from.x) * p, y: from.y + (to.y - from.y) * p }));
            }
          }
          const wait = gaps.slice(k * per, (k + 1) * per).reduce((a, b) => a + b, 0);
          if (!cue.cell) await sleep(Math.min(900, wait));
        }
        setDoing("");
        await sleep(cue.cell ? 260 : 380);
      }
      if (!alive()) return;
      await finish();
      await sleep(700);
      setGone(true);
      done.current();
    })();

    return () => { dead = true; setRing(null); setCursor(null); setDoing(""); };
  }, [cues, seq, stages]);

  // Where it is on screen, for the line the agent says beside it.
  useEffect(() => {
    const r = layer.current?.getBoundingClientRect();
    if (cursor && r) reportCursor(r.left + cursor.x, r.top + cursor.y);
  }, [cursor]);
  useEffect(() => clearCursor, []);

  if (!cursor) return null;
  return (
    <div ref={layer} className="office-cursor-layer" aria-hidden="true" data-office-cursor={gone ? "gone" : "on"}>
      {ring && <span className="office-click" style={{ left: ring.x - 14, top: ring.y - 14 }} />}
      <div className={`office-cursor${doing ? ` is-${doing}` : ""}`} style={{ transform: `translate(${cursor.x}px, ${cursor.y}px)`, opacity: gone ? 0 : 1 }}>
        <svg width="16" height="20" viewBox="0 0 16 20" className="office-cursor-arrow" style={{ display: "block", filter: "drop-shadow(0 1px 2px rgba(0,0,0,.35))" }}>
          <path d="M1 1 L1 15 L5 11.5 L8 18 L10.5 17 L7.5 10.5 L13 10.5 Z" fill="#7c5cff" stroke="#fff" strokeWidth="1.2" strokeLinejoin="round" />
        </svg>
        <span className="office-cursor-name">Autora</span>
      </div>
    </div>
  );
}
