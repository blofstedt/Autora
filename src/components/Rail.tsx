import { useEffect, useRef, useState, type ReactNode } from "react";
import type { SessionRow } from "./Sessions";
import {
  IconActivity, IconBrain, IconChart, IconClock, IconGear, IconKey, IconList, IconMessage,
  IconMonitor, IconPalette, IconPlug, IconPlus, IconScroll, IconServer, IconSliders,
  IconSpark, IconX, IconCheck,
} from "./Icons";
import { FONTS, THEMES, type Appearance } from "../lib/theme";

export type PageId =
  | "status" | "chat" | "config" | "keys" | "sessions" | "logs" | "analytics"
  | "cron" | "mind" | "mcp" | "system";

/** The sidebar, in Hermes' order, less the pages Autora has nothing behind. */
export const PAGES: { id: PageId; label: string; icon: ReactNode }[] = [
  { id: "status", label: "Status", icon: <IconActivity size={16} /> },
  { id: "chat", label: "Chat", icon: <IconMessage size={16} /> },
  { id: "config", label: "Config", icon: <IconSliders size={16} /> },
  { id: "keys", label: "API Keys", icon: <IconKey size={16} /> },
  { id: "sessions", label: "Sessions", icon: <IconList size={16} /> },
  { id: "logs", label: "Logs", icon: <IconScroll size={16} /> },
  { id: "analytics", label: "Analytics", icon: <IconChart size={16} /> },
  { id: "cron", label: "Cron", icon: <IconClock size={16} /> },
  { id: "mind", label: "Mind", icon: <IconBrain size={16} /> },
  { id: "mcp", label: "MCP", icon: <IconPlug size={16} /> },
  { id: "system", label: "System", icon: <IconServer size={16} /> },
];

export const pageLabel = (id: PageId) => PAGES.find((p) => p.id === id)?.label ?? "Chat";

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
 * The sidebar: every page of the app, the sessions you were last in, and a
 * settings menu at the bottom for how the app looks.
 *
 * On a desktop it sits in the margin. On a phone the same component opens as
 * a drawer from the menu button, so there is one list of places to go, not
 * two that drift apart.
 */
export function Rail({
  page, onNavigate, sessions, current, relayOn, alert, onPick, onNew,
  appearance, onAppearance, drawer = false, onClose,
}: {
  page: PageId;
  onNavigate: (page: PageId) => void;
  sessions: SessionRow[];
  current: string | null;
  relayOn: boolean;
  /** Something in the chat is waiting on you. */
  alert: boolean;
  onPick: (id: string) => void;
  onNew: () => void;
  appearance: Appearance;
  onAppearance: (next: Appearance) => void;
  drawer?: boolean;
  onClose?: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const recent = sessions.slice(0, 8);

  return (
    <aside className={`rail ${drawer ? "is-drawer" : ""}`} aria-label="Navigation">
      <div className="rail-top">
        <span className="brand-mark"><IconSpark size={13} /></span>
        <span className="brand-word">Autora</span>
        <div className="spacer" />
        <button className="rail-icon-btn" onClick={onNew} title="New session" aria-label="New session">
          <IconPlus size={15} />
        </button>
        {drawer && (
          <button className="rail-icon-btn" onClick={onClose} aria-label="Close menu">
            <IconX size={15} />
          </button>
        )}
      </div>

      <div className="rail-scroll">
        <nav className="rail-nav">
          {PAGES.map((p) => (
            <button
              key={p.id}
              className={`rail-nav-item ${page === p.id ? "on" : ""}`}
              onClick={() => onNavigate(p.id)}
              aria-current={page === p.id ? "page" : undefined}
            >
              {p.icon}
              <span>{p.label}</span>
              {p.id === "chat" && alert && <i className="rail-alert" title="Waiting on you" />}
            </button>
          ))}
        </nav>

        {recent.length > 0 && (
          <>
            <div className="rail-section">Recent</div>
            <div className="rail-list">
              {recent.map((s) => (
                <button
                  key={s.id}
                  className={`rail-row ${s.id === current && page === "chat" ? "on" : ""}`}
                  onClick={() => onPick(s.id)}
                  aria-current={s.id === current}
                >
                  <span className={`ses-dot ${s.live ? "is-live" : ""}`} />
                  <span className="rail-row-main">
                    <b>{s.title?.trim() || "Untitled session"}</b>
                    <em>{when(s.created_at)}{s.events ? ` · ${s.events} events` : ""}</em>
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="rail-foot">
        <button
          className={`rail-settings ${menu ? "on" : ""}`}
          onClick={() => setMenu((m) => !m)}
          aria-expanded={menu}
          aria-haspopup="menu"
        >
          <IconGear size={16} />
          <span>Settings</span>
          {relayOn && (
            <em className="rail-relay" title="A desktop relay is connected">
              <IconMonitor size={12} />
            </em>
          )}
        </button>
        {menu && (
          <SettingsMenu
            appearance={appearance}
            onAppearance={onAppearance}
            onNavigate={(p) => { setMenu(false); onNavigate(p); }}
            onClose={() => setMenu(false)}
          />
        )}
      </div>
    </aside>
  );
}

/** The menu at the bottom-left: how the app looks, and the settings pages. */
function SettingsMenu({
  appearance, onAppearance, onNavigate, onClose,
}: {
  appearance: Appearance;
  onAppearance: (next: Appearance) => void;
  onNavigate: (page: PageId) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: PointerEvent) => {
      const target = e.target as Node;
      if (ref.current && !ref.current.contains(target) &&
          !(target as HTMLElement).closest?.(".rail-settings")) onClose();
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [onClose]);

  return (
    <div className="settings-menu" ref={ref} role="menu">
      <div className="sm-head"><IconPalette size={14} /> Theme</div>
      <div className="sm-themes">
        {THEMES.map((t) => (
          <button
            key={t.id}
            className={`sm-theme ${appearance.theme === t.id ? "on" : ""}`}
            onClick={() => onAppearance({ ...appearance, theme: t.id })}
            aria-pressed={appearance.theme === t.id}
            title={t.label}
          >
            <span className="sm-swatch" style={{ background: t.swatch[2] }}>
              <i style={{ background: t.swatch[0] }} />
              <i style={{ background: t.swatch[1] }} />
            </span>
            <span className="sm-theme-name">{t.label}</span>
            {appearance.theme === t.id && <IconCheck size={12} />}
          </button>
        ))}
      </div>

      <div className="sm-head">Font</div>
      <div className="sm-fonts">
        {FONTS.map((f) => (
          <button
            key={f.id}
            className={`sm-font ${appearance.font === f.id ? "on" : ""}`}
            style={{ fontFamily: f.family }}
            onClick={() => onAppearance({ ...appearance, font: f.id })}
            aria-pressed={appearance.font === f.id}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="sm-links">
        <button onClick={() => onNavigate("config")}><IconSliders size={14} /> Config</button>
        <button onClick={() => onNavigate("keys")}><IconKey size={14} /> API Keys</button>
        <button onClick={() => onNavigate("system")}><IconServer size={14} /> System</button>
      </div>
    </div>
  );
}
