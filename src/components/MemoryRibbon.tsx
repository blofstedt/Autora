import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MemoryMark } from "../lib/derive";
import { BUCKETS, KIND_COLOR, fetchKnowledge, onKnowledgeChange, type Knowledge } from "../lib/memory";
import { IconChevron } from "./Icons";
import { useThemeColors } from "../lib/theme";

/** How long a node stays lit after the event that touched it - fades slowly */
const GLOW_MS = 4800;
/** Re-read the store periodically */
const POLL_MS = 15_000;

/** Tracer duration: slow, meditative, organic propagation of action potential */
const TRACER_DURATION = 3800;
/** How long connection glow persists and fades out slowly afterwards */
const EDGE_GLOW_LIFETIME = 5200;
/** How long lingering arrival pulse at target node dissolves */
const PULSE_FADE_LIFETIME = 3200;

type Placed = {
  id: string;
  x: number;
  y: number;
  r: number;
  record: Knowledge["records"][0];
};

type NeuralTracerState = {
  id: string;
  source: Placed;
  target: Placed;
  startTime: number;
  duration: number;
};

type GlowingEdge = {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  startTime: number;
};

type LingeringPulse = {
  id: string;
  x: number;
  y: number;
  startTime: number;
};

export function MemoryRibbon({
  memories,
  onOpen,
  collapsed = false,
  onToggle,
  pane = false,
}: {
  memories: MemoryMark[];
  /** Opens the Mind page: a tap anywhere on the map, folded or not. */
  onOpen: () => void;
  /** Folded to one line: the newest event, no graph. */
  collapsed?: boolean;
  onToggle?: () => void;
  /** Drawn at the foot of the desktop rail rather than above the chat: always
      open, no fold button. Square either way. */
  pane?: boolean;
}) {
  const [web, setWeb] = useState<Knowledge>({ records: [], links: [], enabled: true });
  const colors = useThemeColors();
  const seen = useRef(new Map<string, number>());
  const [lit, setLit] = useState<Map<string, "written" | "recalled">>(new Map());
  const [activeTracer, setActiveTracer] = useState<NeuralTracerState | null>(null);
  const [tracerProgress, setTracerProgress] = useState<{
    phase: "orbit-source" | "travel-edge" | "orbit-target" | "done";
    pos: { x: number; y: number };
    pulseRadius: number;
    opacity: number;
    arrivalRipple: number; // 0 to 1
  } | null>(null);

  const [glowingEdges, setGlowingEdges] = useState<GlowingEdge[]>([]);
  const [lingeringPulses, setLingeringPulses] = useState<LingeringPulse[]>([]);

  // Cognitive tracking: Follow what the bot is actually reading/accessing
  const processedSeqs = useRef(new Set<number>());
  const synapseQueue = useRef<{ sourceId: string; targetId: string }[]>([]);
  const lastAccessedId = useRef<string | null>(null);

  const load = useCallback(() => {
    void fetchKnowledge().then(setWeb).catch(() => undefined);
  }, []);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, POLL_MS);
    const stop = onKnowledgeChange(load);
    return () => { window.clearInterval(timer); stop(); };
  }, [load]);

  const latestSeq = memories.length ? memories[memories.length - 1].seq : 0;
  useEffect(() => {
    if (latestSeq) load();
  }, [latestSeq, load]);

  // Layout & auto-zoom: records spread round (0, 0) in a circle, framed by a
  // square viewBox. Square everywhere -- the phone banner and the desktop rail
  // alike -- so the same memory has the same shape wherever you look at it,
  // instead of a web squashed flat on a phone and pulled tall on a desk.
  const { placed, viewBox, bgDots } = useMemo(() => {
    const rows = web.records;
    if (rows.length === 0) {
      return {
        placed: [] as Placed[],
        viewBox: "-120 -120 240 240",
        bgDots: [] as { x: number; y: number }[],
      };
    }

    const golden = 2.399963;
    const computedPlaced: Placed[] = rows.map((record, index) => {
      let hash = 0;
      for (let i = 0; i < record.id.length; i++) hash = (hash * 31 + record.id.charCodeAt(i)) | 0;
      const angle = index * golden + ((hash % 100) / 400);
      const radius = index === 0 ? 0 : 28 + Math.sqrt(index) * 26 + ((hash >>> 5) % 12);
      const x = Math.cos(angle) * radius;
      const y = Math.sin(angle) * radius;
      const r = record.kind === "skill" ? 6 : record.pinned ? 7 : record.status === "provisional" ? 4.2 : 5.5;
      return { id: record.id, x, y, r, record };
    });

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of computedPlaced) {
      minX = Math.min(minX, p.x - p.r);
      maxX = Math.max(maxX, p.x + p.r);
      minY = Math.min(minY, p.y - p.r);
      maxY = Math.max(maxY, p.y + p.r);
    }

    // Padding so no node is ever cut off, and a floor so three memories do not
    // get blown up to fill the whole square.
    const pad = 20;
    const span = Math.max(240, maxX - minX + pad * 2, maxY - minY + pad * 2);
    const vbX = (minX + maxX) / 2 - span / 2;
    const vbY = (minY + maxY) / 2 - span / 2;

    const dots: { x: number; y: number }[] = [];
    const step = span / 7;
    for (let c = 1; c < 7; c++) {
      for (let r = 1; r < 7; r++) {
        dots.push({ x: vbX + c * step, y: vbY + r * step });
      }
    }

    return {
      placed: computedPlaced,
      viewBox: `${vbX} ${vbY} ${span} ${span}`,
      bgDots: dots,
    };
  }, [web.records]);

  const active = memories.length ? memories[memories.length - 1].id : null;
  const byId = useMemo(() => new Map(placed.map((p) => [p.id, p])), [placed]);
  const edges = useMemo(() => {
    return web.links
      .map((l) => ({ a: byId.get(l.src), b: byId.get(l.dst) }))
      .filter((e): e is { a: Placed; b: Placed } => !!e.a && !!e.b);
  }, [web.links, byId]);

  // Trigger glowing when memories are touched/created - slow fade
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

  // Launch a neural tracer along an authentic synaptic link
  const fireTracer = useCallback((source: Placed, target: Placed) => {
    const now = performance.now();
    setActiveTracer({
      id: `${source.id}->${target.id}-${now}`,
      source,
      target,
      startTime: now,
      duration: TRACER_DURATION,
    });

    // Add this connection line to glowingEdges so it remains glowing and fades slowly afterwards
    setGlowingEdges((prev) => [
      ...prev.filter((e) => now - e.startTime < EDGE_GLOW_LIFETIME),
      {
        id: `glow-${source.id}-${target.id}-${now}`,
        x1: source.x,
        y1: source.y,
        x2: target.x,
        y2: target.y,
        startTime: now,
      },
    ]);
  }, []);

  // Follow what the bot is reading / accessing:
  // Whenever new memory marks arrive from the agent, queue the exact synaptic pathway!
  useEffect(() => {
    const newlyRecalled: string[] = [];
    for (const m of memories) {
      if (!processedSeqs.current.has(m.seq)) {
        processedSeqs.current.add(m.seq);
        newlyRecalled.push(m.id);
      }
    }

    if (newlyRecalled.length === 0) return;

    if (newlyRecalled.length > 1) {
      // The bot accessed multiple memories in a reasoning sequence: synapse between them
      for (let i = 0; i < newlyRecalled.length - 1; i++) {
        synapseQueue.current.push({
          sourceId: newlyRecalled[i],
          targetId: newlyRecalled[i + 1],
        });
      }
      lastAccessedId.current = newlyRecalled[newlyRecalled.length - 1];
    } else {
      const currentId = newlyRecalled[0];
      if (lastAccessedId.current && lastAccessedId.current !== currentId) {
        // Connect from previously accessed node to the currently accessed one
        synapseQueue.current.push({
          sourceId: lastAccessedId.current,
          targetId: currentId,
        });
      } else {
        // Single accessed node: synapse along its authentic knowledge graph connection
        const directEdges = edges.filter((ed) => ed.a.id === currentId || ed.b.id === currentId);
        if (directEdges.length > 0) {
          const chosen = directEdges[0];
          const neighbor = chosen.a.id === currentId ? chosen.b : chosen.a;
          synapseQueue.current.push({
            sourceId: currentId,
            targetId: neighbor.id,
          });
        }
      }
      lastAccessedId.current = currentId;
    }
  }, [memories, edges]);

  // Drain the data-driven synapsing queue sequentially (no random timers!)
  useEffect(() => {
    if (activeTracer) return;
    if (synapseQueue.current.length === 0) return;

    const nextPair = synapseQueue.current.shift();
    if (!nextPair) return;

    const srcNode = byId.get(nextPair.sourceId);
    const dstNode = byId.get(nextPair.targetId);
    if (srcNode && dstNode) {
      fireTracer(srcNode, dstNode);
    }
  }, [activeTracer, byId, fireTracer]);

  // Animation loop: slow, soft biological pulse that travels and slowly fades
  useEffect(() => {
    if (!activeTracer) {
      setTracerProgress(null);
      return;
    }

    let frameId: number;
    const tick = () => {
      const now = performance.now();
      const elapsed = now - activeTracer.startTime;
      const total = activeTracer.duration;

      if (elapsed >= total) {
        // Record lingering arrival pulse at target node so it fades slowly
        setLingeringPulses((prev) => [
          ...prev.filter((p) => now - p.startTime < PULSE_FADE_LIFETIME),
          {
            id: `pulse-${activeTracer.target.id}-${now}`,
            x: activeTracer.target.x,
            y: activeTracer.target.y,
            startTime: now,
          },
        ]);

        setActiveTracer(null);
        setTracerProgress(null);
        return;
      }

      const pSource = activeTracer.source;
      const pTarget = activeTracer.target;

      // Stage 1: Soft pulse awakening at source (0 - 700ms)
      if (elapsed < 700) {
        const t = elapsed / 700;
        const breath = Math.sin(t * Math.PI) * 3;
        setTracerProgress({
          phase: "orbit-source",
          pos: { x: pSource.x, y: pSource.y },
          pulseRadius: 8 + breath,
          opacity: 0.35 + t * 0.55,
          arrivalRipple: 0,
        });
      }
      // Stage 2: Gentle, slow travel along connection line (700ms - 3100ms, 2400ms duration)
      else if (elapsed < 3100) {
        const t = (elapsed - 700) / 2400;
        // Smooth sine ease in-out for meditative, organic motion
        const ease = 0.5 - 0.5 * Math.cos(t * Math.PI);
        const x = pSource.x + (pTarget.x - pSource.x) * ease;
        const y = pSource.y + (pTarget.y - pSource.y) * ease;
        // Bioelectric undulating breath along the path
        const breath = Math.sin(t * Math.PI * 4) * 2.2;
        setTracerProgress({
          phase: "travel-edge",
          pos: { x, y },
          pulseRadius: 7.5 + breath,
          opacity: 0.9,
          arrivalRipple: 0,
        });
      }
      // Stage 3: Synaptic arrival & absorption at target (3100ms - 3800ms, 700ms duration)
      else {
        const t = (elapsed - 3100) / 700;
        setTracerProgress({
          phase: "orbit-target",
          pos: { x: pTarget.x, y: pTarget.y },
          pulseRadius: 8.5 + (1 - t) * 4,
          opacity: 0.9 * (1 - t * 0.25),
          arrivalRipple: t,
        });
      }

      frameId = requestAnimationFrame(tick);
    };

    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [activeTracer]);

  const newest = memories.length ? memories[memories.length - 1] : null;

  if (placed.length === 0 && !newest) return null;

  const now = performance.now();

  // What each node colour means, in the Mind page's order.
  const legend = (
    <div className="web-legend" aria-label="Legend">
      {BUCKETS.map((b) => (
        <span key={b.kind} className="web-legend-item">
          <i style={{ background: KIND_COLOR[b.kind] }} />
          {b.label}
        </span>
      ))}
    </div>
  );

  // The whole map is one big button to the Mind page. The fold toggle and the
  // nodes keep their own behaviour on top of it.
  const open = {
    role: "button" as const,
    tabIndex: 0,
    title: "Open the Mind",
    "aria-label": "Memory map: open the Mind",
    onClick: onOpen,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        onOpen();
      }
    },
  };

  if (collapsed) {
    return (
      <section className="web neural-web is-collapsed" {...open}>
        <div className="web-bar">
          <span className="web-bar-latest" key={newest?.seq}>
            {newest && <span className="neural-pulse-dot" />}
            {newest
              ? `${newest.kind === "written" ? "learned" : "recalled"} · ${newest.title}`
              : "memory"}
          </span>
          {onToggle && (
            <button className="web-toggle" onClick={(e) => { e.stopPropagation(); onToggle(); }} aria-expanded={false} aria-label="Show the memory graph" title="Show the memory graph">
              <IconChevron size={13} />
            </button>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className={`web neural-web${pane ? " is-pane" : ""}`} {...open}>
      {onToggle && !pane && (
        <button className="web-toggle is-open" onClick={(e) => { e.stopPropagation(); onToggle(); }} aria-expanded={true} aria-label="Hide the memory graph" title="Hide the memory graph">
          <IconChevron size={13} />
        </button>
      )}
      {legend}

      <div className="web-stage neural-stage" role="presentation">
        {placed.length === 0 ? (
          <span className="web-empty">
            Neural web initializing — memories and skills form here.
          </span>
        ) : (
          <svg
            viewBox={viewBox}
            preserveAspectRatio="xMidYMid meet"
            className="web-svg neural-svg"
            aria-hidden="true"
          >
            <defs>
              {/* Soft purple glow filter for tracers & nodes */}
              <filter id="neural-glow" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation="3.2" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>

              <filter id="neural-bloom" x="-60%" y="-60%" width="220%" height="220%">
                <feGaussianBlur stdDeviation="5.5" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>

              {/* Soft ethereal radial gradient for the neural pulse */}
              <radialGradient id="neural-pulse-glow" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="#ffffff" stopOpacity="0.95" />
                <stop offset="35%" stopColor={colors.glowText} stopOpacity="0.75" />
                <stop offset="70%" stopColor={colors.glowLight} stopOpacity="0.35" />
                <stop offset="100%" stopColor={colors.glowDeep} stopOpacity="0" />
              </radialGradient>

              {/* Atmospheric aura gradient */}
              <radialGradient id="neural-aura-glow" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor={colors.glowLight} stopOpacity="0.5" />
                <stop offset="60%" stopColor={colors.glow} stopOpacity="0.2" />
                <stop offset="100%" stopColor={colors.glowDeep} stopOpacity="0" />
              </radialGradient>
            </defs>

            {/* Neural background grid dots covering viewBox */}
            <g className="neural-bg-dots" opacity="0.16">
              {bgDots.map((pt, i) => (
                <circle key={i} cx={pt.x} cy={pt.y} r="0.8" fill={colors.glow} />
              ))}
            </g>

            {/* Base Edges - solid and smooth, no animated dashed lines */}
            {edges.map((e, i) => {
              const travelled = lit.has(e.a.id) || lit.has(e.b.id);
              return (
                <line
                  key={i}
                  x1={e.a.x}
                  y1={e.a.y}
                  x2={e.b.x}
                  y2={e.b.y}
                  className={`web-edge neural-edge ${travelled ? "neural-active" : ""}`}
                />
              );
            })}

            {/* Glowing Connection Edges that fade slowly afterwards */}
            {glowingEdges.map((ge) => {
              const age = now - ge.startTime;
              if (age >= EDGE_GLOW_LIFETIME) return null;
              // While tracer is active (< 2800ms), stays luminous (~0.9)
              // After tracer arrives, it fades slowly over the remaining 2400ms
              let opacity = 0.9;
              if (age > 2800) {
                const fadeProgress = (age - 2800) / (EDGE_GLOW_LIFETIME - 2800);
                opacity = Math.max(0, 0.9 * Math.pow(1 - fadeProgress, 1.8));
              }
              if (opacity <= 0.01) return null;

              return (
                <g key={ge.id} pointerEvents="none">
                  {/* Outer bloom stroke */}
                  <line
                    x1={ge.x1}
                    y1={ge.y1}
                    x2={ge.x2}
                    y2={ge.y2}
                    stroke={colors.glow}
                    strokeWidth="4.8"
                    strokeOpacity={opacity * 0.45}
                    strokeLinecap="round"
                    filter="url(#neural-bloom)"
                  />
                  {/* Luminous inner core stroke */}
                  <line
                    x1={ge.x1}
                    y1={ge.y1}
                    x2={ge.x2}
                    y2={ge.y2}
                    stroke={colors.glowText}
                    strokeWidth="2.2"
                    strokeOpacity={opacity * 0.85}
                    strokeLinecap="round"
                    filter="url(#neural-glow)"
                  />
                </g>
              );
            })}

            {/* Lingering Arrival Pulses that fade slowly afterwards */}
            {lingeringPulses.map((lp) => {
              const age = now - lp.startTime;
              if (age >= PULSE_FADE_LIFETIME) return null;
              const progress = age / PULSE_FADE_LIFETIME;
              const opacity = Math.max(0, 0.85 * Math.pow(1 - progress, 2));
              const r = 8 + progress * 15;

              return (
                <g key={lp.id} pointerEvents="none">
                  <circle
                    cx={lp.x}
                    cy={lp.y}
                    r={r}
                    fill="url(#neural-pulse-glow)"
                    opacity={opacity}
                    filter="url(#neural-bloom)"
                  />
                </g>
              );
            })}

            {/* Active Neural Tracer: Softer, like a biological pulse, slowed down */}
            {activeTracer && tracerProgress && (
              <g className="neural-tracer-group" pointerEvents="none">
                {/* Expanding soft atmospheric aura */}
                <circle
                  cx={tracerProgress.pos.x}
                  cy={tracerProgress.pos.y}
                  r={tracerProgress.pulseRadius * 2.2}
                  fill="url(#neural-aura-glow)"
                  opacity={tracerProgress.opacity * 0.4}
                  filter="url(#neural-bloom)"
                />

                {/* Intermediate soft pulse wave */}
                <circle
                  cx={tracerProgress.pos.x}
                  cy={tracerProgress.pos.y}
                  r={tracerProgress.pulseRadius}
                  fill="url(#neural-pulse-glow)"
                  opacity={tracerProgress.opacity * 0.85}
                  filter="url(#neural-glow)"
                />

                {/* Soft translucent inner nucleus */}
                <circle
                  cx={tracerProgress.pos.x}
                  cy={tracerProgress.pos.y}
                  r={Math.max(2.2, tracerProgress.pulseRadius * 0.35)}
                  fill="#ffffff"
                  opacity={tracerProgress.opacity * 0.95}
                />

                {/* Arrival synaptic diffusion ripple */}
                {tracerProgress.arrivalRipple > 0 && (
                  <circle
                    cx={activeTracer.target.x}
                    cy={activeTracer.target.y}
                    r={activeTracer.target.r + 3 + tracerProgress.arrivalRipple * 16}
                    fill="none"
                    stroke={colors.glowLight}
                    strokeWidth={2 * (1 - tracerProgress.arrivalRipple)}
                    opacity={0.85 * (1 - tracerProgress.arrivalRipple)}
                    filter="url(#neural-glow)"
                  />
                )}
              </g>
            )}

            {/* Nodes */}
            {placed.map((p) => {
              const state = lit.get(p.id);
              const isWritten = state === "written";
              const isRecalled = state === "recalled";
              const isSkill = p.record.kind === "skill";

              return (
                <g
                  key={p.id}
                  data-id={p.id}
                  className={`web-node neural-node ${state ? `is-${state}` : ""} ${
                    p.id === active ? "is-focus" : ""
                  }`}
                  style={{ cursor: "pointer" }}
                  onClick={() => {
                    // A node fires along one of its links, then the tap carries
                    // on to the map and opens the Mind like anywhere else.
                    const connected = edges
                      .filter((ed) => ed.a.id === p.id || ed.b.id === p.id)
                      .map((ed) => (ed.a.id === p.id ? ed.b : ed.a));
                    if (connected.length > 0) {
                      const next = connected[Math.floor(Math.random() * connected.length)];
                      fireTracer(p, next);
                    }
                  }}
                >
                  {/* Glowing bloom halo on creation/write */}
                  {isWritten && (
                    <circle
                      cx={p.x}
                      cy={p.y}
                      r={p.r * 2.6}
                      className="neural-glow-bloom"
                      filter="url(#neural-bloom)"
                    />
                  )}

                  {/* Recall pulse halo */}
                  {isRecalled && (
                    <circle cx={p.x} cy={p.y} r={p.r + 3.5} className="web-halo neural-halo" />
                  )}

                  {/* Node base body */}
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r={p.r}
                    fill={KIND_COLOR[p.record.kind] ?? "var(--accent)"}
                    fillOpacity={p.record.status === "provisional" ? 0.5 : 0.95}
                    stroke={isSkill ? colors.glowLight : p.record.pinned ? "#fff" : "rgba(255,255,255,0.2)"}
                    strokeWidth={isSkill ? 1.5 : p.record.pinned ? 1.2 : 0.8}
                    filter={state ? "url(#neural-glow)" : undefined}
                  />

                  {/* Inner spark for skills */}
                  {isSkill && (
                    <circle cx={p.x} cy={p.y} r={p.r * 0.4} fill="#ffffff" opacity="0.9" />
                  )}
                </g>
              );
            })}
          </svg>
        )}

        {/* Latest event caption */}
        {newest && (
          <span className={`web-latest neural-latest is-${newest.kind}`} key={newest.seq}>
            <span className="neural-pulse-dot" />
            {newest.kind === "written" ? "learned" : "synapsing"} · {newest.title}
          </span>
        )}
      </div>
    </section>
  );
}
