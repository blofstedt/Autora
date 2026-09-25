import { useEffect, useState, type ReactNode } from "react";
import { AutoraMark } from "./AutoraMark";
import {
  IconBrain, IconChart, IconClock, IconFolder, IconList, IconMessage,
  IconMonitor, IconPalette, IconPlug, IconPlus, IconServer, IconSliders,
  IconX, IconCheck,
} from "./Icons";
import { FONTS, THEMES, type Appearance } from "../lib/theme";
import { chooseVoice, fetchSpeechStatus, type SpeechStatus } from "../lib/voice";

export type PageId =
  | "chat" | "config" | "sessions" | "artifacts" | "analytics"
  | "cron" | "mind" | "mcp" | "system";

/** The sidebar, in Hermes' order, less the pages Autora has nothing behind. */
export const PAGES: { id: PageId; label: string; icon: ReactNode }[] = [
  { id: "chat", label: "Chat", icon: <IconMessage size={16} /> },
  { id: "config", label: "Config", icon: <IconSliders size={16} /> },
  { id: "sessions", label: "Sessions", icon: <IconList size={16} /> },
  { id: "artifacts", label: "Artifacts", icon: <IconFolder size={16} /> },
  { id: "analytics", label: "Analytics", icon: <IconChart size={16} /> },
  { id: "cron", label: "Cron", icon: <IconClock size={16} /> },
  { id: "mind", label: "Mind", icon: <IconBrain size={16} /> },
  { id: "mcp", label: "MCP", icon: <IconPlug size={16} /> },
  { id: "system", label: "System", icon: <IconServer size={16} /> },
];

export const pageLabel = (id: PageId) => PAGES.find((p) => p.id === id)?.label ?? "Chat";

/**
 * The sidebar: every page of the app, then Themes, for how the app looks.
 *
 * On a desktop it sits in the margin. On a phone the same component opens as
 * a drawer from the menu button, so there is one list of places to go, not
 * two that drift apart.
 */
export function Rail({
  page, onNavigate, relayOn, alert, onNew,
  appearance, onAppearance, drawer = false, onClose,
}: {
  page: PageId;
  onNavigate: (page: PageId) => void;
  relayOn: boolean;
  /** Something in the chat is waiting on you. */
  alert: boolean;
  onNew: () => void;
  appearance: Appearance;
  onAppearance: (next: Appearance) => void;
  drawer?: boolean;
  onClose?: () => void;
}) {
  const [menu, setMenu] = useState(false);

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
          <button
            className={`rail-nav-item ${menu ? "on" : ""}`}
            onClick={() => setMenu((m) => !m)}
            aria-expanded={menu}
          >
            <IconPalette size={16} />
            <span>Themes &amp; voice</span>
            {relayOn && (
              <em className="rail-relay" title="A desktop relay is connected">
                <IconMonitor size={12} />
              </em>
            )}
          </button>
        </nav>
        {menu && (
          <ThemesMenu
            appearance={appearance}
            onAppearance={onAppearance}
            onClose={() => setMenu(false)}
          />
        )}
      </div>

    </aside>
  );
}

/** Theme and font, opened in place under the Themes item. It unfolds inside
    the list rather than floating over it, so the scrolling rail cannot clip it. */
function ThemesMenu({
  appearance, onAppearance, onClose,
}: {
  appearance: Appearance;
  onAppearance: (next: Appearance) => void;
  onClose: () => void;
}) {
  /* Which voice the console has, asked for when the panel opens rather than
     with the page: this is the only thing that wants it, and an install with
     no voice server should not pay for a question nobody is asking. */
  const [speech, setSpeech] = useState<SpeechStatus | null>(null);
  const [complaint, setComplaint] = useState<string | null>(null);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);

  useEffect(() => {
    let alive = true;
    void fetchSpeechStatus().then((status) => { if (alive) setSpeech(status); });
    return () => { alive = false; };
  }, []);

  const pickVoice = (voice: string) => {
    if (!speech) return;
    setSpeech({ ...speech, voice });
    setComplaint(null);
    void chooseVoice(voice).then((result) => {
      if (!result.ok) setComplaint(result.detail ?? "That voice could not be saved.");
    });
  };

  return (
    <div className="settings-menu">
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

      {/* The console's own voice, when it has one. The list comes from the
          voice server itself, so it is whatever that server offers rather
          than a list hardcoded here that would go stale. */}
      <div className="sm-head">Voice</div>
      {speech?.available ? (
        <>
          <select
            className="sm-voice"
            aria-label="The voice the console speaks in"
            value={speech.voice}
            onChange={(e) => pickVoice(e.target.value)}
          >
            {speech.voices.map((v) => (
              <option key={v.id} value={v.id}>{v.label}</option>
            ))}
          </select>
          <div className="sm-note">
            {complaint ?? "Every reply read aloud uses this voice, on every device."}
          </div>
        </>
      ) : (
        <div className="sm-note">
          {speech?.reason ?? "No voice server is set, so the browser's own voice is used."}
        </div>
      )}

    </div>
  );
}
