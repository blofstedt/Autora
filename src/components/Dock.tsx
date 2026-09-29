/**
 * The corner widgets.
 *
 * Space beside the conversation that a wide window leaves empty, used for four
 * small pinned cards: each one a compact version of a page in the rail, and a
 * way through to it. The machine's vitals, what the month has cost, what is
 * running on its own, the last thing it remembered, how many files there are,
 * recent conversations, MCP health, and a few shortcuts into Settings.
 *
 * Desktop only -- on a phone there is no margin to put them in, and the same
 * information is a tap away in the menu. Which corner holds what is chosen in
 * Settings -> Appearance; nothing is pinned until you ask for it, so an
 * untouched app looks exactly as it did.
 */
import { useEffect, useState, type ReactNode } from "react";
import {
  IconBrain, IconChart, IconChevron, IconClock, IconFolder, IconKey,
  IconList, IconPalette, IconPlug, IconServer, IconSliders,
} from "./Icons";
import { DOCK_SLOTS, DOCK_WIDGETS, type DockConfig, type DockWidgetId } from "../lib/theme";
import { ago, until, type Job } from "./Schedule";
import { fetchKnowledge, type Bucket, type MemoryRecord } from "../lib/memory";
import type { PageId } from "./Rail";

/** What a widget may do: open a page, a conversation, a memory, a settings tab. */
export type DockTargets = {
  go: (page: PageId) => void;
  openSession: (id: string) => void;
  openMemory: (id: string, kind: Bucket) => void;
  settingsTab: (tab: "general" | "keys" | "appearance") => void;
};

/** Poll something, quietly: a failure leaves the card as it was. */
function usePoll<T>(url: string, ms: number): T | null {
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => {
      if (document.hidden) return;
      fetch(url)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (alive && d) setValue(d as T); })
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, ms);
    const onShow = () => { if (!document.hidden) load(); };
    document.addEventListener("visibilitychange", onShow);
    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, [url, ms]);
  return value;
}

function Head({ icon, title, onOpen }: { icon: ReactNode; title: string; onOpen: () => void }) {
  return (
    <button className="dock-head" onClick={onOpen} title={`Open ${title}`}>
      {icon}
      <span className="dock-title">{title}</span>
      <span className="dock-go"><IconChevron size={12} /></span>
    </button>
  );
}

function Bar({ share, value, label, high }: { share: number; value: string; label: string; high?: boolean }) {
  return (
    <span className="dock-row">
      <span className="dock-row-top">
        {label}
        <span className="dock-value">{value}</span>
      </span>
      <span className={`dock-bar ${high ? "is-high" : ""}`}>
        <i style={{ width: `${Math.max(2, Math.min(100, share * 100))}%` }} />
      </span>
    </span>
  );
}

/* ------------------------------------------------------------------ cards -- */

type HostVitals = {
  cpu: number; cores: number;
  memory: { used: number; total: number };
  disk: { used: number; total: number } | null;
};

const GB = 1024 ** 3;
const gb = (n: number) => (n >= 100 * GB ? Math.round(n / GB) : Math.round((n / GB) * 10) / 10);

/** The machine it runs on: processor, memory and disk. */
function SystemWidget({ t }: { t: DockTargets }) {
  const v = usePoll<HostVitals>("/api/host", 15_000);
  const rows = v ? [
    { label: "CPU", share: v.cpu, value: `${Math.round(v.cpu * 100)}%` },
    { label: "Memory", share: v.memory.used / v.memory.total, value: `${gb(v.memory.used)}/${gb(v.memory.total)} GB` },
    ...(v.disk ? [{ label: "Disk", share: v.disk.used / v.disk.total, value: `${gb(v.disk.used)}/${gb(v.disk.total)} GB` }] : []),
  ] : [];
  return (
    <section className="dock-card">
      <Head icon={<IconServer size={13} />} title="System" onOpen={() => t.go("system")} />
      {rows.length
        ? rows.map((r) => <Bar key={r.label} {...r} high={r.share >= 0.85} />)
        : <p className="dock-quiet">Reading the machine…</p>}
    </section>
  );
}

type UsagePayload = {
  today: { cost: number; turns: number };
  month: { cost: number; turns: number };
  budget?: { monthly_usd: number | null };
};

/** What this month has cost, and today's share of it. */
function UsageWidget({ t }: { t: DockTargets }) {
  const u = usePoll<UsagePayload>("/api/usage", 30_000);
  const money = (n: number) => `$${n < 10 ? n.toFixed(2) : Math.round(n).toLocaleString()}`;
  const ceiling = u?.budget?.monthly_usd ?? null;
  return (
    <section className="dock-card">
      <Head icon={<IconChart size={13} />} title="Usage" onOpen={() => t.go("analytics")} />
      {!u && <p className="dock-quiet">Adding it up…</p>}
      {u && (
        <>
          {ceiling
            ? <Bar label="This month" value={`${money(u.month.cost)} of ${money(ceiling)}`} share={u.month.cost / ceiling} high={u.month.cost / ceiling >= 0.85} />
            : <Bar label="This month" value={money(u.month.cost)} share={1} />}
          <p className="dock-line">Today <span className="dock-strong">{money(u.today.cost)}</span> · {u.today.turns.toLocaleString()} turns</p>
        </>
      )}
    </section>
  );
}

/** What is running without you, and what is due next. */
function SchedulesWidget({ t }: { t: DockTargets }) {
  const jobs = usePoll<Job[]>("/api/jobs", 20_000) ?? [];
  const running = jobs.filter((j) => j.running);
  const next = jobs
    .filter((j) => j.enabled && !j.running && j.next_run)
    .sort((a, b) => a.next_run! - b.next_run!)[0];
  return (
    <section className="dock-card">
      <Head icon={<IconClock size={13} />} title="Schedules" onOpen={() => t.go("cron")} />
      {!jobs.length && <p className="dock-quiet">Nothing set up yet.</p>}
      {running.map((j) => (
        <button key={j.id} className="dock-line" style={{ background: "none", border: 0, padding: 0, cursor: "pointer", textAlign: "left" }}
          onClick={() => (j.last_session ? t.openSession(j.last_session) : t.go("cron"))}>
          <span className="dock-strong">Running</span> · {j.name}
        </button>
      ))}
      {next && <p className="dock-line">Next in {until(next.next_run!)} · <span className="dock-strong">{next.name}</span></p>}
      {!!jobs.length && !running.length && !next && <p className="dock-quiet">{jobs.length} saved, none due.</p>}
    </section>
  );
}

/** The last thing it remembered, as a reminder of what it knows. */
function MindWidget({ t }: { t: DockTargets }) {
  const [record, setRecord] = useState<MemoryRecord | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => {
      if (document.hidden) return;
      fetchKnowledge()
        .then((k) => {
          if (!alive) return;
          const live = k.records.filter((r) => !r.superseded_by);
          setRecord(live.find((r) => r.status === "provisional") ?? live[0] ?? null);
        })
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, 60_000);
    const onShow = () => { if (!document.hidden) load(); };
    document.addEventListener("visibilitychange", onShow);
    return () => { alive = false; window.clearInterval(timer); document.removeEventListener("visibilitychange", onShow); };
  }, []);
  return (
    <section className="dock-card">
      <Head icon={<IconBrain size={13} />} title="Mind" onOpen={() => t.go("mind")} />
      {!record && <p className="dock-quiet">Nothing it has written down yet.</p>}
      {record && (
        <button
          className="dock-card-body"
          style={{ background: "none", border: 0, padding: 0, cursor: "pointer", textAlign: "left", display: "flex", flexDirection: "column", gap: 4 }}
          onClick={() => t.openMemory(record.id, record.kind)}
          title="Open in Mind"
        >
          <span className="dock-line">
            {record.status === "provisional" ? "Learned" : "I remember"} · {record.kind} · {ago(record.created)}
          </span>
          <span className="dock-line is-title">{record.title}</span>
        </button>
      )}
    </section>
  );
}

/** How much it has made and kept, and the newest of it. */
function ArtifactsWidget({ t }: { t: DockTargets }) {
  const d = usePoll<{ artifacts: { id: string; name: string; ts: number }[] }>("/api/artifacts", 30_000);
  const rows = d?.artifacts ?? [];
  const newest = [...rows].sort((a, b) => b.ts - a.ts)[0];
  return (
    <section className="dock-card">
      <Head icon={<IconFolder size={13} />} title="Artifacts" onOpen={() => t.go("artifacts")} />
      {!d && <p className="dock-quiet">Counting…</p>}
      {d && !rows.length && <p className="dock-quiet">Nothing saved yet.</p>}
      {d && !!rows.length && (
        <>
          <p className="dock-line"><span className="dock-strong">{rows.length}</span> file{rows.length === 1 ? "" : "s"} kept</p>
          {newest && <p className="dock-line is-title">{newest.name}</p>}
          {newest && <p className="dock-quiet">Newest, {ago(newest.ts / 1000)}</p>}
        </>
      )}
    </section>
  );
}

type SessionRow = { id: string; title: string; live: boolean; busy: boolean; updated_at: number; turns: number };

/** Recent conversations, and a way into the list. */
function SessionsWidget({ t }: { t: DockTargets }) {
  const rows = usePoll<SessionRow[]>("/api/sessions", 30_000) ?? [];
  const recent = [...rows].sort((a, b) => b.updated_at - a.updated_at).slice(0, 3);
  return (
    <section className="dock-card">
      <Head icon={<IconList size={13} />} title="Sessions" onOpen={() => t.go("sessions")} />
      {!rows.length && <p className="dock-quiet">No conversations yet.</p>}
      {recent.map((s) => (
        <button
          key={s.id}
          className="dock-line"
          style={{ background: "none", border: 0, padding: 0, cursor: "pointer", textAlign: "left", color: s.busy ? "var(--text)" : undefined }}
          onClick={() => t.openSession(s.id)}
          title={s.title}
        >
          {s.busy ? "● " : ""}{s.title || "Untitled"} · {ago(s.updated_at)}
        </button>
      ))}
      {rows.length > 3 && <p className="dock-quiet">{rows.length} in all.</p>}
    </section>
  );
}

type McpRow = { id: string; name: string; enabled: boolean; status: string; error: string | null };

/** The MCP servers, and whether they are answering. */
function IntegrationsWidget({ t }: { t: DockTargets }) {
  const d = usePoll<{ servers: McpRow[] }>("/api/mcp", 30_000);
  const rows = (d?.servers ?? []).filter((s) => s.enabled);
  const bad = rows.filter((s) => s.status !== "connected");
  return (
    <section className="dock-card">
      <Head icon={<IconPlug size={13} />} title="Integrations" onOpen={() => t.go("mcp")} />
      {!d && <p className="dock-quiet">Asking them…</p>}
      {d && !rows.length && <p className="dock-quiet">None set up yet.</p>}
      {d && !!rows.length && (
        <p className="dock-line">
          <span className="dock-strong">{rows.length - bad.length}</span> of {rows.length} connected
        </p>
      )}
      {bad.slice(0, 2).map((s) => (
        <p key={s.id} className="dock-line">{s.name} · <span style={{ color: "var(--text-3)" }}>{s.status}</span></p>
      ))}
    </section>
  );
}

/** Shortcuts into the settings that are worth a glance from the chat. */
function SettingsWidget({ t }: { t: DockTargets }) {
  return (
    <section className="dock-card">
      <Head icon={<IconSliders size={13} />} title="Settings" onOpen={() => t.settingsTab("general")} />
      <div className="dock-acts">
        <button className="dock-act" onClick={() => t.settingsTab("appearance")}><IconPalette size={11} /> Look</button>
        <button className="dock-act" onClick={() => t.settingsTab("keys")}><IconKey size={11} /> Keys</button>
        <button className="dock-act" onClick={() => t.settingsTab("general")}><IconSliders size={11} /> Model</button>
      </div>
    </section>
  );
}

const ICONS: Record<Exclude<DockWidgetId, "none">, ReactNode> = {
  system: <IconServer size={13} />,
  usage: <IconChart size={13} />,
  schedules: <IconClock size={13} />,
  mind: <IconBrain size={13} />,
  artifacts: <IconFolder size={13} />,
  sessions: <IconList size={13} />,
  integrations: <IconPlug size={13} />,
  settings: <IconSliders size={13} />,
};

/**
 * The four slots. Rendered inside the conversation pane, so the corners are
 * the pane's corners; the stylesheet hides the whole thing on a phone.
 */
export function Dock({ dock, targets }: { dock: DockConfig; targets: DockTargets }) {
  const filled = DOCK_SLOTS.filter((s) => dock[s.id] !== "none");
  if (!filled.length) return null;
  return (
    <div className="thread-dock" aria-label="Pinned widgets">
      {filled.map((slot) => (
        <div key={slot.id} className={`dock-slot ${slot.id}`}>
          <Widget id={dock[slot.id]} targets={targets} />
        </div>
      ))}
    </div>
  );
}

function Widget({ id, targets }: { id: DockWidgetId; targets: DockTargets }) {
  switch (id) {
    case "system": return <SystemWidget t={targets} />;
    case "usage": return <UsageWidget t={targets} />;
    case "schedules": return <SchedulesWidget t={targets} />;
    case "mind": return <MindWidget t={targets} />;
    case "artifacts": return <ArtifactsWidget t={targets} />;
    case "sessions": return <SessionsWidget t={targets} />;
    case "integrations": return <IntegrationsWidget t={targets} />;
    case "settings": return <SettingsWidget t={targets} />;
    default: return null;
  }
}

export const dockLabel = (id: DockWidgetId) => DOCK_WIDGETS.find((w) => w.id === id)?.label ?? "Empty";
export const dockIcon = (id: DockWidgetId) => (id === "none" ? null : ICONS[id]);
