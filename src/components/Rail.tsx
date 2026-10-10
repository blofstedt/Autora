import { useEffect, useState, type ReactNode } from "react";
import { AutoraMark, type MarkState } from "./AutoraMark";
import {
  IconBrain, IconChart, IconClock, IconFolder, IconList, IconMask, IconMenu, IconMessage,
  IconMonitor, IconNotebook, IconOrg, IconPlug, IconThreads, IconPlus, IconServer, IconSliders, IconWrench, IconZap,
  IconX, IconCheck, IconChevron,
} from "./Icons";
import {
  COLUMNS, FONTS, ICON_SIZES, TEXT_SIZES, THEMES,
  type Appearance,
} from "../lib/theme";
import { DockPicker } from "./DockPicker";
import { ago, until } from "../lib/ago";
import type { Job } from "./Schedule";
import type { ContextGauge } from "../lib/derive";
import type { Noticed } from "../lib/proactive";
import {
  BUCKETS, announceChange, confirmRecord, deleteRecord, fetchKnowledge, onKnowledgeChange,
  type Bucket, type MemoryRecord,
} from "../lib/memory";
import { every, usePoll } from "../lib/poll";

export type PageId =
  | "chat" | "config" | "sessions" | "artifacts" | "notebooks" | "analytics"
  | "cron" | "triggers" | "mind" | "organization" | "threads" | "tools" | "mcp" | "system";

/** The sidebar. Ids stay as they were, so old links (?page=cron) still land;
    the labels are what people call these things rather than how they are
    built. The first group is where work happens, the second is setup. */
export const PAGES: { id: PageId; label: string; icon: ReactNode; group: "work" | "setup" }[] = [
  { id: "chat", label: "Chat", icon: <IconMessage size={16} />, group: "work" },
  { id: "sessions", label: "Sessions", icon: <IconList size={16} />, group: "work" },
  { id: "artifacts", label: "Artifacts", icon: <IconFolder size={16} />, group: "work" },
  { id: "notebooks", label: "Notebooks", icon: <IconNotebook size={16} />, group: "work" },
  { id: "cron", label: "Schedules", icon: <IconClock size={16} />, group: "work" },
  { id: "triggers", label: "Triggers", icon: <IconZap size={16} />, group: "work" },
  { id: "mind", label: "Mind", icon: <IconBrain size={16} />, group: "work" },
  { id: "organization", label: "Organization", icon: <IconOrg size={16} />, group: "work" },
  { id: "threads", label: "Threads", icon: <IconThreads size={16} />, group: "work" },
  { id: "tools", label: "Tools", icon: <IconWrench size={16} />, group: "setup" },
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
  page, onNavigate, onOpenSession, onOpenMemory, context, relayOn, alert, onNew, onIncognito,
  onStartTask, drawer = false, onClose, onFold, mini = false, onMini,
  mood = "rest", attention = 0, pulse = 0, learned = 0, bloom = 0, mindGlow = false,
}: {
  page: PageId;
  onNavigate: (page: PageId) => void;
  onOpenSession: (id: string) => void;
  /** Open one memory in the Mind. */
  onOpenMemory: (id: string, kind: Bucket) => void;
  /** How full the open session's context is; null before its first reply. */
  context: ContextGauge | null;
  relayOn: boolean;
  /** Something in the chat is waiting on you. */
  alert: boolean;
  onNew: () => void;
  /** A chat that is never written down, beside the new one. */
  onIncognito: () => void;
  /** Look into something noticed, in a new chat named after it. */
  onStartTask?: (text: string, title?: string) => void;
  drawer?: boolean;
  onClose?: () => void;
  /** Fold the menu away to the far left (a desktop only). */
  onFold?: () => void;
  /** Folded to a strip of icons (a desktop only), and the way to fold it there and back. */
  mini?: boolean;
  onMini?: (mini: boolean) => void;
  /** The agent's presence: what the mark at the top is doing. */
  mood?: MarkState;
  attention?: number;
  pulse?: number;
  /** Memories kept since the Mind was last opened, shown as +N on it. */
  learned?: number;
  /** Counts what has landed in the Mind; used only to key the item, so a new
      landing replays the animation. */
  bloom?: number;
  /** Whether that lighting-up is happening right now. Kept apart from the
      count, so re-mounting the rail (a drawer opening) cannot replay an
      animation that finished long ago. */
  mindGlow?: boolean;
}) {
  const item = (p: (typeof PAGES)[number]) => (
    <button
      // Re-keyed on each landing so the bloom animation plays again.
      key={p.id === "mind" ? `mind-${bloom}` : p.id}
      data-page={p.id}
      className={`rail-nav-item ${page === p.id ? "on" : ""} ${p.id === "mind" && mindGlow ? "is-bloom" : ""}`}
      onClick={() => onNavigate(p.id)}
      aria-current={page === p.id ? "page" : undefined}
      title={mini ? p.label : undefined}
      aria-label={mini ? p.label : undefined}
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
    <aside className={`rail ${drawer ? "is-drawer" : ""}${mini && !drawer ? " is-mini" : ""}`} aria-label="Navigation">
      <div className="rail-top">
        <span className="rail-brand presence">
          <AutoraMark size={30} state={mood} idle attention={attention} pulse={pulse} />
        </span>
        <span className="brand-word">Autora</span>
        <div className="spacer" />
        <button
          className="rail-icon-btn"
          onClick={onIncognito}
          title="Incognito chat — nothing is saved"
          aria-label="New incognito chat"
        >
          <IconMask size={15} />
        </button>
        <button className="rail-icon-btn" onClick={onNew} title="New session" aria-label="New session">
          <IconPlus size={15} />
        </button>
        {!drawer && onMini && (
          <button
            className="rail-icon-btn rail-mini-btn"
            onClick={() => onMini(!mini)}
            title={mini ? "Show the whole menu" : "Fold the menu to icons"}
            aria-label={mini ? "Show the whole menu" : "Fold the menu to icons"}
          >
            <IconChevron size={13} className={mini ? "rail-chev-right" : "rail-chev-left"} />
          </button>
        )}
        {!drawer && onFold && (
          <button className="rail-icon-btn" onClick={onFold} title="Fold the menu away" aria-label="Fold the menu away">
            <IconMenu size={15} />
          </button>
        )}
        {drawer && (
          <button className="rail-icon-btn" onClick={onClose} aria-label="Close menu">
            <IconX size={15} />
          </button>
        )}
      </div>

      {/* The pages at the top; at the foot, how full this session's context
          is and what is running without you. */}
      <div className="rail-scroll">
        <nav className="rail-nav">
          {PAGES.filter((p) => p.group === "work").map(item)}
          <div className="rail-divider" role="separator" />
          {PAGES.filter((p) => p.group === "setup").map(item)}
        </nav>
        {mini && !drawer ? (
          <ContextBar gauge={context} />
        ) : (
          <div className="rail-foot">
            <ContextCard gauge={context} />
            <MemoryCard onOpen={onOpenMemory} />
            <Vitals onOpen={() => onNavigate("system")} />
            <Activity onOpenSession={onOpenSession} onNavigate={onNavigate} onStartTask={onStartTask} />
          </div>
        )}
      </div>
    </aside>
  );
}

/** 38200 -> "38k", 1250000 -> "1.3M". */
function short(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(Math.round(n));
}

/**
 * How full the open session's context is, as a ring.
 *
 * Autora never runs out of context: past the mark (75% by default) it
 * condenses older turns into working memory in the background. So the ring
 * shows that mark as a tick, turns amber once it is passed, and says how many
 * times the session has been condensed, which is when detail from early on
 * starts to be kept as notes rather than word for word.
 */
function ContextCard({ gauge }: { gauge: ContextGauge | null }) {
  const R = 20;
  const C = 2 * Math.PI * R;
  const share = gauge ? Math.min(1, gauge.used / gauge.limit) : 0;
  const mark = gauge?.compactAt ?? 0.75;
  const over = share >= mark;
  /* Whether the window is the model's own or this app's assumption, and where
     a set one came from. A gauge showing "12k of 100k" for a model that holds a
     million was the app reading a tenth of the truth and keeping quiet about
     it; saying "assumed" is the same number told honestly. */
  const assumed = gauge?.windowFrom === "default";
  const windowNote =
    gauge?.windowFrom === "model"
      ? "this model's own window"
      : gauge?.windowFrom === "vendor"
        ? "the window this vendor serves"
        : gauge?.windowFrom === "setting"
          ? "set by AUTORA_CONTEXT_TOKENS"
          : "no window published for this model, so an assumed one is in use";
  const pct = Math.round(share * 100);
  /* The condensing mark, as a short lighter stretch of the ring itself. It
     was a radial dash, and at 75% that is a horizontal line at nine o'clock,
     right beside the number: "3%" read as "-3%". */
  const TICK = 0.03;

  return (
    <section
      className={`rail-ctx ${over ? "is-over" : ""}`}
      aria-label={gauge ? `Context ${pct}% full` : "Context empty"}
      title={gauge
        ? `Context ${pct}% full — ${short(gauge.used)} of ${short(gauge.limit)} tokens${assumed ? " (assumed)" : ""}; ${gauge.condensed > 0 ? `condensed ${gauge.condensed}×, keeps going` : `condenses at ${Math.round(mark * 100)}%`}`
        : "Context empty — fills as this session talks"}
    >
      <svg className="rail-ctx-ring" viewBox="0 0 48 48" width="48" height="48" aria-hidden="true">
        <circle className="rail-ctx-track" cx="24" cy="24" r={R} />
        <circle
          className="rail-ctx-tick"
          cx="24" cy="24" r={R}
          strokeDasharray={`${TICK * C} ${C}`}
          transform={`rotate(${-90 + (mark - TICK / 2) * 360} 24 24)`}
        />
        {share > 0 && (
          <circle
            className="rail-ctx-fill"
            cx="24" cy="24" r={R}
            strokeDasharray={`${Math.max(share * C, 1.5)} ${C}`}
            transform="rotate(-90 24 24)"
          />
        )}
        <text x="24" y="24" className="rail-ctx-pct">{pct}%</text>
      </svg>
      <div className="rail-ctx-text">
        <span className="rail-ctx-head">Context</span>
        {gauge ? (
          <>
            <span className="rail-ctx-line" title={`${short(gauge.limit)} tokens — ${windowNote}`}>
              {short(gauge.used)} of {short(gauge.limit)} tokens{assumed ? " (assumed)" : ""}
            </span>
            <span className="rail-ctx-sub">
              {gauge.condensed > 0
                ? `condensed ${gauge.condensed}× · keeps going`
                : over
                  ? "condensing older turns"
                  : `condenses at ${Math.round(mark * 100)}%`}
            </span>
          </>
        ) : (
          <>
            <span className="rail-ctx-line">Empty</span>
            <span className="rail-ctx-sub">fills as this session talks</span>
          </>
        )}
      </div>
    </section>
  );
}

/**
 * The same gauge when the menu is folded to icons: one vertical bar that runs from the foot of the strip up to just
 * under the last icon, filling from the bottom, with the condensing mark as a short lighter stretch of it.
 */
function ContextBar({ gauge }: { gauge: ContextGauge | null }) {
  const share = gauge ? Math.min(1, gauge.used / gauge.limit) : 0;
  const mark = gauge?.compactAt ?? 0.75;
  const pct = Math.round(share * 100);
  const title = gauge
    ? `Context ${pct}% full — ${short(gauge.used)} of ${short(gauge.limit)} tokens${gauge.windowFrom === "default" ? " (assumed)" : ""}; condenses at ${Math.round(mark * 100)}%`
    : "Context empty — fills as this session talks";
  return (
    <div className={`rail-ctxbar ${share >= mark ? "is-over" : ""}`} role="img" aria-label={title} title={title}>
      <span className="rail-ctxbar-pct">{pct}%</span>
      <span className="rail-ctxbar-track">
        <i className="rail-ctxbar-fill" style={{ height: `${Math.max(share > 0 ? 2 : 0, share * 100)}%` }} />
        <i className="rail-ctxbar-tick" style={{ bottom: `${mark * 100}%` }} />
      </span>
    </div>
  );
}

/** How long one memory stays up before another takes its place. */
const MEMORY_ROTATE_MS = 45_000;

/** One of the list, preferring anything but `not`. */
function pickOne(list: MemoryRecord[], not: string | null): MemoryRecord | null {
  const others = list.length > 1 ? list.filter((r) => r.id !== not) : list;
  return others[Math.floor(Math.random() * others.length)] ?? null;
}

/**
 * Something it remembers, one at a time.
 *
 * Learned memories that nobody has kept yet come first, with Keep and Discard
 * right on the card: confirming is how a guess becomes something it knows,
 * and until now only the Mind page asked. Once everything is kept, a
 * random memory rotates through instead, as a reminder of what it knows.
 */
function MemoryCard({ onOpen }: { onOpen: (id: string, kind: Bucket) => void }) {
  const [records, setRecords] = useState<MemoryRecord[]>([]);
  const [shownId, setShownId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () => {
      if (document.hidden) return;
      fetchKnowledge()
        .then((k) => { if (alive) setRecords(k.records.filter((r) => !r.superseded_by)); })
        .catch(() => undefined);
    };
    load();
    const off = onKnowledgeChange(load);
    const stop = every(load, 60_000);
    return () => { alive = false; off(); stop(); };
  }, []);

  const unconfirmed = records.filter((r) => r.status === "provisional");
  const pool = unconfirmed.length ? unconfirmed : records;
  const shown = pool.find((r) => r.id === shownId) ?? null;

  // Something to show when there is nothing on the card, or when what was
  // shown has been kept, discarded or rewritten.
  useEffect(() => {
    if (!shown && pool.length) setShownId(pickOne(pool, null)?.id ?? null);
  }, [shown, pool]);

  // Rotate while nothing is waiting on an answer.
  useEffect(() => {
    if (unconfirmed.length || records.length < 2) return;
    const timer = window.setInterval(
      () => setShownId((id) => pickOne(records, id)?.id ?? null),
      MEMORY_ROTATE_MS,
    );
    return () => window.clearInterval(timer);
  }, [unconfirmed.length, records]);

  if (!shown) return null;
  const provisional = shown.status === "provisional";
  const bucket = BUCKETS.find((b) => b.kind === shown.kind)?.label.replace(/s$/, "").toLowerCase();

  const answer = async (work: (id: string) => Promise<unknown>) => {
    setBusy(true);
    try {
      await work(shown.id);
      announceChange();
    } catch {
      /* it stays on the card; the Mind page says what went wrong */
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={`rail-mem ${provisional ? "is-new" : ""}`} aria-label="Something it remembers">
      <button className="rail-mem-body" onClick={() => onOpen(shown.id, shown.kind)} title="Open in Mind">
        <span className="rail-mem-head">
          <IconBrain size={12} />
          {provisional ? "Learned" : "I remember"} · {bucket} · {ago(shown.created)}
        </span>
        <span className="rail-mem-title">{shown.title}</span>
      </button>
      {provisional && (
        <div className="rail-mem-ask">
          <span>Is this right?</span>
          <div className="spacer" />
          <button className="btn tiny" disabled={busy} onClick={() => void answer(confirmRecord)}>
            <IconCheck size={11} /> Keep
          </button>
          <button className="btn tiny ghost" disabled={busy} onClick={() => void answer(deleteRecord)}>
            Discard
          </button>
        </div>
      )}
    </section>
  );
}

type HostVitals = {
  cpu: number;
  cores: number;
  memory: { used: number; total: number };
  disk: { used: number; total: number } | null;
};

const GB = 1024 ** 3;
const gb = (n: number) => (n >= 100 * GB ? Math.round(n / GB) : Math.round((n / GB) * 10) / 10);

/**
 * The machine it runs on: processor, memory and disk, as three short bars.
 * The agent runs commands and a browser there, so "is the box struggling?"
 * is worth a glance, and nothing else in the app says.
 */
function Vitals({ onOpen }: { onOpen: () => void }) {
  const v = usePoll<HostVitals>("/api/host", 15_000);
  if (!v) return null;
  const rows = [
    {
      label: "CPU", share: v.cpu, value: `${Math.round(v.cpu * 100)}%`,
      detail: `${v.cores} core${v.cores === 1 ? "" : "s"}`,
    },
    {
      label: "Memory", share: v.memory.used / v.memory.total, value: `${Math.round((v.memory.used / v.memory.total) * 100)}%`,
      // Short enough for a third of the rail: "1.2 of 15.7 GB" was cut to "1.2 of 15.7 …".
      detail: `${gb(v.memory.used)}/${gb(v.memory.total)} GB`,
    },
    ...(v.disk ? [{
      label: "Disk", share: v.disk.used / v.disk.total, value: `${Math.round((v.disk.used / v.disk.total) * 100)}%`,
      detail: `${gb(v.disk.total - v.disk.used)} GB free`,
    }] : []),
  ];
  return (
    <button className="rail-vitals" onClick={onOpen} title="Open System" aria-label="This machine">
      {rows.map((r) => (
        <span key={r.label} className={`rail-vital ${r.share >= 0.85 ? "is-high" : ""}`}>
          <span className="rail-vital-top">
            <span className="rail-vital-label">{r.label}</span>
            <span className="rail-vital-value">{r.value}</span>
          </span>
          <span className="rail-vital-bar"><i style={{ width: `${Math.max(2, Math.min(100, r.share * 100))}%` }} /></span>
          <span className="rail-vital-detail">{r.detail}</span>
        </span>
      ))}
    </button>
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
  onOpenSession, onNavigate, onStartTask,
}: {
  onOpenSession: (id: string) => void;
  onNavigate: (page: PageId) => void;
  onStartTask?: (text: string, title?: string) => void;
}) {
  const jobs = usePoll<Job[]>("/api/jobs", ACTIVITY_POLL_MS) ?? [];
  /* What it has noticed and is still true: a disk filling up, an app in a
     restart loop, a schedule that failed. One tap has it look into it, in a
     chat of its own. See server/noticer.ts. */
  const noticed = (usePoll<{ notices: Noticed[] }>("/api/proactive/notices", ACTIVITY_POLL_MS)?.notices ?? []).slice(0, 2);

  const running = jobs.filter((j) => j.running);
  const next = jobs
    .filter((j) => j.enabled && !j.running && j.next_run)
    .sort((a, b) => a.next_run! - b.next_run!)[0];
  if (!running.length && !next && !noticed.length) return null;

  return (
    <section className="rail-activity" aria-label="Running on its own">
      {onStartTask && noticed.map((n) => (
        <button
          key={n.key}
          className={`rail-act-row is-noticed is-${n.tone}`}
          onClick={() => onStartTask(n.prompt, n.title)}
          title={`${n.detail} Look into it, in a new chat.`}
        >
          <span className="notice-dot" aria-hidden="true" />
          <span className="rail-act-label">Noticed</span>
          <span className="rail-act-name">{n.title}</span>
        </button>
      ))}
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

      <h3 className="sm-font-head">Text size</h3>
      <div className="sm-fonts">
        {TEXT_SIZES.map((t) => (
          <button
            key={t.id}
            className={`sm-font ${appearance.text === t.id ? "on" : ""}`}
            onClick={() => onAppearance({ ...appearance, text: t.id })}
            aria-pressed={appearance.text === t.id}
          >
            {t.label}
          </button>
        ))}
      </div>
      <p className="jf-hint">
        Every word in the app, on this device and the others. The four steps are
        close together on purpose: past the largest, rows that have a fixed
        height start to clip rather than grow.
      </p>

      <h3 className="sm-font-head">Icon size</h3>
      <div className="sm-fonts">
        {ICON_SIZES.map((i) => (
          <button
            key={i.id}
            className={`sm-font ${appearance.icons === i.id ? "on" : ""}`}
            onClick={() => onAppearance({ ...appearance, icons: i.id })}
            aria-pressed={appearance.icons === i.id}
          >
            {i.label}
          </button>
        ))}
      </div>
      <p className="jf-hint">
        Separate from the text, so a phone can have bigger words with the icons
        left alone — the reverse on a desktop, if that reads better.
      </p>

      <h3 className="sm-font-head">Text column</h3>
      <div className="sm-fonts">
        {COLUMNS.map((c) => (
          <button
            key={c.id}
            className={`sm-font ${appearance.column === c.id ? "on" : ""}`}
            onClick={() => onAppearance({ ...appearance, column: c.id })}
            aria-pressed={appearance.column === c.id}
            title={c.hint}
          >
            {c.label}
          </button>
        ))}
      </div>
      <p className="jf-hint">{COLUMNS.find((c) => c.id === appearance.column)?.hint}.</p>

      <h3 className="sm-font-head">Corner widgets</h3>
      <p className="jf-hint">
        Desktop only, and only where the window is wide enough to hold them
        beside the words rather than over them. Each one is a small version of
        a page in the sidebar and a way through to it; the text column makes
        room for whatever is pinned.
      </p>
      <DockPicker
        dock={appearance.dock}
        onPick={(slot, id) => onAppearance({
          ...appearance,
          dock: { ...appearance.dock, [slot]: id },
        })}
      />
    </section>
  );
}
