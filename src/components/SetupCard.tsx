import { useEffect, useState } from "react";
import { IconArrow, IconCheck } from "./Icons";

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
      <h3>Connect a model to start</h3>
      <p>Autora needs an AI model to work. Pick a provider and paste its API key.</p>

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

/** Tasks to start from, once there is a model to do them. */
export const STARTERS = [
  "Summarize the top story on Hacker News",
  "Check example.com every morning and tell me if it is down",
  "Find the largest files in my home folder",
  "Research three options for a quiet mechanical keyboard",
];

export function Starters({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="starters">
      <h3>What should Autora do?</h3>
      <p>Describe a task below and watch it happen here. Or try one of these:</p>
      <div className="starter-list">
        {STARTERS.map((text) => (
          <button key={text} className="starter" onClick={() => onPick(text)}>
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}
