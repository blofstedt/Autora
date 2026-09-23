import { useEffect, useMemo, useRef, useState } from "react";
import { IconCheck, IconPin, IconPlus, IconSearch, IconTrash, IconX } from "./Icons";

export type SessionRow = {
  id: string;
  title?: string;
  live?: boolean;
  pinned?: boolean;
  created_at?: number;
  events?: number;
};

function when(ts: number | undefined): string {
  if (!ts) return "";
  const seconds = Math.round(Date.now() / 1000 - ts);
  if (seconds < 90) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d ago`;
  return new Date(ts * 1000).toLocaleDateString();
}

/**
 * Pick a session.
 *
 * This was a bare <select>, which meant the one control in the app that opens
 * something rendered as an OS menu in an OS font -- and showed each session as
 * a timestamp and a nonce, which is how you find a session again, not how you
 * recognise one. Sessions name themselves from their first message now, so
 * there is something worth listing.
 *
 * It is also where sessions are kept tidy: search by title, pin one to keep it
 * at the top, delete one (a second tap confirms, since there is no undo).
 */
export function Sessions({
  sessions, current, onPick, onNew, onClose, onChanged, onDeleted,
}: {
  sessions: SessionRow[];
  current: string | null;
  onPick: (id: string) => void;
  onNew: () => void;
  onClose: () => void;
  /** Pinned or deleted: refresh the app's copy of the list. */
  onChanged: () => void;
  /** A session is gone; the app moves off it if it was the open one. */
  onDeleted: (id: string, remaining: SessionRow[]) => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  // A local copy, so a pin or a delete shows at once rather than after the
  // round trip; the app's list replaces it when that arrives.
  const [rows, setRows] = useState(sessions);
  const [query, setQuery] = useState("");
  const [confirm, setConfirm] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setRows(sessions), [sessions]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    panel.current?.querySelector<HTMLElement>(".ses-entry.on")?.scrollIntoView(
      { block: "nearest" });
    // Straight into the search box with a keyboard; not on a phone, where
    // focusing it would throw the on-screen keyboard over the list.
    if (window.matchMedia?.("(pointer: fine)").matches) search.current?.focus();
  }, []);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows
      .filter((s) => !needle || (s.title?.trim() || "Untitled session").toLowerCase().includes(needle))
      .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned));
  }, [rows, query]);

  const pin = async (row: SessionRow) => {
    const pinned = !row.pinned;
    setError(null);
    setRows((list) => list.map((s) => (s.id === row.id ? { ...s, pinned } : s)));
    const res = await fetch(`/api/sessions/${row.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pinned }),
    }).catch(() => null);
    if (!res?.ok) setError(pinned ? "Could not pin that session." : "Could not unpin that session.");
    onChanged();
  };

  const remove = async (row: SessionRow) => {
    setConfirm(null);
    setError(null);
    const res = await fetch(`/api/sessions/${row.id}`, { method: "DELETE" }).catch(() => null);
    if (!res?.ok) {
      const body = await res?.json().catch(() => null);
      setError(body?.error ?? "Could not delete that session.");
      return;
    }
    const remaining = rows.filter((s) => s.id !== row.id);
    setRows(remaining);
    onDeleted(row.id, remaining);
    onChanged();
  };

  return (
    <div className="scrim" onClick={onClose} role="presentation">
      <div
        className="modal"
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Sessions"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-top">
          <b>Sessions</b>
          <div className="spacer" />
          <button className="btn" onClick={onNew}>
            <IconPlus size={13} /> New
          </button>
          <button className="btn icon ghost" onClick={onClose} aria-label="Close sessions">
            <IconX size={14} />
          </button>
        </div>

        <label className="ses-search">
          <IconSearch size={14} />
          <input
            ref={search}
            type="search"
            placeholder="Search sessions"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search sessions"
          />
        </label>

        <div className="modal-body">
          {error && <p className="set-warn ses-error">{error}</p>}
          {rows.length === 0 && (
            <p className="jf-hint">No sessions yet.</p>
          )}
          {rows.length > 0 && shown.length === 0 && (
            <p className="jf-hint">No session matches “{query.trim()}”.</p>
          )}
          {shown.map((s) => (
            <div key={s.id} className={`ses-entry ${s.id === current ? "on" : ""}`}>
              <button className="ses-row" onClick={() => onPick(s.id)}>
                <span className={`ses-dot ${s.live ? "is-live" : ""}`} />
                <span className="ses-main">
                  {/* The id is the fallback, not the headline: an unnamed session
                      is one nobody has asked anything yet. */}
                  <b>{s.title?.trim() || "Untitled session"}</b>
                  <em>
                    {s.pinned ? "pinned · " : ""}
                    {when(s.created_at)}
                    {s.events ? ` · ${s.events} events` : ""}
                    {s.live ? " · live" : ""}
                  </em>
                </span>
                {s.id === current && <IconCheck size={14} />}
              </button>
              <button
                className={`ses-act ${s.pinned ? "is-pinned" : ""}`}
                onClick={() => void pin(s)}
                aria-pressed={!!s.pinned}
                aria-label={s.pinned ? "Unpin session" : "Pin session"}
                title={s.pinned ? "Unpin" : "Pin to the top"}
              >
                <IconPin size={14} />
              </button>
              {confirm === s.id ? (
                <button
                  className="ses-act is-confirm"
                  onClick={() => void remove(s)}
                  onBlur={() => setConfirm(null)}
                  autoFocus
                >
                  Delete
                </button>
              ) : (
                <button
                  className="ses-act"
                  onClick={() => setConfirm(s.id)}
                  aria-label="Delete session"
                  title="Delete"
                >
                  <IconTrash size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
