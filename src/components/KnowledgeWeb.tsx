import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  KIND_COLOR, deleteRecord, edgesFor, fetchKnowledge, patchRecord,
  type Knowledge, type MemoryRecord,
} from "../lib/memory";
import { IconSpark, IconX } from "./Icons";

/**
 * Everything the agent knows, as a graph you can argue with.
 *
 * The point is not the picture. It is that a memory you cannot see is a memory
 * you cannot correct: an agent that has quietly decided something wrong about
 * you will keep acting on it forever unless there is a place to go and delete
 * it. So every node opens to its evidence -- which session, which event -- and
 * every node can be pinned, retired, or erased from here.
 *
 * The layout is a small force simulation rather than a library: a few hundred
 * nodes do not need a dependency, and the UI ships with none at runtime.
 */
/** Strong enough that nodes claim space instead of huddling round the origin. */
const REPULSION = 3200;

type Node = {
  id: string;
  record: MemoryRecord;
  x: number; y: number; vx: number; vy: number;
  r: number;
};

const KINDS: MemoryRecord["kind"][] = ["preference", "procedure", "fact", "skill"];

export function KnowledgeWeb({
  onClose,
  initialKind,
}: {
  onClose: () => void;
  initialKind?: MemoryRecord["kind"] | "all";
}) {
  const [data, setData] = useState<Knowledge | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [kinds, setKinds] = useState<Set<string>>(
    new Set(initialKind && initialKind !== "all" ? [initialKind] : KINDS)
  );
  const [showNewSkill, setShowNewSkill] = useState(false);
  const [skillTitle, setSkillTitle] = useState("");
  const [skillBody, setSkillBody] = useState("");
  const [skillTags, setSkillTags] = useState("skill, automation");

  const load = useCallback(() => {
    fetchKnowledge().then(setData).catch(() => setData(null));
  }, []);
  useEffect(load, [load]);

  const createSkill = async () => {
    if (!skillTitle.trim()) return;
    await fetch("/api/memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: skillTitle.trim(),
        body: skillBody.trim(),
        kind: "skill",
        tags: skillTags.split(",").map((s) => s.trim()).filter(Boolean),
      }),
    });
    setSkillTitle("");
    setSkillBody("");
    setShowNewSkill(false);
    load();
  };

  const filtered = useMemo(() => {
    if (!data) return null;
    const q = query.trim().toLowerCase();
    const records = data.records.filter((r) => {
      if (!kinds.has(r.kind)) return false;
      if (!q) return true;
      return (r.title + " " + r.body + " " + r.tags.join(" ")).toLowerCase().includes(q);
    });
    const keep = new Set(records.map((r) => r.id));
    return {
      ...data,
      records,
      links: data.links.filter((l) => keep.has(l.src) && keep.has(l.dst)),
    };
  }, [data, query, kinds]);

  const record = selected && data ? data.records.find((r) => r.id === selected) : null;

  return (
    <div className="kweb" role="dialog" aria-label="Knowledge web">
      <header className="kweb-top">
        <div className="brand">
          <span className="brand-mark"><IconSpark size={13} /></span>
          Knowledge
        </div>
        <input
          className="kweb-search"
          placeholder="Search what the agent knows…"
          value={query}
          aria-label="Search memory"
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="kweb-filters">
          {KINDS.map((kind) => (
            <button
              key={kind}
              className={`kchip ${kinds.has(kind) ? "on" : ""}`}
              style={{ "--chip": KIND_COLOR[kind] } as React.CSSProperties}
              aria-pressed={kinds.has(kind)}
              onClick={() => setKinds((prev) => {
                const next = new Set(prev);
                next.has(kind) ? next.delete(kind) : next.add(kind);
                return next;
              })}
            >
              <i /> {kind}
            </button>
          ))}
        </div>
        <div className="spacer" />
        <button
          className="btn sm"
          onClick={() => setShowNewSkill(true)}
          title="Register new skill into memory"
          style={{ background: "rgba(124, 58, 237, 0.25)", color: "#e9d5ff", borderColor: "#8b5cf6" }}
        >
          + Add Skill
        </button>
        <button className="btn icon ghost" onClick={onClose} aria-label="Close knowledge web">
          <IconX size={15} />
        </button>
      </header>

      <div className="kweb-body">
        {showNewSkill && (
          <div className="new-skill-backdrop" onClick={() => setShowNewSkill(false)}>
            <div className="new-skill-dialog" onClick={(e) => e.stopPropagation()}>
              <div className="new-skill-header">
                <h4>Register New Agent Skill</h4>
                <button className="btn icon ghost sm" onClick={() => setShowNewSkill(false)}>
                  <IconX size={14} />
                </button>
              </div>
              <p className="new-skill-desc">
                Skills are stored directly in the neural memory graph with synaptic connections, allowing the agent to reference and execute them autonomously.
              </p>
              <div className="new-skill-form">
                <label className="field-group">
                  <span className="field-label">Skill Title</span>
                  <input
                    type="text"
                    className="field-input"
                    placeholder="e.g. Docker Container Diagnostics"
                    value={skillTitle}
                    onChange={(e) => setSkillTitle(e.target.value)}
                  />
                </label>
                <label className="field-group">
                  <span className="field-label">Operational Procedure & Guidance</span>
                  <textarea
                    rows={3}
                    className="field-input field-textarea"
                    placeholder="Explain execution steps, tools utilized, and verification criteria..."
                    value={skillBody}
                    onChange={(e) => setSkillBody(e.target.value)}
                  />
                </label>
                <label className="field-group">
                  <span className="field-label">Tags (comma-separated)</span>
                  <input
                    type="text"
                    className="field-input"
                    placeholder="e.g. skill, docker, diagnostics"
                    value={skillTags}
                    onChange={(e) => setSkillTags(e.target.value)}
                  />
                </label>
              </div>
              <div className="new-skill-actions">
                <button className="btn ghost sm" onClick={() => setShowNewSkill(false)}>
                  Cancel
                </button>
                <button
                  className="btn primary sm"
                  disabled={!skillTitle.trim()}
                  onClick={createSkill}
                  style={{ background: "#8b5cf6", color: "#fff", borderColor: "#a855f7" }}
                >
                  Save Skill to Memory
                </button>
              </div>
            </div>
          </div>
        )}

        {!data || !data.enabled ? (
          <div className="empty">
            <span className="empty-ring"><IconSpark size={20} /></span>
            <h3>Memory is off</h3>
            <p>Start the harness with a memory store to let the agent keep what it learns.</p>
          </div>
        ) : filtered && filtered.records.length === 0 ? (
          <div className="empty">
            <span className="empty-ring"><IconSpark size={20} /></span>
            <h3>{query ? "Nothing matches" : "Nothing learned yet"}</h3>
            <p>
              {query
                ? "No record matches that search."
                : "After a session finishes, what was worth keeping appears here."}
            </p>
          </div>
        ) : (
          <Graph
            data={filtered!}
            selected={selected}
            onSelect={setSelected}
          />
        )}

        {record && (
          <aside className="kweb-detail">
            <div className="kd-top">
              <span className="kd-kind" style={{ color: KIND_COLOR[record.kind] }}>
                {record.kind}
              </span>
              <span className={`kd-status is-${record.status}`}>{record.status}</span>
              <div className="spacer" />
              <button className="btn icon ghost" onClick={() => setSelected(null)}
                      aria-label="Close record">
                <IconX size={14} />
              </button>
            </div>
            <h3>{record.title}</h3>
            <pre className="kd-body">{record.body}</pre>

            {record.tags.length > 0 && (
              <div className="kd-tags">
                {record.tags.map((t) => <em key={t}>{t}</em>)}
              </div>
            )}

            {/* The whole reason to trust or distrust an entry. */}
            <dl className="kd-meta">
              <dt>Learned from</dt>
              <dd>
                {record.source_session
                  ? <a href={`?session=${record.source_session}`}>
                      {record.source_session}
                      {record.source_seq != null ? ` · event ${record.source_seq}` : ""}
                    </a>
                  : "written directly"}
              </dd>
              <dt>Scope</dt>
              <dd>{record.scope}</dd>
              <dt>Recalled</dt>
              <dd>{record.uses} time{record.uses === 1 ? "" : "s"}</dd>
              {record.superseded_by && (
                <>
                  <dt>Replaced by</dt>
                  <dd>
                    <button className="linkish" onClick={() => setSelected(record.superseded_by!)}>
                      {record.superseded_by}
                    </button>
                  </dd>
                </>
              )}
            </dl>

            <div className="kd-actions">
              <button
                className={`btn ${record.pinned ? "primary" : ""}`}
                onClick={async () => {
                  await patchRecord(record.id, { pinned: !record.pinned });
                  load();
                }}
              >
                {record.pinned ? "Pinned — always loaded" : "Pin to every session"}
              </button>
              <button
                className="btn danger"
                onClick={async () => {
                  await deleteRecord(record.id);
                  setSelected(null);
                  load();
                }}
              >
                Delete from memory
              </button>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

/** Force-directed layout, run on rAF until it settles. */
function Graph({
  data, selected, onSelect,
}: {
  data: Knowledge;
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [, tick] = useState(0);
  const [size, setSize] = useState({ w: 900, h: 700 });
  const fittedRef = useRef("");
  const nodesRef = useRef<Node[]>([]);
  const viewRef = useRef({ x: 0, y: 0, k: 1 });
  const dragRef = useRef<{ id: string | null; x: number; y: number } | null>(null);

  const edges = useMemo(() => edgesFor(data), [data]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const box = entry.contentRect;
      if (box.width > 0) setSize({ w: box.width, h: box.height });
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  // Rebuild only when the set of ids changes, so a re-render does not reset
  // positions the reader has already made sense of.
  const ids = data.records.map((r) => r.id).join(",");
  useEffect(() => {
    const previous = new Map(nodesRef.current.map((n) => [n.id, n]));
    nodesRef.current = data.records.map((record, i) => {
      const old = previous.get(record.id);
      // Seeded on a spiral rather than at random: the same store lays out the
      // same way every time, which matters when you come back to it.
      const angle = i * 2.399;
      const radius = 24 * Math.sqrt(i + 1);
      return {
        id: record.id,
        record,
        x: old?.x ?? Math.cos(angle) * radius,
        y: old?.y ?? Math.sin(angle) * radius,
        vx: 0, vy: 0,
        r: (record.pinned ? 11 : 8) + Math.min(record.uses, 6) * 0.9,
      };
    });
  }, [ids, data.records]);

  useEffect(() => {
    let raf = 0;
    let alpha = 1;
    const byId = () => new Map(nodesRef.current.map((n) => [n.id, n]));

    const step = () => {
      const nodes = nodesRef.current;
      const index = byId();
      // Repulsion. O(n²), which is the right call for a few hundred nodes and
      // far less code than a quadtree that would never be the bottleneck.
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          let dx = b.x - a.x, dy = b.y - a.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1) { dx = (Math.random() - 0.5) * 2; dy = (Math.random() - 0.5) * 2; d2 = 4; }
          const force = REPULSION / d2;
          const d = Math.sqrt(d2);
          const fx = (dx / d) * force, fy = (dy / d) * force;
          a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy;
        }
      }
      for (const edge of edges) {
        const a = index.get(edge.a), b = index.get(edge.b);
        if (!a || !b) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.max(Math.hypot(dx, dy), 1);
        const target = edge.strong ? 135 : 200;
        const k = (d - target) * (edge.strong ? 0.012 : 0.005);
        const fx = (dx / d) * k, fy = (dy / d) * k;
        a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
      }
      for (const node of nodes) {
        node.vx -= node.x * 0.0022;     // gentle pull to centre
        node.vy -= node.y * 0.0022;
        node.vx *= 0.82; node.vy *= 0.82;
        if (dragRef.current?.id === node.id) continue;
        node.x += node.vx * alpha;
        node.y += node.vy * alpha;
      }
      alpha *= 0.994;
      tick((t) => t + 1);
      if (alpha > 0.02) {
        raf = requestAnimationFrame(step);
      } else if (fittedRef.current !== ids) {
        // Settled: frame the whole graph once, so opening the view shows all of
        // it rather than whatever happens to be near the origin.
        fittedRef.current = ids;
        fit();
      }
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [ids, edges]);

  const toWorld = (e: { clientX: number; clientY: number }) => {
    const box = hostRef.current!.getBoundingClientRect();
    const view = viewRef.current;
    return {
      x: (e.clientX - box.left - box.width / 2 - view.x) / view.k,
      y: (e.clientY - box.top - box.height / 2 - view.y) / view.k,
    };
  };

  /** Scale and centre so every node is on screen with room for its label. */
  const fit = useCallback(() => {
    const nodes = nodesRef.current;
    if (!nodes.length) return;
    const pad = 90;
    const xs = nodes.map((n) => n.x), ys = nodes.map((n) => n.y);
    const w = Math.max(...xs) - Math.min(...xs) || 1;
    const h = Math.max(...ys) - Math.min(...ys) || 1;
    const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
    const cy = (Math.max(...ys) + Math.min(...ys)) / 2;
    const k = Math.min((size.w - pad * 2) / w, (size.h - pad * 2) / h, 1.6);
    viewRef.current = { k, x: -cx * k, y: -cy * k };
    tick((t) => t + 1);
  }, [size.w, size.h]);

  const nodes = nodesRef.current;
  const index = new Map(nodes.map((n) => [n.id, n]));
  const view = viewRef.current;

  return (
    <div
      className="kgraph"
      ref={hostRef}
      onWheel={(e) => {
        const next = Math.min(Math.max(view.k * (e.deltaY < 0 ? 1.12 : 0.89), 0.25), 3);
        viewRef.current = { ...view, k: next };
        tick((t) => t + 1);
      }}
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest("[data-node]")) return;
        dragRef.current = { id: null, x: e.clientX - view.x, y: e.clientY - view.y };
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        const drag = dragRef.current;
        if (!drag) return;
        if (drag.id === null) {
          viewRef.current = { ...view, x: e.clientX - drag.x, y: e.clientY - drag.y };
        } else {
          const node = index.get(drag.id);
          if (node) {
            const p = toWorld(e);
            node.x = p.x; node.y = p.y; node.vx = 0; node.vy = 0;
          }
        }
        tick((t) => t + 1);
      }}
      onPointerUp={() => { dragRef.current = null; }}
      onPointerLeave={() => { dragRef.current = null; }}
    >
      <svg className="kgraph-svg">
        <g transform={`translate(${size.w / 2 + view.x}, ${size.h / 2 + view.y}) `
                    + `scale(${view.k})`}>
          <g className="kedges">
            {edges.map((edge, i) => {
              const a = index.get(edge.a), b = index.get(edge.b);
              if (!a || !b) return null;
              const lit = selected === edge.a || selected === edge.b;
              return (
                <line
                  key={i}
                  x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                  className={`kedge ${edge.strong ? "strong" : ""} ${lit ? "lit" : ""}`}
                />
              );
            })}
          </g>
          {nodes.map((node) => {
            const r = node.record;
            const dim = selected !== null && selected !== node.id
              && !edges.some((e) =>
                (e.a === selected && e.b === node.id) || (e.b === selected && e.a === node.id));
            return (
              <g
                key={node.id}
                data-node={node.id}
                transform={`translate(${node.x}, ${node.y})`}
                className={`knode ${selected === node.id ? "on" : ""} ${dim ? "dim" : ""} ` +
                           `is-${r.status}`}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  dragRef.current = { id: node.id, x: 0, y: 0 };
                }}
                onClick={() => onSelect(selected === node.id ? null : node.id)}
              >
                <circle r={node.r} style={{ fill: KIND_COLOR[r.kind] }} />
                {r.pinned && <circle className="kpin" r={node.r + 3.5} />}
                <text y={node.r + 13}>{r.title.slice(0, 28)}</text>
              </g>
            );
          })}
        </g>
      </svg>
      <button className="btn ghost kgraph-fit" onClick={fit}>Fit</button>
      <div className="kgraph-hint">drag to pan · scroll to zoom · click a node</div>
    </div>
  );
}
