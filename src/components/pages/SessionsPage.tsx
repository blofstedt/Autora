import { useCallback, useEffect, useMemo, useState } from "react";
import { IconDownload, IconEdit, IconTrash } from "../Icons";

type Row = {
  id: string; title: string; live: boolean; busy: boolean;
  created_at: number; updated_at: number; events: number;
  turns: number; tools: number; errors: number; cost: number; tokens: number;
};

const ago = (ts: number) => {
  const s = Math.round(Date.now() / 1000 - ts);
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return new Date(ts * 1000).toLocaleDateString();
};
const money = (n: number) => (n ? `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}` : "—");

/**
 * Every session: find one, see what it cost and how much it did, open it,
 * rename it, take a copy of it, or get rid of it.
 */
export function SessionsPage({
  current, onOpen, onChanged, onDelete, hidden,
}: {
  current: string | null;
  onOpen: (id: string) => void;
  /** Delete, with Undo: the app holds the actual removal back a moment. */
  onDelete: (row: { id: string; title: string }) => void;
  /** A session whose delete is waiting out its Undo: not listed. */
  hidden: string | null;
  /** The list changed (renamed, deleted): refresh the app's copy. */
  onChanged: () => void;
}) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"recent" | "active" | "cost">("recent");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/sessions").then((r) => r.json()).then(setRows).catch(() => setError("Could not load sessions."));
  }, []);
  useEffect(() => {
    load();
    const t = window.setInterval(load, 8000);
    return () => window.clearInterval(t);
  }, [load]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = (rows ?? [])
      .filter((r) => r.id !== hidden)
      .filter((r) => !needle || r.title.toLowerCase().includes(needle) || r.id.includes(needle));
    const key = sort === "recent" ? (r: Row) => r.updated_at : sort === "active" ? (r: Row) => r.tools + r.turns : (r: Row) => r.cost;
    return [...list].sort((a, b) => key(b) - key(a));
  }, [rows, q, sort, hidden]);

  const totals = useMemo(() => (rows ?? []).reduce(
    (t, r) => ({ events: t.events + r.events, tools: t.tools + r.tools, cost: t.cost + r.cost, turns: t.turns + r.turns }),
    { events: 0, tools: 0, cost: 0, turns: 0 },
  ), [rows]);

  const rename = async (id: string) => {
    const title = draft.trim();
    setEditing(null);
    if (!title) return;
    const res = await fetch(`/api/sessions/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title }),
    }).catch(() => null);
    if (!res?.ok) setError("Could not rename that session.");
    load(); onChanged();
  };

  const exportSession = async (row: Row) => {
    const events: unknown[] = [];
    for (let from = 0; ; ) {
      const page = await fetch(`/api/sessions/${row.id}/events?from_seq=${from}&limit=1000`).then((r) => r.json()).catch(() => null);
      const batch = Array.isArray(page) ? page : page?.events ?? [];
      events.push(...batch);
      if (batch.length < 1000) break;
      from = (batch[batch.length - 1] as { seq: number }).seq + 1;
    }
    const blob = new Blob([JSON.stringify({ session: row, events }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${row.title.replace(/[^\w-]+/g, "-").slice(0, 40) || row.id}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="page-scroll">
      <div className="page-inner">
        <div className="stat-grid is-compact">
          <div className="stat-card"><span className="stat-label">Sessions</span><b className="stat-value">{rows?.length ?? "…"}</b></div>
          <div className="stat-card"><span className="stat-label">Messages</span><b className="stat-value">{totals.turns}</b></div>
          <div className="stat-card"><span className="stat-label">Tool calls</span><b className="stat-value">{totals.tools}</b></div>
          <div className="stat-card"><span className="stat-label">Spend</span><b className="stat-value">{money(totals.cost)}</b></div>
        </div>

        <div className="page-toolbar">
          <input
            className="page-search"
            placeholder="Search sessions…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search sessions"
          />
          <div className="seg" role="radiogroup" aria-label="Sort">
            {(["recent", "active", "cost"] as const).map((k) => (
              <button key={k} className={sort === k ? "on" : ""} onClick={() => setSort(k)} aria-pressed={sort === k}>
                {k === "recent" ? "Recent" : k === "active" ? "Most active" : "Cost"}
              </button>
            ))}
          </div>
        </div>
        {error && <p className="set-warn" onClick={() => setError(null)}>{error}</p>}

        <div className="ses-table">
          {shown.map((r) => (
            <div key={r.id} className={`ses-item ${r.id === current ? "on" : ""}`}>
              <button className="ses-item-main" onClick={() => onOpen(r.id)}>
                <span className={`ses-dot ${r.busy ? "is-busy" : r.live ? "is-live" : ""}`} />
                <span className="ses-item-text">
                  {editing === r.id ? (
                    <input
                      autoFocus
                      className="ses-rename"
                      value={draft}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={() => void rename(r.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void rename(r.id);
                        if (e.key === "Escape") setEditing(null);
                      }}
                    />
                  ) : (
                    <b>{r.title}</b>
                  )}
                  <em>
                    {ago(r.updated_at)} · {r.turns} message{r.turns === 1 ? "" : "s"} · {r.tools} tool call{r.tools === 1 ? "" : "s"}
                    {r.errors ? ` · ${r.errors} error${r.errors === 1 ? "" : "s"}` : ""}
                    {r.busy ? " · working" : ""}
                  </em>
                </span>
                {r.cost > 0 && <span className="ses-cost">{money(r.cost)}</span>}
              </button>
              <div className="ses-acts">
                  <>
                    <button className="btn icon ghost" title="Rename" aria-label="Rename"
                            onClick={() => { setEditing(r.id); setDraft(r.title); }}>
                      <IconEdit size={14} />
                    </button>
                    <button className="btn icon ghost" title="Export as JSON" aria-label="Export"
                            onClick={() => void exportSession(r)}>
                      <IconDownload size={14} />
                    </button>
                    <button className="btn icon ghost" title="Delete" aria-label="Delete"
                            disabled={r.busy} onClick={() => onDelete(r)}>
                      <IconTrash size={14} />
                    </button>
                  </>
              </div>
            </div>
          ))}
          {rows && shown.length === 0 && <p className="jf-hint">{q ? "No session matches." : "No sessions yet."}</p>}
        </div>
      </div>
    </div>
  );
}
