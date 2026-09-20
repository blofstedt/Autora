import { useEffect, useRef, useState } from "react";
import type { MemoryMark } from "../lib/derive";
import { IconBrain } from "./Icons";

/** How long a chip stays lit after the event that touched it. */
const GLOW_MS = 2600;

/**
 * What the agent knows, above the conversation, always on.
 *
 * Memory used to live behind a button, which made it something you went and
 * checked rather than something you watched happen. Here it is a standing
 * strip, and the two things that actually occur to a memory are visible as
 * they occur: one written glows, one read gets a tracer run through it.
 *
 * Animations key on the sequence number of the event that caused them, not on
 * render. A fold that recomputes on every token would otherwise restart the
 * glow forty times a second and show a solid green bar.
 */
export function MemoryRibbon({
  memories, onOpen,
}: {
  memories: MemoryMark[];
  onOpen: () => void;
}) {
  // seq of the last event we have already animated, per memory.
  const seen = useRef(new Map<string, number>());
  const [lit, setLit] = useState<Map<string, "written" | "recalled">>(new Map());
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const fresh: [string, "written" | "recalled"][] = [];
    for (const m of memories) {
      if (seen.current.get(m.id) !== m.seq) {
        seen.current.set(m.id, m.seq);
        fresh.push([m.id, m.kind]);
      }
    }
    if (fresh.length === 0) return;

    setLit((current) => {
      const next = new Map(current);
      for (const [id, kind] of fresh) next.set(id, kind);
      return next;
    });
    const timer = window.setTimeout(() => {
      setLit((current) => {
        const next = new Map(current);
        for (const [id] of fresh) next.delete(id);
        return next;
      });
    }, GLOW_MS);
    return () => window.clearTimeout(timer);
  }, [memories]);

  // Follow the newest chip, which is the one that just did something.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTo({ left: el.scrollWidth, behavior: "smooth" });
  }, [memories.length]);

  return (
    <section className="ribbon" aria-label="What the agent remembers">
      <button className="ribbon-tag" onClick={onOpen} title="Open the knowledge web">
        <IconBrain size={13} />
        <span>Memory</span>
      </button>

      <div className="ribbon-track" ref={scroller}>
        {memories.length === 0 ? (
          <span className="ribbon-empty">
            Nothing remembered yet — what the agent learns will appear here.
          </span>
        ) : (
          memories.map((m) => (
            <span
              key={m.id}
              className={`mem ${lit.get(m.id) === "written" ? "is-new" : ""} ${
                lit.get(m.id) === "recalled" ? "is-read" : ""
              }`}
              title={m.title}
            >
              {m.title}
            </span>
          ))
        )}
      </div>
    </section>
  );
}
