import { useEffect, useLayoutEffect, useRef, useState } from "react";

type Line = { id: number; ts: number; level: "debug" | "info" | "warn" | "error"; component: string; message: string; session?: string };
type Level = "" | Line["level"];

const LEVELS: { id: Level; label: string }[] = [
  { id: "", label: "All" },
  { id: "info", label: "Info+" },
  { id: "warn", label: "Warnings+" },
  { id: "error", label: "Errors" },
];

const time = (ts: number) => new Date(ts).toLocaleTimeString([], { hour12: false });

/**
 * What the server has been doing: agent turns and tool calls, provider and
 * MCP errors, failed requests, and anything it printed. Filter by level,
 * component or text; live tail follows new lines as they arrive.
 */
export function LogsPage() {
  const [lines, setLines] = useState<Line[]>([]);
  const [components, setComponents] = useState<string[]>([]);
  const [level, setLevel] = useState<Level>("");
  const [component, setComponent] = useState("");
  const [q, setQ] = useState("");
  const [live, setLive] = useState(true);
  const [debug, setDebug] = useState(false);
  const latest = useRef(0);
  const box = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  const query = (after?: number) => {
    const p = new URLSearchParams({ limit: "1000" });
    if (level) p.set("level", level);
    else if (!debug) p.set("level", "info");
    if (component) p.set("component", component);
    if (q.trim()) p.set("q", q.trim());
    if (after !== undefined) p.set("after", String(after));
    return `/api/logs?${p}`;
  };

  // A new filter is a fresh read; live tail then asks only for what is newer.
  useEffect(() => {
    let alive = true;
    fetch(query()).then((r) => r.json()).then((d) => {
      if (!alive) return;
      setLines(d.lines); setComponents(d.components); latest.current = d.latest;
      atBottom.current = true;
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [level, component, q, debug]);

  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => {
      fetch(query(latest.current)).then((r) => r.json()).then((d) => {
        latest.current = d.latest;
        setComponents(d.components);
        if (d.lines.length) setLines((prev) => [...prev, ...d.lines].slice(-3000));
      }).catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [live, level, component, q, debug]);

  useLayoutEffect(() => {
    const el = box.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <div className="logs-page">
      <div className="page-toolbar logs-toolbar">
        <div className="seg" role="radiogroup" aria-label="Level">
          {LEVELS.map((l) => (
            <button key={l.id || "all"} className={level === l.id ? "on" : ""} onClick={() => setLevel(l.id)} aria-pressed={level === l.id}>
              {l.label}
            </button>
          ))}
        </div>
        <select className="page-select" value={component} onChange={(e) => setComponent(e.target.value)} aria-label="Component">
          <option value="">All components</option>
          {components.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <input className="page-search" placeholder="Filter text…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter" />
        <label className="page-check">
          <input type="checkbox" checked={debug} onChange={(e) => setDebug(e.target.checked)} /> debug
        </label>
        <button className={`btn ${live ? "primary" : ""}`} onClick={() => setLive((v) => !v)} aria-pressed={live}>
          {live ? "● Live" : "Paused"}
        </button>
      </div>
      <div
        className="logs-box"
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {lines.length === 0 && <p className="jf-hint">Nothing logged that matches.</p>}
        {lines.map((l) => (
          <div key={l.id} className={`log-line is-${l.level}`}>
            <span className="log-time">{time(l.ts)}</span>
            <span className="log-level">{l.level}</span>
            <button className="log-comp" onClick={() => setComponent(l.component)} title={`Only ${l.component}`}>{l.component}</button>
            <span className="log-msg">{l.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
