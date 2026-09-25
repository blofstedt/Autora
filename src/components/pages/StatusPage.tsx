import { useEffect, useState } from "react";
import type { SessionRow } from "../Sessions";
import type { PageId } from "../Rail";
import { duration } from "../Settings";
import type { SystemTab } from "./SystemPage";

type Snapshot = {
  system: { version: string; uptime_s: number; sessions: number; busy: number; browsers: number } | null;
  settings: {
    active: { model: string | null; provider: string | null; hint: string | null };
    tools: { groups: { group: string; label: string; enabled: boolean; available: boolean; detail: string }[] };
    jev?: { enabled: boolean; support: { state: string; reason?: string }; last: { task: string; mode: string; ms: number } | null };
  } | null;
  usage: { month: { cost: number; turns: number }; today: { cost: number; turns: number } } | null;
  mcp: { servers: { name: string; status: string; tools: unknown[] }[] } | null;
  errors: number;
  health: {
    /** The tool, and the site or command it was aimed at. */
    tool: string; target: string; label: string;
    calls: number; failures: number; lastError: string | null; lastTs: number;
  }[];
  custom: { name: string; description: string; runs: number; failures: number; updated: number }[];
};

type Storage = {
  sessions: { count: number; bytes: number };
  artifacts: { count: number; bytes: number };
  settings: { count: number; bytes: number };
  total: number;
  policy: { sessionDays: number; keepSessions: number; artifactDays: number; keepArtifacts: number };
};

const money = (n: number) => `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}`;

/** Bytes as something readable. Megabytes are what this page is about, so
    kilobytes only matter on a fresh install. */
function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Status: the installation at a glance. Everything on it is live data from
 * the server, refreshed every few seconds; each card links to the page where
 * that thing is managed.
 */
export function StatusPage({
  sessions, onOpenSession, onNavigate, onTab,
}: {
  sessions: SessionRow[];
  onOpenSession: (id: string) => void;
  onNavigate: (page: PageId) => void;
  /** Another section of the System page. */
  onTab: (tab: SystemTab) => void;
}) {
  const [snap, setSnap] = useState<Snapshot>({
    system: null, settings: null, usage: null, mcp: null, errors: 0, health: [], custom: [],
  });
  const [storage, setStorage] = useState<Storage | null>(null);
  const [pruning, setPruning] = useState(false);

  useEffect(() => {
    let alive = true;
    const get = (url: string) => fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const load = async () => {
      const [system, settings, usage, mcp, logs, health, custom, disk] = await Promise.all([
        get("/api/system"), get("/api/settings"), get("/api/usage"), get("/api/mcp"),
        get("/api/logs?level=error&limit=200"), get("/api/tools/health"), get("/api/custom-tools"),
        get("/api/storage"),
      ]);
      if (alive) {
        setSnap({
          system, settings, usage, mcp, errors: logs?.lines?.length ?? 0,
          health: health?.health ?? [], custom: custom?.tools ?? [],
        });
        if (disk?.storage) setStorage(disk.storage as Storage);
      }
    };
    void load();
    const timer = window.setInterval(load, 5000);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);

  const groups = snap.settings?.tools.groups ?? [];
  const ready = groups.filter((g) => g.available).length;
  const servers = snap.mcp?.servers ?? [];
  const connected = servers.filter((s) => s.status === "connected");
  const mcpTools = connected.reduce((n, s) => n + s.tools.length, 0);
  const jev = snap.settings?.jev;

  return (
    <div className="page-scroll">
      <div className="page-inner">
        <div className="stat-grid">
          <button className="stat-card" onClick={() => onTab("host")}>
            <span className="stat-label">Autora</span>
            <b className="stat-value">{snap.system ? `v${snap.system.version}` : "…"}</b>
            <span className="stat-sub">{snap.system ? `up ${duration(snap.system.uptime_s)}` : ""}</span>
          </button>
          <button className="stat-card" onClick={() => onNavigate("config")}>
            <span className="stat-label">Model</span>
            <b className="stat-value">{snap.settings?.active.model ?? "none"}</b>
            <span className={`stat-sub ${snap.settings?.active.model ? "" : "is-warn"}`}>
              {snap.settings?.active.provider ?? snap.settings?.active.hint ?? ""}
            </span>
          </button>
          <button className="stat-card" onClick={() => onNavigate("sessions")}>
            <span className="stat-label">Sessions</span>
            <b className="stat-value">{snap.system?.sessions ?? "…"}</b>
            <span className={`stat-sub ${snap.system?.busy ? "is-live" : ""}`}>
              {snap.system ? `${snap.system.busy} working · ${snap.system.browsers} browser${snap.system.browsers === 1 ? "" : "s"} open` : ""}
            </span>
          </button>
          <button className="stat-card" onClick={() => onNavigate("analytics")}>
            <span className="stat-label">Spend this month</span>
            <b className="stat-value">{snap.usage ? money(snap.usage.month.cost) : "…"}</b>
            <span className="stat-sub">{snap.usage ? `${money(snap.usage.today.cost)} today · ${snap.usage.month.turns} calls` : ""}</span>
          </button>
          <button className="stat-card" onClick={() => onNavigate("config")}>
            <span className="stat-label">Tools</span>
            <b className="stat-value">{groups.length ? `${ready} of ${groups.length}` : "…"}</b>
            <span className="stat-sub">{groups.filter((g) => g.available).map((g) => g.label).join(" · ") || "none ready"}</span>
          </button>
          <button className="stat-card" onClick={() => onNavigate("mcp")}>
            <span className="stat-label">MCP</span>
            <b className="stat-value">{servers.length ? `${connected.length} of ${servers.length}` : "none"}</b>
            <span className={`stat-sub ${servers.length > connected.length ? "is-warn" : ""}`}>
              {servers.length ? `${mcpTools} tool${mcpTools === 1 ? "" : "s"} offered` : "no servers added"}
            </span>
          </button>
          <button className="stat-card" onClick={() => onNavigate("config")}>
            <span className="stat-label">Jev Mode</span>
            <b className="stat-value">
              {!jev ? "…" : !jev.enabled ? "off" : jev.support.state === "no" ? "not supported" : jev.support.state === "yes" ? "active" : "ready"}
            </b>
            <span className="stat-sub">
              {jev?.last ? `last: ${jev.last.task}, ${jev.last.mode === "jev" ? `${jev.last.ms} ms` : "fell back"}` : jev?.support.reason ?? ""}
            </span>
          </button>
          <button className="stat-card" onClick={() => onTab("logs")}>
            <span className="stat-label">Errors</span>
            <b className={`stat-value ${snap.errors ? "is-bad" : ""}`}>{snap.errors}</b>
            <span className="stat-sub">in the log since start</span>
          </button>
        </div>

        <section className="set-card">
          <h3>How the tools have been going</h3>
          <p className="jf-hint">
            The last week of calls. Tools failing often are named to the agent at the start of
            each turn, so it does not walk into the same wall again.
          </p>
          {snap.health.length === 0 && <p className="jf-hint">No tool calls yet.</p>}
          <div className="health-rows">
            {snap.health.map((h) => {
              const share = h.calls ? h.failures / h.calls : 0;
              return (
                <div key={h.label ?? h.tool} className={`health-row ${share >= 0.4 && h.calls >= 3 ? "is-bad" : share > 0 ? "is-warn" : ""}`}>
                  <code>{h.label ?? h.tool}</code>
                  <span className="health-bar" aria-hidden="true"><i style={{ width: `${Math.round((1 - share) * 100)}%` }} /></span>
                  <span className="health-count">{h.calls - h.failures}/{h.calls} ok</span>
                  {h.lastError && <em title={h.lastError}>{h.lastError}</em>}
                </div>
              );
            })}
          </div>
        </section>

        <section className="set-card">
          <h3>Tools Autora wrote</h3>
          <p className="jf-hint">
            Scripts the agent saved with tool_create for work it does again. It is offered each one
            as my_&lt;name&gt; while the terminal is on.
          </p>
          {snap.custom.length === 0 && <p className="jf-hint">None yet.</p>}
          {snap.custom.map((t) => (
            <div key={t.name} className="health-row">
              <code>my_{t.name}</code>
              <span className="custom-desc">{t.description}</span>
              <span className="health-count">{t.runs} run{t.runs === 1 ? "" : "s"}{t.failures ? `, ${t.failures} failed` : ""}</span>
              <button
                type="button"
                className="btn tiny ghost"
                onClick={() => {
                  if (!window.confirm(`Delete my_${t.name}?`)) return;
                  void fetch(`/api/custom-tools/${encodeURIComponent(t.name)}`, { method: "DELETE" })
                    .then(() => setSnap((s) => ({ ...s, custom: s.custom.filter((c) => c.name !== t.name) })));
                }}
              >
                Delete
              </button>
            </div>
          ))}
        </section>

        <section className="set-card">
          <h3>Stored on disk</h3>
          <p className="jf-hint">
            Sessions and their logs, the Artifacts page, and the settings file, in the directory
            Umbrel keeps across an update. Housekeeping runs on every start and twice a day:
            {" "}
            {storage
              ? `sessions older than ${storage.policy.sessionDays || "no"} ${storage.policy.sessionDays ? "days" : "age limit"}, ` +
                `artifacts older than ${storage.policy.artifactDays || "no"} ${storage.policy.artifactDays ? "days" : "age limit"}, ` +
                `always keeping the newest ${storage.policy.keepSessions} and ${storage.policy.keepArtifacts}.`
              : "reading the policy…"}
          </p>
          {storage && (
            <div className="health-rows">
              <div className="health-row">
                <code>sessions</code>
                <span className="health-count">{storage.sessions.count} kept</span>
                <span className="health-count">{size(storage.sessions.bytes)}</span>
              </div>
              <div className="health-row">
                <code>artifacts</code>
                <span className="health-count">{storage.artifacts.count} files</span>
                <span className="health-count">{size(storage.artifacts.bytes)}</span>
              </div>
              <div className="health-row">
                <code>settings &amp; memory</code>
                <span className="health-count">{size(storage.settings.bytes)}</span>
              </div>
              <div className="health-row">
                <code>total</code>
                <span className="health-count">{size(storage.total)}</span>
              </div>
            </div>
          )}
          <div className="row-actions">
            <button
              type="button"
              className="btn tiny ghost"
              disabled={pruning}
              onClick={() => {
                if (!window.confirm(
                  "Delete every session and artifact past the limits above? Pinned sessions are kept.",
                )) return;
                setPruning(true);
                void fetch("/api/storage/prune", { method: "POST" })
                  .then((r) => r.json())
                  .then((body) => {
                    if (body?.storage) setStorage(body.storage as Storage);
                  })
                  .finally(() => setPruning(false));
              }}
            >
              {pruning ? "Housekeeping…" : "Apply the limits now"}
            </button>
            <span className="set-note">
              Nothing else is deleted: the newest ones, anything pinned, and anything running now.
            </span>
          </div>
        </section>

        <section className="set-card">
          <h3>Recent sessions</h3>
          {sessions.length === 0 && <p className="jf-hint">No sessions yet.</p>}
          <div className="status-sessions">
            {sessions.slice(0, 6).map((s) => (
              <button key={s.id} className="ses-row" onClick={() => onOpenSession(s.id)}>
                <span className={`ses-dot ${s.live ? "is-live" : ""}`} />
                <span className="ses-main">
                  <b>{s.title || "Untitled session"}</b>
                  <em>{s.events ?? 0} events</em>
                </span>
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
