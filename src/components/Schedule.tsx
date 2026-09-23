import { useCallback, useEffect, useState } from "react";
import { IconCheck, IconClock, IconPlay, IconPlus, IconRepeat, IconTrash, IconX } from "./Icons";

export type Job = {
  id: string;
  name: string;
  cron: string;
  prompt: string;
  enabled: boolean;
  created: number;
  last_run: number | null;
  last_session: string | null;
  last_error: string | null;
  next_run: number | null;
  cron_error: string | null;
};

/** Schedules worth one tap, rather than making everyone recall field order. */
const PRESETS: { label: string; cron: string }[] = [
  { label: "every hour", cron: "0 * * * *" },
  { label: "every morning", cron: "0 8 * * *" },
  { label: "every night", cron: "0 3 * * *" },
  { label: "weekday mornings", cron: "0 8 * * 1-5" },
  { label: "Monday mornings", cron: "0 8 * * 1" },
  { label: "1st of the month", cron: "0 8 1 * *" },
];

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * Cron in words, for the common shapes.
 *
 * Only the expressions the presets produce and their close relatives are
 * spelled out; anything more elaborate keeps its cron, which is what someone
 * writing `*​/7 2-5 * * *` by hand would rather see anyway than a clumsy
 * paraphrase of it.
 */
export function describeCron(cron: string): string | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, month, dow] = parts;
  if (month !== "*") return null;

  const at = (h: string, m: string) => `${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
  const numeric = (s: string) => /^\d+$/.test(s);

  if (min === "*" && hour === "*" && dom === "*" && dow === "*") return "every minute";
  if (numeric(min) && hour === "*" && dom === "*" && dow === "*") {
    return min === "0" ? "every hour, on the hour" : `every hour at :${min.padStart(2, "0")}`;
  }
  if (/^\*\/\d+$/.test(min) && hour === "*" && dom === "*" && dow === "*") {
    return `every ${min.slice(2)} minutes`;
  }
  if (!numeric(min) || !numeric(hour)) return null;

  const time = at(hour, min);
  if (dom === "*" && dow === "*") return `every day at ${time}`;
  if (dom === "*" && dow === "1-5") return `weekdays at ${time}`;
  if (dom === "*" && dow === "0,6") return `weekends at ${time}`;
  if (dom === "*" && numeric(dow)) return `every ${DAYS[Number(dow) % 7]} at ${time}`;
  if (numeric(dom) && dow === "*") return `on the ${ordinal(Number(dom))} at ${time}`;
  return null;
}

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

/** "in 4h", "in 3 days" -- a countdown answers "is this on?" faster than a date. */
function until(ts: number): string {
  const seconds = Math.round(ts - Date.now() / 1000);
  if (seconds <= 0) return "due now";
  if (seconds < 90) return `in ${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)} days`;
}

function ago(ts: number): string {
  const seconds = Math.round(Date.now() / 1000 - ts);
  if (seconds < 90) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Scheduled tasks: a prompt and a cron expression.
 *
 * Each run opens its own session, so the list here is a list of intentions --
 * what has actually happened lives in the session switcher like everything
 * else, and the newest run is one tap away from its row.
 */
export function Schedule({
  onClose, onOpenSession, embedded = false,
}: {
  onClose?: () => void;
  onOpenSession: (id: string) => void;
  /** Shown as a page rather than a full-screen sheet. */
  embedded?: boolean;
}) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [editing, setEditing] = useState<Job | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/jobs");
      setJobs(await res.json());
    } catch {
      /* the next poll will pick it up */
    } finally {
      setLoaded(true);
    }
  }, []);

  // Poll while open: next-run countdowns go stale otherwise, and a run that
  // fires while someone is looking at the list should show up in it.
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const save = useCallback(async (draft: Partial<Job>, id?: string) => {
    setError(null);
    const res = await fetch(id ? `/api/jobs/${id}` : "/api/jobs", {
      method: id ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.detail ?? "Could not save that task.");
      return false;
    }
    setEditing(null);
    await load();
    return true;
  }, [load]);

  const toggle = useCallback(async (job: Job) => {
    await fetch(`/api/jobs/${job.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !job.enabled }),
    });
    await load();
  }, [load]);

  const remove = useCallback(async (job: Job) => {
    await fetch(`/api/jobs/${job.id}`, { method: "DELETE" });
    await load();
  }, [load]);

  const runNow = useCallback(async (job: Job) => {
    setError(null);
    const res = await fetch(`/api/jobs/${job.id}/run`, { method: "POST" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(body.detail ?? "Could not start that task.");
      return;
    }
    await load();
    if (body.session) onOpenSession(body.session);
  }, [load, onOpenSession]);

  return (
    <div className={`sched ${embedded ? "is-embedded" : ""}`}>
      <div className="sched-top">
        <div className="brand">
          <span className="brand-mark"><IconRepeat size={13} /></span>
          {embedded ? "Cron" : "Scheduled tasks"}
        </div>
        <div className="spacer" />
        <button className="btn primary" onClick={() => { setError(null); setEditing("new"); }}>
          <IconPlus size={13} /> New task
        </button>
        {onClose && !embedded && (
          <button className="btn icon ghost" onClick={onClose} aria-label="Close scheduled tasks">
            <IconX size={14} />
          </button>
        )}
      </div>

      {error && <div className="sched-error">{error}</div>}

      <div className="sched-body">
        {editing && (
          <JobForm
            job={editing === "new" ? null : editing}
            onCancel={() => { setError(null); setEditing(null); }}
            onSave={save}
          />
        )}

        {loaded && jobs.length === 0 && !editing && (
          <div className="empty">
            <span className="empty-ring"><IconClock size={20} /></span>
            <h3>No scheduled tasks</h3>
            <p>
              Give the agent something to do on a schedule — a nightly summary, a
              morning check of a site, a weekly tidy-up. Each run opens its own
              session you can watch or replay.
            </p>
          </div>
        )}

        {jobs.map((job) => (
          <article className={`job ${job.enabled ? "" : "is-off"}`} key={job.id}>
            <div className="job-top">
              <button
                className={`job-switch ${job.enabled ? "on" : ""}`}
                onClick={() => void toggle(job)}
                role="switch"
                aria-checked={job.enabled}
                aria-label={job.enabled ? `Disable ${job.name}` : `Enable ${job.name}`}
              >
                <span className="job-knob" />
              </button>
              <b className="job-name">{job.name}</b>
              <div className="spacer" />
              <button className="btn icon ghost" title="Run now" aria-label={`Run ${job.name} now`}
                      onClick={() => void runNow(job)}>
                <IconPlay size={13} />
              </button>
              <button className="btn icon ghost" title="Edit" aria-label={`Edit ${job.name}`}
                      onClick={() => { setError(null); setEditing(job); }}>
                <IconCheck size={13} />
              </button>
              <button className="btn icon ghost" title="Delete" aria-label={`Delete ${job.name}`}
                      onClick={() => void remove(job)}>
                <IconTrash size={13} />
              </button>
            </div>

            <div className="job-when">
              <code>{job.cron}</code>
              {describeCron(job.cron) && <span>{describeCron(job.cron)}</span>}
            </div>

            <p className="job-prompt">{job.prompt}</p>

            <div className="job-foot">
              {job.cron_error ? (
                <span className="job-bad">{job.cron_error}</span>
              ) : job.enabled && job.next_run ? (
                <span>next {until(job.next_run)}</span>
              ) : (
                <span className="muted">paused</span>
              )}
              {job.last_run && (
                job.last_session ? (
                  <button className="job-link" onClick={() => onOpenSession(job.last_session!)}>
                    last run {ago(job.last_run)}
                  </button>
                ) : (
                  <span className="muted">last run {ago(job.last_run)}</span>
                )
              )}
              {job.last_error && <span className="job-bad">{job.last_error}</span>}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function JobForm({
  job, onCancel, onSave,
}: {
  job: Job | null;
  onCancel: () => void;
  onSave: (draft: Partial<Job>, id?: string) => Promise<boolean>;
}) {
  const [name, setName] = useState(job?.name ?? "");
  const [cron, setCron] = useState(job?.cron ?? "0 8 * * *");
  const [prompt, setPrompt] = useState(job?.prompt ?? "");
  const [saving, setSaving] = useState(false);

  const described = describeCron(cron);
  const ready = cron.trim().split(/\s+/).length === 5 && prompt.trim().length > 0;

  return (
    <form
      className="jobform"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!ready || saving) return;
        setSaving(true);
        await onSave({ name, cron, prompt }, job?.id);
        setSaving(false);
      }}
    >
      <label className="jf-row">
        <span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)}
               placeholder="Nightly summary" />
      </label>

      <label className="jf-row">
        <span>Task</span>
        <textarea
          value={prompt}
          rows={3}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="What should the agent do when this runs?"
        />
      </label>

      <label className="jf-row">
        <span>Schedule</span>
        <input
          value={cron}
          onChange={(e) => setCron(e.target.value)}
          className="jf-cron"
          spellCheck={false}
          aria-describedby="jf-cron-hint"
        />
      </label>
      <div className="jf-hint" id="jf-cron-hint">
        {described ?? "minute hour day month weekday"}
      </div>

      <div className="jf-presets">
        {PRESETS.map((p) => (
          <button
            type="button"
            key={p.cron}
            className={`kchip ${cron.trim() === p.cron ? "on" : ""}`}
            onClick={() => setCron(p.cron)}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="jf-actions">
        <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn primary" disabled={!ready || saving}>
          {job ? "Save changes" : "Create task"}
        </button>
      </div>
    </form>
  );
}
