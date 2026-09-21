import { useEffect, useRef } from "react";
import { IconCheck, IconPlus, IconX } from "./Icons";

export type SessionRow = {
  id: string;
  title?: string;
  live?: boolean;
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
 */
export function Sessions({
  sessions, current, onPick, onNew, onClose,
}: {
  sessions: SessionRow[];
  current: string | null;
  onPick: (id: string) => void;
  onNew: () => void;
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    panel.current?.querySelector<HTMLButtonElement>(".ses-row.on")?.scrollIntoView(
      { block: "nearest" });
  }, []);

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

        <div className="modal-body">
          {sessions.length === 0 && (
            <p className="jf-hint">No sessions yet.</p>
          )}
          {sessions.map((s) => (
            <button
              key={s.id}
              className={`ses-row ${s.id === current ? "on" : ""}`}
              onClick={() => onPick(s.id)}
            >
              <span className={`ses-dot ${s.live ? "is-live" : ""}`} />
              <span className="ses-main">
                {/* The id is the fallback, not the headline: an unnamed session
                    is one nobody has asked anything yet. */}
                <b>{s.title?.trim() || "Untitled session"}</b>
                <em>
                  {when(s.created_at)}
                  {s.events ? ` · ${s.events} events` : ""}
                  {s.live ? " · live" : ""}
                </em>
              </span>
              {s.id === current && <IconCheck size={14} />}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
