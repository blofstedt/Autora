import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MemoryMark } from "../lib/derive";
import { KIND_COLOR, fetchKnowledge, type Knowledge } from "../lib/memory";
import { IconBrain, IconChevron } from "./Icons";

/** How long a node stays lit after the event that touched it. */
const GLOW_MS = 2600;
/** Re-read the store this often; a write elsewhere should show up here too. */
const POLL_MS = 20_000;

// Nearly square, so the ring below is a ring rather than a flat line. A wide
// viewBox squashes the vertical spread to almost nothing and a handful of
// records end up drawn as a dash.
const VIEW = { w: 300, h: 150 };

type Placed = { id: string; x: number; y: number; r: number; record: Knowledge["records"][0] };

/**
 * The memory web, above the conversation, always on.
 *
 * A real graph rather than a list of names: the point of a web is that you can
 * see what is connected to what, and the connections are most of what memory
 * knows. It is small, so it shows the graph rather than its labels, and the
 * full view with text and provenance is one tap away.
 *
 * The two things that actually happen to a record are visible as they happen:
 * one written blooms, one read gets a tracer along its links. Both key on the
 * sequence number of the causing event rather than on render -- a fold that
 * recomputes on every token would otherwise restart the animation forty times
 * a second and show a solid green glow.
 */
export function MemoryRibbon({
  memories, onOpen,
}: {
  memories: MemoryMark[];
  onOpen: () => void;
}) {
  const [web, setWeb] = useState<Knowledge>({ records: [], links: [], enabled: true });
  const seen = useRef(new Map<string, number>());
  const [lit, setLit] = useState<Map<string, "written" | "recalled">>(new Map());

  const load = useCallback(() => {
    void fetchKnowledge(false).then(setWeb).catch(() => undefined);
  }, []);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  // A write creates a record the store has not been asked about yet, so the
  // graph is refetched when the log says something changed.
  const latestSeq = memories.length ? memories[memories.length - 1].seq : 0;
  useEffect(() => {
    if (latestSeq) load();
  }, [latestSeq, load]);

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

  // Laid out by hashing the id: stable across renders and refetches, so a node
  // does not jump when its neighbour is written. A force simulation would look
  // better and move things every time the set changes, which at this size reads
  // as the graph twitching rather than as anything meaningful.
  const placed = useMemo<Placed[]>(() => {
    const rows = web.records.slice(0, 40);
    return rows.map((record, index) => {
      let hash = 0;
      for (let i = 0; i < record.id.length; i++) hash = (hash * 31 + record.id.charCodeAt(i)) | 0;
      // A jittered ring rather than a spiral. A spiral puts the first records
      // near the middle, and with only a few of them they line up and the web
      // reads as a dash; a ring is recognisably a web from the first node.
      const golden = 2.399963;
      const angle = index * golden + (hash % 100) / 300;
      const spread = 0.6 + ((hash >>> 7) % 100) / 250;
      return {
        id: record.id,
        x: VIEW.w / 2 + Math.cos(angle) * spread * (VIEW.w / 2 - 14),
        y: VIEW.h / 2 + Math.sin(angle) * spread * (VIEW.h / 2 - 12),
        r: record.pinned ? 7 : record.status === "provisional" ? 4 : 5.5,
        record,
      };
    });
  }, [web.records]);

  // The record being touched right now sits in the middle, and the rest keep
  // their places around it. A graph where the thing you are being told about
  // could be anywhere -- including half off the edge -- makes you hunt for it.
  const active = memories.length ? memories[memories.length - 1].id : null;
  const centred = useMemo<Placed[]>(() => {
    const focus = placed.find((p) => p.id === active);
    if (!focus) return placed;
    const dx = VIEW.w / 2 - focus.x;
    const dy = VIEW.h / 2 - focus.y;
    return placed.map((p) =>
      p.id === active ? { ...p, x: VIEW.w / 2, y: VIEW.h / 2 } : { ...p, x: p.x + dx, y: p.y + dy },
    );
  }, [placed, active]);

  const byId = useMemo(() => new Map(centred.map((p) => [p.id, p])), [centred]);
  const edges = web.links
    .map((l) => ({ a: byId.get(l.src), b: byId.get(l.dst) }))
    .filter((e): e is { a: Placed; b: Placed } => !!e.a && !!e.b);

  const newest = memories.length ? memories[memories.length - 1] : null;

  // Nothing to show is not worth a band across the top of every screen. It
  // reappears the moment there is a record or a recall, and the rail's Memory
  // button is where you go looking for it in the meantime.
  if (centred.length === 0 && !newest) return null;

  return (
    <section className="web" aria-label="What the agent remembers">
      <button className="web-tag" onClick={onOpen} title="Open the knowledge web">
        <IconBrain size={13} />
        <span className="web-count">{web.records.length}</span>
        <IconChevron size={11} />
      </button>

      <div className="web-stage" onClick={onOpen} role="presentation">
        {centred.length === 0 ? (
          <span className="web-empty">
            Nothing remembered yet — what the agent learns appears here.
          </span>
        ) : (
          <svg viewBox={`0 0 ${VIEW.w} ${VIEW.h}`} preserveAspectRatio="xMidYMid meet"
               className="web-svg" aria-hidden="true">
            {edges.map((e, i) => {
              const travelled = lit.has(e.a.id) || lit.has(e.b.id);
              return (
                <line
                  key={i}
                  x1={e.a.x} y1={e.a.y} x2={e.b.x} y2={e.b.y}
                  className={`web-edge ${travelled ? "is-live" : ""}`}
                />
              );
            })}
            {centred.map((p) => {
              const state = lit.get(p.id);
              return (
                <g key={p.id} data-id={p.id}
                   className={`web-node ${state ? `is-${state}` : ""} ${p.id === active ? "is-focus" : ""}`}>
                  {state && <circle cx={p.x} cy={p.y} r={p.r} className="web-halo" />}
                  <circle
                    cx={p.x} cy={p.y} r={p.r}
                    fill={KIND_COLOR[p.record.kind] ?? "var(--accent)"}
                    fillOpacity={p.record.status === "provisional" ? 0.45 : 1}
                  />
                </g>
              );
            })}
          </svg>
        )}

        {/* What just happened, in words, since the dots cannot say it. */}
        {newest && (
          <span className={`web-latest is-${newest.kind}`} key={newest.seq}>
            {newest.kind === "written" ? "learned" : "recalled"} · {newest.title}
          </span>
        )}
      </div>
    </section>
  );
}
