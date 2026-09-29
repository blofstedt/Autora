import { useCallback, useEffect, useState } from "react";
import {
  IconCheck, IconClock, IconCopy, IconPlay, IconPlug, IconPlus, IconRepeat, IconRotateCcw, IconShield, IconTrash, IconX,
} from "./Icons";

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
  /** Set for a watcher: the cron is how often it looks. */
  watch?: { kind: WatchKind; target: string } | null;
  last_seen?: { at: number; preview: string } | null;
  runs?: JobRun[];
  running?: boolean;
};

type WatchKind = "page" | "file" | "command";

/**
 * A standing agreement: a class of call the person has already said yes to,
 * so the guard stops asking about it. Added by the agent, by them on an
 * approval card, or by pressing "do not ask again" there.
 */
type Agreement = {
  id: string;
  tool: string;
  match: string;
  note: string;
  added: number;
  by: "agent" | "person";
  used: number;
  last_used: number | null;
};

/**
 * A trigger: a URL and a secret, with a prompt attached. Anything that can
 * make an HTTP request starts it -- a CI job, a shell script, a phone
 * shortcut -- and the turn it starts reports in a session of its own, like a
 * scheduled run. See server/triggers.ts.
 */
type TriggerRow = {
  id: string;
  name: string;
  prompt: string;
  enabled: boolean;
  created: number;
  fires: number;
  last_fired: number | null;
  last_session: string | null;
  last_error: string | null;
  token_hint: string;
  url: string;
  /** Only present in the answer that made or rotated it. */
  token?: string;
};

type JobRun = {
  at: number;
  finished: number | null;
  reason: "schedule" | "manual" | "change";
  session: string | null;
  ok: boolean;
  error: string | null;
  summary: string;
};

const WATCH_LABEL: Record<WatchKind, { noun: string; placeholder: string }> = {
  page: { noun: "web page", placeholder: "https://example.com/pricing" },
  file: { noun: "file or folder", placeholder: "/data/inbox" },
  command: { noun: "command's output", placeholder: "docker ps --format '{{.Names}} {{.Status}}'" },
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
export function until(ts: number): string {
  const seconds = Math.round(ts - Date.now() / 1000);
  if (seconds <= 0) return "due now";
  if (seconds < 90) return `in ${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)} days`;
}

export function ago(ts: number): string {
  const seconds = Math.round(Date.now() / 1000 - ts);
  if (seconds < 90) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Scheduled tasks and watchers: a prompt and a cron expression.
 *
 * A task runs its prompt on the schedule. A watcher uses the schedule to look
 * at a page, a file or a command's output, and runs its prompt only when that
 * changed, with the change attached. Each run opens its own session; the last
 * few are listed under the task, one tap from each.
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
  const [rules, setRules] = useState<Agreement[]>([]);
  const [triggers, setTriggers] = useState<TriggerRow[]>([]);
  /** The secret of a trigger just made or rotated, shown once, with its URL. */
  const [secret, setSecret] = useState<{ url: string; token: string } | null>(null);
  const [newTrigger, setNewTrigger] = useState<{ name: string; prompt: string } | null>(null);
  const [editing, setEditing] = useState<Job | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const [jobsRes, rulesRes, triggersRes] = await Promise.all([
        fetch("/api/jobs"), fetch("/api/autonomy"), fetch("/api/triggers"),
      ]);
      setJobs(await jobsRes.json());
      const body = await rulesRes.json().catch(() => ({ rules: [] }));
      setRules(Array.isArray(body?.rules) ? body.rules : []);
      const made = await triggersRes.json().catch(() => []);
      setTriggers(Array.isArray(made) ? made : []);
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
      setError(body.error ?? body.detail ?? "Could not save that task.");
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

  const saveTrigger = useCallback(
    async (draft: { name: string; prompt: string }) => {
      setError(null);
      const res = await fetch("/api/triggers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error ?? "Could not make that trigger.");
        return;
      }
      setNewTrigger(null);
      setSecret({ url: body.trigger.url, token: body.trigger.token });
      await load();
    },
    [load],
  );

  const patchTrigger = useCallback(
    async (t: TriggerRow, patch: Record<string, unknown>) => {
      const res = await fetch(`/api/triggers/${t.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error ?? "That could not be changed.");
        return;
      }
      if (body.trigger?.token) setSecret({ url: body.trigger.url, token: body.trigger.token });
      await load();
    },
    [load],
  );

  const removeTrigger = useCallback(
    async (t: TriggerRow) => {
      await fetch(`/api/triggers/${t.id}`, { method: "DELETE" });
      setSecret(null);
      await load();
    },
    [load],
  );

  /* With an agreement, that one; without, all of them. */
  const revokeRule = useCallback(async (rule?: Agreement) => {
    await fetch(rule ? `/api/autonomy/${encodeURIComponent(rule.id)}` : "/api/autonomy", { method: "DELETE" });
    await load();
  }, [load]);

  const runNow = useCallback(async (job: Job) => {
    setError(null);
    const res = await fetch(`/api/jobs/${job.id}/run`, { method: "POST" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(body.error ?? body.detail ?? "Could not start that task.");
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
          {embedded ? "Schedules" : "Scheduled tasks"}
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
              {job.watch && <span className="job-watch">watches {WATCH_LABEL[job.watch.kind].noun}: <code>{job.watch.target}</code>,</span>}
              <code>{job.cron}</code>
              {describeCron(job.cron) && <span>{job.watch ? "checked " : ""}{describeCron(job.cron)}</span>}
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
              {job.running && <span className="job-live">running now</span>}
              {job.watch && job.last_seen && <span className="muted">looked {ago(job.last_seen.at)}</span>}
              {job.last_error && <span className="job-bad">{job.last_error}</span>}
            </div>

            {(job.runs?.length ?? 0) > 0 && (
              <details className="job-runs">
                <summary>History ({job.runs!.length})</summary>
                {[...job.runs!].reverse().map((run) => (
                  <button
                    key={`${run.at}-${run.session}`}
                    className={`job-run ${run.finished === null ? "is-live" : run.ok ? "is-ok" : "is-bad"}`}
                    disabled={!run.session}
                    onClick={() => run.session && onOpenSession(run.session)}
                  >
                    <span className="job-run-dot" aria-hidden="true" />
                    <span className="job-run-when">
                      {ago(run.at)}{run.reason === "change" ? " · changed" : run.reason === "manual" ? " · by hand" : ""}
                    </span>
                    <span className="job-run-what">
                      {run.finished === null ? "running…" : run.ok ? run.summary || "done" : run.error || "failed"}
                    </span>
                  </button>
                ))}
              </details>
            )}
          </article>
        ))}

        {/* The third way work starts by itself: not a time, not a change in
            something the console watches, but somebody else's machine saying
            so. A schedule's row is a time and a watcher's is a target; a
            trigger's is a URL and a secret. */}
        <section className="agree trig">
          <div className="agree-top">
            <span className="brand-mark"><IconPlug size={13} /></span>
            <b>Triggers</b>
            <div className="spacer" />
            <button
              className="btn ghost"
              onClick={() => { setError(null); setNewTrigger({ name: "", prompt: "" }); }}
            >
              <IconPlus size={13} /> New trigger
            </button>
          </div>
          <p className="agree-why">
            A URL that starts a turn when something calls it — a CI job that has finished, a script on
            another machine, a shortcut on your phone. It runs in a session of its own, exactly like a
            scheduled task, with the same budget. The secret is the only thing guarding it, so treat
            the URL as a password.
          </p>

          {secret && (
            <div className="trig-secret">
              <p>
                <b>Copy this now.</b> The secret is shown once — it is not stored anywhere it can be
                read back, only its fingerprint.
              </p>
              <code>
                curl -s -X POST {secret.url}                 {"\n"}  -H "x-autora-token: {secret.token}"
              </code>
              <div className="trig-secret-acts">
                <button
                  className="btn ghost"
                  onClick={() => {
                    void navigator.clipboard
                      ?.writeText(`curl -s -X POST ${secret.url} -H "x-autora-token: ${secret.token}"`)
                      .catch(() => undefined);
                  }}
                >
                  <IconCopy size={12} /> Copy the command
                </button>
                <button className="btn ghost" onClick={() => setSecret(null)}>Done</button>
              </div>
            </div>
          )}

          {newTrigger !== null && (
            <form
              className="trig-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (newTrigger.name.trim() && newTrigger.prompt.trim()) void saveTrigger(newTrigger);
              }}
            >
              <input
                className="trig-input"
                placeholder="What is it? (e.g. the nightly build)"
                value={newTrigger.name}
                onChange={(e) => setNewTrigger({ ...newTrigger, name: e.target.value })}
                autoFocus
              />
              <textarea
                className="trig-prompt"
                placeholder="What should the turn do when it fires?"
                rows={3}
                value={newTrigger.prompt}
                onChange={(e) => setNewTrigger({ ...newTrigger, prompt: e.target.value })}
              />
              <div className="trig-form-acts">
                <button type="submit" className="btn primary" disabled={!newTrigger.name.trim() || !newTrigger.prompt.trim()}>
                  Make the URL
                </button>
                <button type="button" className="btn ghost" onClick={() => setNewTrigger(null)}>Cancel</button>
              </div>
            </form>
          )}

          {triggers.map((t) => (
            <article className="rule" key={t.id}>
              <div className="rule-top">
                <code className="rule-match">{t.name}</code>
                <div className="spacer" />
                <button
                  className="btn ghost"
                  title={t.enabled ? "Stop it firing" : "Let it fire again"}
                  onClick={() => void patchTrigger(t, { enabled: !t.enabled })}
                >
                  {t.enabled ? "On" : "Off"}
                </button>
                <button
                  className="btn icon ghost"
                  title="Replace the secret"
                  aria-label={`Rotate the secret for ${t.name}`}
                  onClick={() => void patchTrigger(t, { rotate: true })}
                >
                  <IconRotateCcw size={13} />
                </button>
                <button
                  className="btn icon ghost"
                  title="Delete this trigger"
                  aria-label={`Delete ${t.name}`}
                  onClick={() => void removeTrigger(t)}
                >
                  <IconTrash size={13} />
                </button>
              </div>
              <div className="rule-foot">
                <span className="muted">
                  {t.fires === 0 ? "never fired" : `fired ${t.fires}×`}
                  {t.last_fired ? `, last ${ago(t.last_fired)}` : ""} · secret {t.token_hint}
                </span>
                {t.last_session && (
                  <button className="btn ghost" onClick={() => onOpenSession(t.last_session as string)}>
                    Read the last one
                  </button>
                )}
              </div>
              {t.last_error && <p className="rule-note">{t.last_error}</p>}
            </article>
          ))}
        </section>

        {/* What the guard no longer asks about. Kept next to the schedules
            because both are "things that will happen without you", and both
            need somewhere to be seen and taken back. */}
        {rules.length > 0 && (
          <section className="agree">
            <div className="agree-top">
              <span className="brand-mark"><IconShield size={13} /></span>
              <b>Standing agreements</b>
              <div className="spacer" />
              <button className="btn ghost" onClick={() => void revokeRule()}>
                Revoke all
              </button>
            </div>
            <p className="agree-why">
              These calls run without an approval card. Everything else still waits for one,
              and anything that cannot be undone is asked about every time.
            </p>
            {rules.map((rule) => (
              <article className="rule" key={rule.id}>
                <div className="rule-top">
                  <code className="rule-match">{rule.match}</code>
                  <div className="spacer" />
                  <button
                    className="btn icon ghost"
                    title="Take this agreement back"
                    aria-label={`Revoke ${rule.match}`}
                    onClick={() => void revokeRule(rule)}
                  >
                    <IconTrash size={13} />
                  </button>
                </div>
                <div className="rule-foot">
                  <span className="muted">
                    {rule.tool} · {rule.by === "person" ? "you agreed" : "the agent proposed it"} {ago(rule.added)}
                  </span>
                  <span className="muted">
                    {rule.used === 0
                      ? "not used yet"
                      : `used ${rule.used}×${rule.last_used ? `, last ${ago(rule.last_used)}` : ""}`}
                  </span>
                </div>
                {rule.note && <p className="rule-note">{rule.note}</p>}
              </article>
            ))}
          </section>
        )}
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
  const [watchKind, setWatchKind] = useState<WatchKind | "">(job?.watch?.kind ?? "");
  const [target, setTarget] = useState(job?.watch?.target ?? "");
  const [saving, setSaving] = useState(false);

  const described = describeCron(cron);
  const ready = (cron.trim().startsWith("@") || cron.trim().split(/\s+/).length === 5) &&
    prompt.trim().length > 0 && (!watchKind || target.trim().length > 0);

  return (
    <form
      className="jobform"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!ready || saving) return;
        setSaving(true);
        await onSave({
          name, cron, prompt,
          watch: watchKind ? { kind: watchKind, target: target.trim() } : null,
        }, job?.id);
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

      <div className="jf-row">
        <span>Runs</span>
        <div className="jf-presets">
          {([["", "on the schedule"], ["page", "when a page changes"], ["file", "when a file changes"], ["command", "when a command's output changes"]] as const).map(([kind, label]) => (
            <button
              type="button"
              key={kind || "cron"}
              className={`kchip ${watchKind === kind ? "on" : ""}`}
              onClick={() => setWatchKind(kind)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {watchKind && (
        <>
          <label className="jf-row">
            <span>Watch</span>
            <input
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder={WATCH_LABEL[watchKind].placeholder}
              spellCheck={false}
            />
          </label>
          <div className="jf-hint">
            The schedule below is how often it looks. The first look is only a baseline; after
            that the task runs whenever what it sees has changed, with the change attached.
          </div>
        </>
      )}

      <label className="jf-row">
        <span>{watchKind ? "Check" : "Schedule"}</span>
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
