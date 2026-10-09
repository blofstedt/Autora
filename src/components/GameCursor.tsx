import { useEffect, useRef, useState, type RefObject } from "react";
import { along, humanRoute, restMs, routeMs, typingDelays, type Point } from "../lib/humanPath";
import { clearCursor, reportCursor } from "../lib/cursorPos";
import type { GameCue } from "../lib/gamedesk";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The words on the editor's screen that mean each place. The editor is this origin's, so its page can be read. */
function wordsFor(cue: GameCue): string | null {
  if (cue.where === "events") return "Events";
  if (cue.where === "resources") return "Resources";
  if (cue.where === "canvas") return null;
  return cue.name ?? null;
}

/** Where a visible element in the editor says `text`, in the frame's own pixels; null when the editor does not show it. */
function findText(doc: Document | null, text: string): Point | null {
  if (!doc?.body) return null;
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeValue?.trim() !== text) continue;
    const el = node.parentElement;
    const r = el?.getBoundingClientRect();
    if (!el || !r || r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > doc.documentElement.clientHeight) continue;
    return { x: r.left + Math.min(r.width / 2, 40), y: r.top + r.height / 2 };
  }
  return null;
}

/**
 * The agent working in the game editor: a labelled cursor goes to what it changed -- the scene's tab, the object in the list,
 * the events -- the way the other windows' do, presses there, and the name it is working on is typed out beside it. The editor
 * is told to take the new version when the cursor is done (`onDone`), so the game changes where the cursor is looking.
 *
 * A place the editor does not show is not pointed at: the cursor goes to the middle of the scene instead, which is always there.
 */
export function GameCursor({
  cues, seq, frame, onDone,
}: {
  cues: GameCue[];
  seq: number;
  frame: RefObject<HTMLIFrameElement>;
  onDone: () => void;
}) {
  const [cursor, setCursor] = useState<Point | null>(null);
  const [ring, setRing] = useState<Point | null>(null);
  const [doing, setDoing] = useState<"" | "press" | "type">("");
  const [typed, setTyped] = useState("");
  const [gone, setGone] = useState(false);
  const done = useRef(onDone);
  done.current = onDone;
  const layer = useRef<HTMLDivElement>(null);
  const at = useRef<Point | null>(null);

  useEffect(() => {
    let dead = false;
    const tween = (ms: number, step: (p: number) => void) => new Promise<void>((resolve) => {
      const started = performance.now();
      const tick = () => {
        if (dead) { resolve(); return; }
        const p = Math.min(1, (performance.now() - started) / ms);
        step(p);
        if (p < 1) requestAnimationFrame(tick); else resolve();
      };
      requestAnimationFrame(tick);
    });

    void (async () => {
      setGone(false);
      for (const cue of cues) {
        if (dead) return;
        const f = frame.current;
        const w = f?.clientWidth ?? 800;
        const h = f?.clientHeight ?? 600;
        const words = wordsFor(cue);
        const spot = (words ? findText(f?.contentDocument ?? null, words) : null) ?? { x: w * 0.5, y: h * 0.5 };
        const from = at.current ?? { x: Math.min(w - 8, spot.x + 80), y: Math.max(6, spot.y - 50) };
        setCursor(from);
        const route = humanRoute(from, spot);
        await tween(routeMs(Math.hypot(spot.x - from.x, spot.y - from.y)), (p) => setCursor(along(route, p)));
        if (dead) return;
        at.current = spot;
        await sleep(restMs());
        setRing(spot);
        setDoing("press");
        await sleep(180);
        setDoing("");
        // The name it is working on, typed at a person's pace.
        if (cue.name && cue.where !== "events") {
          setDoing("type");
          const chars = Array.from(cue.name);
          const gaps = typingDelays(cue.name, 1200);
          for (let i = 1; i <= chars.length && !dead; i++) {
            setTyped(chars.slice(0, i).join(""));
            await sleep(gaps[i - 1] ?? 60);
          }
          await sleep(200);
          setTyped("");
          setDoing("");
        } else {
          await sleep(200);
        }
        setRing(null);
      }
      if (dead) return;
      done.current();
      await sleep(600);
      setGone(true);
    })();

    return () => { dead = true; setRing(null); setCursor(null); setDoing(""); setTyped(""); at.current = null; };
  }, [cues, seq, frame]);

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
        <span className="office-cursor-name">Autora{typed ? ` · ${typed}` : ""}</span>
      </div>
    </div>
  );
}
