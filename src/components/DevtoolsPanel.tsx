import { useCallback, useEffect, useRef, useState } from "react";
import { IconX } from "./Icons";
import { every } from "../lib/poll";

type Entry = {
  n: number; tab: number; ts: number; kind: "console" | "request"; level: string; text: string;
  method?: string; status?: number; ms?: number; bytes?: number; failed?: string;
};

const bytes = (n?: number) => (!n ? "" : n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n > 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

/**
 * DevTools' console and network, for the page that is open: what it said and
 * what it asked for. The agent reads the same lists (browser_devtools), so
 * what you see here is what it is told. Polled while open.
 */
export function DevtoolsPanel({
  sessionId, target, onClose,
}: { sessionId: string; target?: "preview"; onClose: () => void }) {
  const [tab, setTab] = useState<"console" | "network">("console");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const base = `/api/sessions/${sessionId}/browser`;
  const q = target ? `&target=${target}` : "";

  const load = useCallback(() => {
    fetch(`${base}/devtools?kind=${tab === "console" ? "console" : "request"}${q}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) setEntries(d.entries as Entry[]); })
      .catch(() => undefined);
  }, [base, tab, q]);

  useEffect(() => {
    load();
    return every(load, 1500);
  }, [load]);

  useEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [entries]);

  const shown = entries.filter((e) =>
    !errorsOnly || e.failed || (e.kind === "console" && e.level === "error") || (e.status ?? 0) >= 400);

  return (
    <div className="shot-panel shot-dev">
      <div className="shot-panel-head">
        <button className={`cell-act${tab === "console" ? " on" : ""}`} onClick={() => setTab("console")}>Console</button>
        <button className={`cell-act${tab === "network" ? " on" : ""}`} onClick={() => setTab("network")}>Network</button>
        <label className="shot-dev-only">
          <input type="checkbox" checked={errorsOnly} onChange={(e) => setErrorsOnly(e.target.checked)} /> errors
        </label>
        <span style={{ flex: 1 }} />
        <button
          className="cell-act"
          onClick={() => void fetch(`${base}/devtools/clear?${q.slice(1)}`, { method: "POST" }).then(load)}
        >
          Clear
        </button>
        <button className="shot-tool" onClick={onClose} aria-label="Close developer tools"><IconX size={13} /></button>
      </div>
      <div
        ref={list}
        className="shot-panel-list shot-dev-list"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {shown.length === 0 && <p className="shot-panel-empty">{tab === "console" ? "The console is quiet." : "No requests yet."}</p>}
        {shown.map((e) => e.kind === "console"
          ? <div key={e.n} className={`shot-dev-row is-${e.level}`}><b>{e.level}</b><span>{e.text}</span></div>
          : (
            <div key={e.n} className={`shot-dev-row${e.failed || (e.status ?? 0) >= 400 ? " is-error" : ""}`} title={e.text}>
              <b>{e.method}</b>
              <span>{e.text.replace(/^https?:\/\//, "")}</span>
              <em>{e.failed ? "failed" : e.status} · {e.level} · {e.ms ?? 0} ms{e.bytes ? ` · ${bytes(e.bytes)}` : ""}</em>
            </div>
          ))}
      </div>
    </div>
  );
}
