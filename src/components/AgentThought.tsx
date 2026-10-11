import { useEffect, useMemo, useState } from "react";
import { useAgentCursor } from "../lib/agentCursor";
import { recentCursor } from "../lib/cursorPos";
import { liveTool, thoughtForTool } from "../lib/thought";
import type { AutoraEvent } from "../lib/types";

/**
 * A few words beside the agent's cursor about what it is doing, in every window that shows one.
 *
 * Every cursor in the app (the Office, PDF, Video, Game and Music windows' and the shared pointer) reports where it is
 * (lib/cursorPos), and the words come from the tool call actually in flight (lib/thought): so the bubble is only ever
 * where the cursor is, saying what the cursor is for, and it goes when the cursor goes. Decoration, not a log: the
 * thread already says it all, so it is hidden from assistive tech. Off with the agent cursor.
 */
export function AgentThought({ events }: { events: AutoraEvent[] }) {
  const [cursorOn] = useAgentCursor();
  const tool = useMemo(() => liveTool(events), [events]);
  const live = tool ? thoughtForTool(tool.name, tool.args) : null;
  /* The windows play the work after the call has answered (a page's cue, a cursor still arriving), so the words stay
     a few seconds past it: while the cursor is still doing what they say, and not once it has gone. */
  const [kept, setKept] = useState<string | null>(null);
  useEffect(() => {
    if (live) { setKept(live); return; }
    const t = window.setTimeout(() => setKept(null), 3200);
    return () => window.clearTimeout(t);
  }, [live]);
  const words = live ?? kept;
  const [spot, setSpot] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!cursorOn || !words) { setSpot(null); return; }
    let raf = 0;
    let last = 0;
    const tick = (t: number) => {
      if (t - last > 60) {
        last = t;
        const at = recentCursor(1800);
        setSpot((was) => (at && was && Math.abs(was.x - at.x) < 0.5 && Math.abs(was.y - at.y) < 0.5 ? was : at));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [cursorOn, words]);

  if (!cursorOn || !words || !spot) return null;
  const flip = spot.x > window.innerWidth - 220;
  const drop = spot.y < 48;
  return (
    <div
      className={`agent-thought${flip ? " is-flipped" : ""}${drop ? " is-below" : ""}`}
      style={{ transform: `translate(${Math.round(spot.x)}px, ${Math.round(spot.y)}px)` }}
      aria-hidden="true"
    >
      <span key={words}>{words}</span>
    </div>
  );
}
