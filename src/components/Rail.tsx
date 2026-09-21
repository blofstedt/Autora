import type { SessionRow } from "./Sessions";
import { IconGear, IconMonitor, IconPlus, IconRepeat, IconSpark } from "./Icons";

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
 * The sidebar a desktop screen has room for.
 *
 * On a phone this app is one column and everything else is a sheet over it,
 * which is right there and wrong on a 27-inch monitor: the sheet covers the
 * conversation to show a list that would fit in the margin. So on a wide
 * screen the margin gets the list, the conversation keeps the middle, and
 * nothing has to be covered up to switch sessions.
 */
export function Rail({
  sessions, current, relayOn, onPick, onNew, onTasks, onSkills, onMemory, onSettings,
}: {
  sessions: SessionRow[];
  current: string | null;
  relayOn: boolean;
  onPick: (id: string) => void;
  onNew: () => void;
  onTasks: () => void;
  onSkills?: () => void;
  onMemory: () => void;
  onSettings: () => void;
}) {
  return (
    <aside className="rail" aria-label="Sessions">
      <div className="rail-top">
        <span className="brand-mark"><IconSpark size={13} /></span>
        <span className="brand-word">Autora</span>
      </div>

      <button className="btn rail-new" onClick={onNew}>
        <IconPlus size={13} /> New session
      </button>

      <div className="rail-list">
        {sessions.length === 0 && <p className="rail-empty">No sessions yet.</p>}
        {sessions.map((s) => (
          <button
            key={s.id}
            className={`rail-row ${s.id === current ? "on" : ""}`}
            onClick={() => onPick(s.id)}
            aria-current={s.id === current}
          >
            <span className={`ses-dot ${s.live ? "is-live" : ""}`} />
            <span className="rail-row-main">
              <b>{s.title?.trim() || "Untitled session"}</b>
              <em>
                {when(s.created_at)}
                {s.events ? ` · ${s.events} events` : ""}
              </em>
            </span>
          </button>
        ))}
      </div>

      <div className="rail-foot">
        <button className="rail-act" onClick={onTasks}>
          <IconRepeat size={14} /> Tasks
        </button>
        <button className="rail-act" onClick={onSkills || onMemory}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#a855f7", display: "inline-block", boxShadow: "0 0 6px #a855f7" }} /> Skills
        </button>
        <button className="rail-act" onClick={onMemory}>
          <IconSpark size={14} /> Memory
        </button>
        <button className="rail-act" onClick={onSettings}>
          <IconGear size={14} /> Settings
          {/* The relay is invisible until something uses it, so its one
              reliable sign of life belongs somewhere always on screen. */}
          {relayOn && (
            <em className="rail-relay" title="A desktop relay is connected">
              <IconMonitor size={11} />
            </em>
          )}
        </button>
      </div>
    </aside>
  );
}
