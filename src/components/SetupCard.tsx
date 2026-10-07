import { useEffect, useState } from "react";
import { IconArrow, IconCheck } from "./Icons";
import { answerOffer, dismissNotice, fetchProactive, type Proactive } from "../lib/proactive";

type Provider = {
  id: string;
  label: string;
  note: string;
  keys_url: string;
  key_hint: string;
  needs_key: boolean;
  default_model: string;
  default_base_url: string;
  model: string;
};

/**
 * What an empty chat shows until a model is connected.
 *
 * A fresh install used to open on a thread that said "type a task", and the
 * first task anyone typed came back as "no model is connected". This asks for
 * the one thing that is missing, in the place people look first: choose a
 * provider, paste a key, done. Everything else about providers stays in
 * Settings, which is one link away.
 */
export function SetupCard({
  onConnected, onOpenSettings,
}: {
  onConnected: () => void;
  onOpenSettings: () => void;
}) {
  const [providers, setProviders] = useState<Provider[] | null>(null);
  const [picked, setPicked] = useState<string>("");
  const [key, setKey] = useState("");
  const [model, setModel] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => {
        if (!alive || !Array.isArray(d?.catalog)) return;
        setProviders(d.catalog as Provider[]);
      })
      .catch(() => alive && setError("Could not reach the server."));
    return () => { alive = false; };
  }, []);

  const card = providers?.find((p) => p.id === picked);

  const choose = (p: Provider) => {
    setPicked(p.id);
    setKey("");
    setError(null);
    setModel(p.model || p.default_model);
    setUrl(p.default_base_url);
  };

  const connect = async () => {
    if (!card) return;
    setBusy(true);
    setError(null);
    try {
      if (card.needs_key) {
        // Checked before it is saved, so a typo is caught here rather than as
        // a failed first task.
        const test = await fetch(`/api/providers/${card.id}/test`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: key.trim() }),
        });
        const verdict = await test.json().catch(() => ({}));
        if (!test.ok) {
          setError(verdict.detail ?? `${card.label} did not accept that key.`);
          return;
        }
      }
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: card.id,
          ...(card.needs_key ? { credentials: { [card.id]: key.trim() } } : {}),
          ...(model.trim() ? { models: { [card.id]: model.trim() } } : {}),
          ...(!card.needs_key && url.trim() ? { base_urls: { [card.id]: url.trim() } } : {}),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.detail ?? "Could not save that.");
        return;
      }
      if (!body.active?.connected) {
        setError(body.active?.hint ?? "Saved, but the model is still not ready.");
        return;
      }
      onConnected();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  };

  const ready = card && (card.needs_key ? key.trim() !== "" : model.trim() !== "");

  return (
    <div className="setup">
      <h3>Hello. I need a model to think with.</h3>
      <p>Pick a provider and paste its API key, and I can start.</p>

      {!providers && !error && <p className="setup-hint">Loading…</p>}

      {providers && (
        <div className="setup-providers" role="radiogroup" aria-label="Provider">
          {providers.map((p) => (
            <button
              key={p.id}
              role="radio"
              aria-checked={picked === p.id}
              className={`setup-provider ${picked === p.id ? "on" : ""}`}
              onClick={() => choose(p)}
            >
              {picked === p.id && <IconCheck size={12} />}
              {p.label}
            </button>
          ))}
        </div>
      )}

      {card && (
        <form
          className="setup-form"
          onSubmit={(e) => { e.preventDefault(); if (ready && !busy) void connect(); }}
        >
          <p className="setup-hint">{card.note}</p>
          {card.needs_key ? (
            <>
              <input
                type="password"
                autoFocus
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder={`${card.label} API key (${card.key_hint})`}
                spellCheck={false}
                aria-label={`${card.label} API key`}
              />
              {card.keys_url && (
                <a className="setup-link" href={card.keys_url} target="_blank" rel="noreferrer">
                  Get a {card.label} key
                </a>
              )}
            </>
          ) : (
            <>
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder={card.default_base_url || "http://localhost:11434/v1"}
                spellCheck={false}
                aria-label="Server address"
              />
              <input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="Model name, e.g. llama3.1"
                spellCheck={false}
                aria-label="Model name"
              />
            </>
          )}
          <button className="btn primary" type="submit" disabled={!ready || busy}>
            {busy ? "Checking…" : "Connect"} {!busy && <IconArrow size={13} />}
          </button>
        </form>
      )}

      {error && <p className="set-warn setup-error" role="alert">{error}</p>}

      <button className="setup-more" onClick={onOpenSettings}>
        More options in Settings
      </button>
    </div>
  );
}

/** Tasks to start from, when there is no history yet to start from. */
const STARTERS = [
  "Summarize the top story on Hacker News",
  "Check example.com every morning and tell me if it is down",
  "Find the largest files in my home folder",
  "Research three options for a quiet mechanical keyboard",
];

type RecentSession = { id: string; title?: string; turns?: number; created_at?: number; updated_at?: number };
type JobBrief = {
  id: string; name: string; enabled: boolean; next_run: number | null;
  last_run: number | null; last_session: string | null; last_error: string | null;
  runs?: { ok: boolean; at: number; session: string | null }[];
};
type Thread = { key: string; text: string; sub?: string; tone?: "ok" | "warn"; go: () => void };

const ago = (ts: number) => {
  const s = Math.max(0, Math.round(Date.now() / 1000 - ts));
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};
const at = (ts: number) =>
  new Date(ts * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function greeting(): string {
  const h = new Date().getHours();
  return h < 5 ? "Still up?" : h < 12 ? "Good morning." : h < 18 ? "Good afternoon." : "Good evening.";
}

/**
 * The empty chat, once a model is connected.
 *
 * Something alive remembers you, so this opens on what is actually going on:
 * the conversation you were last in, what the schedules did while you were
 * away, what is due next, and what was learned and is waiting for a yes or
 * no. Every line is read from the server -- none of it is invented -- and each
 * one opens the thing it is about.
 *
 * Then what it could do, worked out from this install rather than from a list
 * (see server/suggest.ts): anything it has noticed going wrong, one schedule
 * worth offering, tasks that fit what is here -- the disk, the apps beside it,
 * the sites its browser is signed in to, what it remembers about the person --
 * and always the question it can answer best, "what could you do for me?".
 * Those go straight out with one tap. Only when it knows nothing about the
 * install yet do the generic examples appear, and those go into the box to be
 * edited first, because they are examples.
 */
export function Welcome({
  sessions, current, onOpenSession, onOpenMind, onOpenSchedules, onPick, onSend,
}: {
  sessions: RecentSession[];
  current: string | null;
  onOpenSession: (id: string) => void;
  onOpenMind: () => void;
  onOpenSchedules: () => void;
  onPick: (text: string) => void;
  /** Sends a suggestion as it is, the card's words naming the chat. Without
      it, suggestions go into the box. */
  onSend?: (text: string, title?: string) => void;
}) {
  const [jobs, setJobs] = useState<JobBrief[]>([]);
  const [memory, setMemory] = useState<{ kept: number; waiting: number }>({ kept: 0, waiting: 0 });
  const [ideas, setIdeas] = useState<Proactive | null>(null);
  /** What the offer turned into once answered: a line in its place. */
  const [answered, setAnswered] = useState<string | null>(null);
  const [waved, setWaved] = useState<string[]>([]);
  const send = onSend ?? onPick;

  useEffect(() => {
    let alive = true;
    void fetchProactive().then((found) => { if (alive) setIdeas(found); });
    fetch("/api/jobs").then((r) => r.json()).then((rows) => {
      if (alive && Array.isArray(rows)) setJobs(rows as JobBrief[]);
    }).catch(() => undefined);
    fetch("/api/memory").then((r) => r.json()).then((d) => {
      if (!alive || !Array.isArray(d?.records)) return;
      const live = (d.records as { status: string; superseded_by: string | null }[])
        .filter((r) => !r.superseded_by);
      setMemory({
        kept: live.filter((r) => r.status === "confirmed").length,
        waiting: live.filter((r) => r.status !== "confirmed").length,
      });
    }).catch(() => undefined);
    return () => { alive = false; };
  }, []);

  const threads: Thread[] = [];

  const last = sessions
    .filter((s) => s.id !== current && (s.turns ?? 0) > 0)
    .sort((a, b) => (b.updated_at ?? b.created_at ?? 0) - (a.updated_at ?? a.created_at ?? 0))[0];
  if (last) {
    threads.push({
      key: `s-${last.id}`,
      text: `Pick up where we left off: “${last.title?.trim() || "Untitled session"}”`,
      sub: last.updated_at ? ago(last.updated_at) : undefined,
      go: () => onOpenSession(last.id),
    });
  }

  const dayAgo = Date.now() / 1000 - 86400;
  // A job already said to have failed, up among what it noticed, is not said twice.
  const noticedJobs = new Set((ideas?.notices ?? []).map((n) => n.key.startsWith("job:") ? n.key.slice(4) : ""));
  const ran = jobs
    .filter((j) => j.last_run && j.last_run > dayAgo && !noticedJobs.has(j.id))
    .sort((a, b) => (b.last_run ?? 0) - (a.last_run ?? 0))
    .slice(0, 2);
  for (const job of ran) {
    const lastRun = job.runs?.[job.runs.length - 1];
    const failed = !!job.last_error || lastRun?.ok === false;
    const session = lastRun?.session ?? job.last_session;
    threads.push({
      key: `j-${job.id}`,
      text: `${job.name} ran ${ago(job.last_run!)} — ${failed ? "it hit a problem" : "all fine"}`,
      tone: failed ? "warn" : "ok",
      go: () => (session ? onOpenSession(session) : onOpenSchedules()),
    });
  }
  const next = jobs
    .filter((j) => j.enabled && j.next_run && !ran.includes(j))
    .sort((a, b) => (a.next_run ?? 0) - (b.next_run ?? 0))[0];
  if (next?.next_run && next.next_run - Date.now() / 1000 < 86400) {
    threads.push({
      key: `n-${next.id}`,
      text: `Next up: ${next.name} at ${at(next.next_run)}`,
      go: onOpenSchedules,
    });
  }

  if (memory.waiting > 0) {
    threads.push({
      key: "m-waiting",
      text: `I learned ${memory.waiting} thing${memory.waiting === 1 ? "" : "s"} recently — keep or discard?`,
      tone: "warn",
      go: onOpenMind,
    });
  } else if (memory.kept > 0) {
    threads.push({
      key: "m-kept",
      text: `I remember ${memory.kept} thing${memory.kept === 1 ? "" : "s"} about how you work`,
      go: onOpenMind,
    });
  }

  const fresh = threads.length === 0;
  const noticed = (ideas?.notices ?? []).filter((n) => !waved.includes(n.key)).slice(0, 2);
  const offer = ideas?.offer ?? null;
  const tasks = (ideas?.starters ?? []).filter((t) => !noticed.some((n) => n.prompt === t.prompt));
  // A screen, not a feed: fewer tasks when there is already plenty to carry on with.
  const shownTasks = tasks.slice(0, fresh ? 4 : threads.length > 2 ? 2 : 3);
  // The examples are for an install it knows nothing about yet.
  const examples = tasks.length > 0 ? [] : fresh ? STARTERS : STARTERS.slice(0, 2);
  let order = 0;
  const delay = () => ({ animationDelay: `${120 + order++ * 70}ms` });

  const answer = async (key: string, yes: boolean) => {
    const out = await answerOffer(key, yes ? "yes" : "no");
    if (!yes) setAnswered("");
    else setAnswered(out.ok ? `Set up: “${out.name ?? "it"}” is on your Schedules page.` : out.error ?? "That did not work.");
  };

  return (
    <div className="starters">
      <h3>{greeting()} What should we do?</h3>
      <p>
        {fresh && shownTasks.length === 0
          ? "Describe a task below and watch me do it here. Or try one of these:"
          : "Describe a task below, or pick up from here:"}
      </p>
      <div className="starter-list">
        {noticed.map((n) => (
          <div key={n.key} className={`starter is-notice is-${n.tone}`} style={delay()}>
            <button type="button" className="starter-go" onClick={() => send(n.prompt, n.title)} title={n.prompt}>
              <span>{n.title}</span>
              <em>{n.detail}{/[.!?]$/.test(n.detail) ? "" : "."} Look into it?</em>
            </button>
            <button
              type="button"
              className="starter-x"
              aria-label={`Not now: ${n.title}`}
              title="Not now -- quiet about it until it changes"
              onClick={() => { setWaved((w) => [...w, n.key]); void dismissNotice(n.key); }}
            >
              ×
            </button>
          </div>
        ))}
        {threads.map((t) => (
          <button
            key={t.key}
            className={`starter is-thread ${t.tone ? `is-${t.tone}` : ""}`}
            style={delay()}
            onClick={t.go}
          >
            <span>{t.text}</span>
            {t.sub && <em>{t.sub}</em>}
          </button>
        ))}
        {offer && answered === null && (
          <div className="starter is-offer" style={delay()}>
            <span className="offer-q">{offer.text}</span>
            <span className="offer-why">{offer.why} It reports and changes nothing; you can edit or stop it on the Schedules page.</span>
            <span className="offer-acts">
              <button type="button" className="btn tiny primary" onClick={() => void answer(offer.key, true)}>Set it up</button>
              <button type="button" className="btn tiny ghost" onClick={() => void answer(offer.key, false)}>No thanks</button>
            </span>
          </div>
        )}
        {answered && (
          <button type="button" className="starter is-thread is-ok" onClick={onOpenSchedules}>
            <span>{answered}</span>
          </button>
        )}
        {shownTasks.map((t) => (
          <button key={t.key} type="button" className="starter is-suggest" style={delay()} onClick={() => send(t.prompt, t.title)} title={t.prompt}>
            <span>{t.title}</span>
            <em>{t.why}</em>
          </button>
        ))}
        {examples.map((text) => (
          <button key={text} type="button" className="starter" style={delay()} onClick={() => onPick(text)}>
            {text}
          </button>
        ))}
        {ideas?.discover && (
          <button
            type="button"
            className="starter is-discover"
            style={delay()}
            onClick={() => send(ideas.discover.prompt, ideas.discover.title)}
            title={ideas.discover.prompt}
          >
            <span>✦ {ideas.discover.title}</span>
            <em>{ideas.discover.why}</em>
          </button>
        )}
      </div>
    </div>
  );
}
