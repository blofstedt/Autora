import { useEffect, useState, type ReactNode } from "react";
import { AutoraMark, type MarkState } from "./AutoraMark";
import {
  IconBrain, IconChart, IconClock, IconFolder, IconList, IconMessage,
  IconMonitor, IconPlug, IconPlus, IconServer, IconSliders,
  IconX, IconCheck,
} from "./Icons";
import { FONTS, THEMES, type Appearance } from "../lib/theme";
import { ago, until, type Job } from "./Schedule";

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
  page, onNavigate, onOpenSession, relayOn, alert, onNew, drawer = false, onClose,
  mood = "rest", attention = 0, pulse = 0, learned = 0, bloom = 0,
}: {
  page: PageId;
  onNavigate: (page: PageId) => void;
  onOpenSession: (id: string) => void;
  relayOn: boolean;
  /** Something in the chat is waiting on you. */
  alert: boolean;
  onNew: () => void;
  drawer?: boolean;
  onClose?: () => void;
  /** The agent's presence: what the mark at the top is doing. */
  mood?: MarkState;
  attention?: number;
  pulse?: number;
  /** Memories kept since the Mind was last opened, shown as +N on it. */
  learned?: number;
  /** Changes when something lands in the Mind, to light it up once. */
  bloom?: number;
}) {
  const item = (p: (typeof PAGES)[number]) => (
    <button
      // Re-keyed on each landing so the bloom animation plays again.
      key={p.id === "mind" ? `mind-${bloom}` : p.id}
      data-page={p.id}
      className={`rail-nav-item ${page === p.id ? "on" : ""} ${p.id === "mind" && bloom ? "is-bloom" : ""}`}
      onClick={() => onNavigate(p.id)}
      aria-current={page === p.id ? "page" : undefined}
    >
      {p.icon}
      <span>{p.label}</span>
      {/* Said in words as well as the dot: a phone has no tooltips. */}
      {p.id === "chat" && alert && <em className="rail-tag is-alert">waiting on you</em>}
      {p.id === "mind" && learned > 0 && page !== "mind" && <em className="rail-tag is-grew">+{learned}</em>}
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
        <span className="rail-brand presence">
          <AutoraMark size={30} state={mood} idle attention={attention} pulse={pulse} />
        </span>
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

      {/* In the drawer the list sits at the bottom, where a thumb reaches,
          and what is running without you sits just above it. In the margin
          the list stays at the top and that note settles at the foot. */}
      <div className="rail-scroll">
        {drawer && <Activity onOpenSession={onOpenSession} onNavigate={onNavigate} />}
        <nav className="rail-nav">
          {PAGES.filter((p) => p.group === "work").map(item)}
          <div className="rail-divider" role="separator" />
          {PAGES.filter((p) => p.group === "setup").map(item)}
        </nav>
        {!drawer && <Activity onOpenSession={onOpenSession} onNavigate={onNavigate} />}
      </div>
    </aside>
  );
}

/** How often the rail asks what the schedules are doing. */
const ACTIVITY_POLL_MS = 20_000;

/**
 * What is happening without you: schedules or watchers running right now, and
 * the next one due. The Schedules page has the full list; this is one glance
 * at it, and says nothing at all when nothing is set up.
 */
function Activity({
  onOpenSession, onNavigate,
}: {
  onOpenSession: (id: string) => void;
  onNavigate: (page: PageId) => void;
}) {
  const [jobs, setJobs] = useState<Job[]>([]);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      // The rail in the margin stays mounted on a phone, hidden; a tab in the
      // background has no one to show it to either.
      if (document.hidden) return;
      try {
        const res = await fetch("/api/jobs");
        if (res.ok && alive) setJobs(await res.json() as Job[]);
      } catch {
        /* the next poll will pick it up */
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), ACTIVITY_POLL_MS);
    const onVisible = () => { if (!document.hidden) void load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const running = jobs.filter((j) => j.running);
  const next = jobs
    .filter((j) => j.enabled && !j.running && j.next_run)
    .sort((a, b) => a.next_run! - b.next_run!)[0];
  if (!running.length && !next) return null;

  return (
    <section className="rail-activity" aria-label="Running on its own">
      {running.map((job) => {
        const started = job.runs?.[job.runs.length - 1]?.at ?? job.last_run;
        const session = job.last_session;
        return (
          <button
            key={job.id}
            className="rail-act-row is-running"
            onClick={() => (session ? onOpenSession(session) : onNavigate("cron"))}
            title={session ? "Open the session it is running in" : "Open Schedules"}
          >
            <span className="watch-dot" aria-hidden="true" />
            <span className="rail-act-label">Running</span>
            <span className="rail-act-name">{job.name}</span>
            {started && <span className="rail-act-when">{ago(started)}</span>}
          </button>
        );
      })}
      {next && (
        <button className="rail-act-row" onClick={() => onNavigate("cron")} title="Open Schedules">
          <IconClock size={12} />
          <span className="rail-act-label">Next</span>
          <span className="rail-act-name">{next.name}</span>
          <span className="rail-act-when">{until(next.next_run!)}</span>
        </button>
      )}
    </section>
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
