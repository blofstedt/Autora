import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { IconCopy, IconPlug, IconPlus, IconRotateCcw, IconTrash, IconX } from "./Icons";
import { ago } from "../lib/ago";
import { every } from "../lib/poll";

/**
 * A trigger: a URL and a secret, with a prompt attached. Anything that can
 * make an HTTP request starts it -- a CI job that has finished, a script on
 * another machine, a shortcut on your phone -- and the turn it starts reports
 * in a session of its own, with the same budget as a scheduled run. See
 * server/triggers.ts.
 *
 * Its own page, and not a section of the Schedules page: a schedule is a time
 * and a watcher is a target, but a trigger is something outside saying so, and
 * the two are looked for in different moods. A date and a recurrence is how
 * you think about one; a URL and a secret is how you think about the other.
 */
export type TriggerRow = {
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

export function Triggers({
  onOpenSession, topSlot,
}: {
  onOpenSession: (id: string) => void;
  /** The header's right-hand corner, where a page's own button goes. */
  topSlot?: HTMLElement | null;
}) {
  const [triggers, setTriggers] = useState<TriggerRow[]>([]);
  /** The secret of a trigger just made or rotated, shown once, with its URL. */
  const [secret, setSecret] = useState<{ url: string; token: string } | null>(null);
  const [newTrigger, setNewTrigger] = useState<{ name: string; prompt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/triggers");
      const made = await res.json().catch(() => []);
      setTriggers(Array.isArray(made) ? made : []);
    } catch {
      /* the next poll will pick it up */
    } finally {
      setLoaded(true);
    }
  }, []);

  // Poll while open: a trigger that fired while someone is looking at the list
  // should show up in it.
  useEffect(() => {
    void load();
    return every(load, 15_000);
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

  const copy = (url: string, token: string) => {
    void navigator.clipboard
      ?.writeText(`curl -s -X POST ${url} -H "x-autora-token: ${token}"`)
      .catch(() => undefined);
  };

  return (
    <div className="sched is-embedded trig-page">
      {/* The one thing this page is for, in the corner it is looked for in. */}
      {topSlot &&
        createPortal(
          <button
            className="btn primary top-action"
            onClick={() => { setError(null); setNewTrigger({ name: "", prompt: "" }); }}
          >
            <IconPlus size={13} /> <span className="top-action-word">New trigger</span>
          </button>,
          topSlot,
        )}

      <div className="sched-body">
        {error && <div className="sched-error">{error}</div>}

        {secret && (
          <div className="trig-secret">
            <p>
              <b>Copy this now.</b> The secret is shown once — it is not stored anywhere it can be
              read back, only its fingerprint.
            </p>
            <code>
              curl -s -X POST {secret.url}
              {"\n"}  -H "x-autora-token: {secret.token}"
            </code>
            <div className="trig-secret-acts">
              <button className="btn ghost" onClick={() => copy(secret.url, secret.token)}>
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
              <button className="btn primary" type="submit"
                      disabled={!newTrigger.name.trim() || !newTrigger.prompt.trim()}>
                Make the URL
              </button>
              <button className="btn ghost" type="button" onClick={() => setNewTrigger(null)}>
                <IconX size={12} /> Cancel
              </button>
            </div>
          </form>
        )}

        {loaded && triggers.length === 0 && !newTrigger && (
          <div className="empty">
            <span className="empty-ring"><IconPlug size={20} /></span>
            <h3>No triggers</h3>
            {/* What a trigger is lives here, in the empty page, rather than as
                a block of prose above everything. */}
            <p>
              A trigger is a URL that starts a turn when something outside Autora calls it: a build
              that went green, a script on another machine, a shortcut on your phone. Each run gets a
              session of its own. You get a URL and a secret, and the secret is shown once.
            </p>
            <p className="empty-note">Anything on a timer goes on Schedules instead.</p>
          </div>
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
            {!t.last_error && <p className="rule-note">{t.prompt}</p>}
          </article>
        ))}
      </div>
    </div>
  );
}
