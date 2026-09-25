import type { ReactNode } from "react";
import { AutoraMark } from "./AutoraMark";
import {
  IconBrain, IconChart, IconClock, IconFolder, IconList, IconMessage,
  IconMonitor, IconPlug, IconPlus, IconServer, IconSliders,
  IconX, IconCheck,
} from "./Icons";
import { FONTS, THEMES, type Appearance } from "../lib/theme";

export type PageId =
  | "chat" | "config" | "sessions" | "artifacts" | "analytics"
  | "cron" | "mind" | "mcp" | "system";

/** The sidebar. Ids stay as they were, so old links (?page=cron) still land;
    the labels are what people call these things rather than how they are
    built. The first group is where work happens, the second is setup. */
export const PAGES: { id: PageId; label: string; icon: ReactNode; group: "work" | "setup" }[] = [
  { id: "chat", label: "Chat", icon: <IconMessage size={16} />, group: "work" },
  { id: "sessions", label: "Sessions", icon: <IconList size={16} />, group: "work" },
  { id: "artifacts", label: "Artifacts", icon: <IconFolder size={16} />, group: "work" },
  { id: "cron", label: "Schedules", icon: <IconClock size={16} />, group: "work" },
  { id: "mind", label: "Mind", icon: <IconBrain size={16} />, group: "work" },
  { id: "config", label: "Settings", icon: <IconSliders size={16} />, group: "setup" },
  { id: "mcp", label: "Integrations", icon: <IconPlug size={16} />, group: "setup" },
  { id: "analytics", label: "Usage", icon: <IconChart size={16} />, group: "setup" },
  { id: "system", label: "System", icon: <IconServer size={16} />, group: "setup" },
];

export const pageLabel = (id: PageId) => PAGES.find((p) => p.id === id)?.label ?? "Chat";

/**
 * The sidebar: every page of the app, in two groups.
 *
 * On a desktop it sits in the margin. On a phone the same component opens as
 * a drawer from the menu button, so there is one list of places to go, not
 * two that drift apart. How the app looks is under Settings, not here.
 */
export function Rail({
  page, onNavigate, relayOn, alert, onNew, drawer = false, onClose,
}: {
  page: PageId;
  onNavigate: (page: PageId) => void;
  relayOn: boolean;
  /** Something in the chat is waiting on you. */
  alert: boolean;
  onNew: () => void;
  drawer?: boolean;
  onClose?: () => void;
}) {
  const item = (p: (typeof PAGES)[number]) => (
    <button
      key={p.id}
      className={`rail-nav-item ${page === p.id ? "on" : ""}`}
      onClick={() => onNavigate(p.id)}
      aria-current={page === p.id ? "page" : undefined}
    >
      {p.icon}
      <span>{p.label}</span>
      {/* Said in words as well as the dot: a phone has no tooltips. */}
      {p.id === "chat" && alert && <em className="rail-tag is-alert">waiting on you</em>}
      {p.id === "system" && relayOn && (
        <em className="rail-tag" title="A desktop relay is connected">
          <IconMonitor size={11} /> desktop
        </em>
      )}
    </button>
  );

  return (
    <aside className={`rail ${drawer ? "is-drawer" : ""}`} aria-label="Navigation">
      <div className="rail-top">
        <span className="rail-brand"><AutoraMark size={30} state="live" /></span>
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
          {PAGES.filter((p) => p.group === "work").map(item)}
          <div className="rail-divider" role="separator" />
          {PAGES.filter((p) => p.group === "setup").map(item)}
        </nav>
      </div>
    </aside>
  );
}

/** Theme and font. Shown in Settings, under Appearance. */
export function ThemePicker({
  appearance, onAppearance,
}: {
  appearance: Appearance;
  onAppearance: (next: Appearance) => void;
}) {
  return (
    <section className="set-card">
      <h3>Theme</h3>
      <div className="sm-themes">
        {THEMES.map((t) => (
          <button
            key={t.id}
            className={`sm-theme ${appearance.theme === t.id ? "on" : ""}`}
            onClick={() => onAppearance({ ...appearance, theme: t.id })}
            aria-pressed={appearance.theme === t.id}
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

      <h3 className="sm-font-head">Font</h3>
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
      <p className="jf-hint">Saved to the server, so every device you open Autora on matches.</p>
    </section>
  );
}
