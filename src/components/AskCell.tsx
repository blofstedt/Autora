import { useState } from "react";
import type { Ask } from "../lib/derive";
import { AutoraMark } from "./AutoraMark";
import { IconArrow, IconCheck, IconKey, IconPlug, IconX } from "./Icons";

/**
 * The agent, stopped, asking you something.
 *
 * This is the one place the conversation turns round and waits on you, so it
 * is drawn to be seen: its own surface, the question at reading size, and
 * answers as things you tap rather than text you have to compose. Picking a
 * single option sends it; several, or your own words, go with the arrow.
 * Once answered it folds to a line saying what you said.
 */
export function AskCell({
  ask, sessionId, readOnly,
}: {
  ask: Ask;
  sessionId: string;
  readOnly: boolean;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const answer = async (body: { choices?: string[]; text?: string; cancelled?: boolean }) => {
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/ask/${ask.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.error ?? "That did not go through.");
      }
    } catch {
      setError("Could not reach the server.");
    } finally {
      setSending(false);
    }
  };

  const isBrowser = ask.kind === "browser";

  if (ask.open && ask.kind === "offer" && ask.offer) {
    return <OfferCard ask={ask} readOnly={readOnly} onAnswer={answer} sending={sending} error={error} />;
  }

  if (!ask.open) {
    const a = ask.answer;
    // A turned-down offer settles as a no, not with a tick.
    const declinedOffer = ask.kind === "offer" && !!a && !a.choices.includes("Set it up");
    const said = !a
      ? "No longer waiting"
      : a.cancelled
        ? a.who === "user" ? (isBrowser ? "You couldn't do this one" : "Skipped") : "Went unanswered"
        : isBrowser
          ? a.who === "auto" ? (a.text || "Passed — carrying on") : "Done in the browser"
          : [...a.choices, a.text].filter(Boolean).join(" · ");
    return (
      <div className={`ask is-settled ${a && !a.cancelled && !declinedOffer ? "is-answered" : ""}`}>
        <span className="ask-settled-mark">
          {a && !a.cancelled && !declinedOffer ? <IconCheck size={12} /> : <IconX size={12} />}
        </span>
        <div className="ask-settled-body">
          <span className="ask-settled-q">{ask.title}</span>
          <span className="ask-settled-a">{said}</span>
        </div>
      </div>
    );
  }

  const disabled = readOnly || sending;
  const toggle = (label: string) => {
    if (!ask.multi) {
      setPicked([label]);
      void answer({ choices: [label] });
      return;
    }
    setPicked((p) => (p.includes(label) ? p.filter((x) => x !== label) : [...p, label]));
  };
  const canSubmit = picked.length > 0 || text.trim().length > 0;
  const submit = () => {
    if (!canSubmit) return;
    void answer({ choices: picked, text: text.trim() });
  };

  return (
    <section className={`ask ${isBrowser ? "is-browser" : ""}`} aria-live="polite">
      <div className="ask-glow" aria-hidden="true" />
      <header className="ask-head">
        <span className="ask-badge">
          {isBrowser ? <IconKey size={14} /> : <AutoraMark size={16} state="live" />}
        </span>
        <span className="ask-kicker">
          {isBrowser ? "Your turn in the browser" : "Autora needs your input"}
        </span>
        <span className="ask-waiting"><i /> waiting on you</span>
      </header>

      <h3 className="ask-title">{ask.title}</h3>
      {ask.detail && <p className="ask-detail">{ask.detail}</p>}

      {isBrowser ? (
        <>
          <p className="ask-where">
            The page is unlocked just above: tap into it and type as you normally would.
          </p>
          <div className="ask-actions">
            <button className="ask-primary" disabled={disabled} onClick={() => void answer({})}>
              <IconCheck size={15} /> I'm done
            </button>
            <button
              className="ask-secondary"
              disabled={disabled}
              onClick={() => void answer({ cancelled: true })}
            >
              I can't do this
            </button>
          </div>
        </>
      ) : (
        <>
          {ask.options.length > 0 && (
            <div className={`ask-options ${ask.options.length > 3 ? "is-grid" : ""}`}>
              {ask.options.map((o, i) => {
                const on = picked.includes(o.label);
                return (
                  <button
                    key={o.label}
                    className={`ask-option ${on ? "on" : ""}`}
                    disabled={disabled}
                    onClick={() => toggle(o.label)}
                    aria-pressed={on}
                  >
                    <span className={`ask-tick ${ask.multi ? "is-box" : ""}`}>
                      {on ? <IconCheck size={11} /> : <em>{i + 1}</em>}
                    </span>
                    <span className="ask-option-text">
                      <b>{o.label}</b>
                      {o.detail && <span>{o.detail}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {(ask.allowText || ask.multi) && (
            <div className="ask-compose">
              {ask.allowText && (
                <textarea
                  rows={1}
                  value={text}
                  disabled={disabled}
                  placeholder={
                    ask.placeholder ||
                    (ask.options.length ? "Or answer in your own words…" : "Your answer…")
                  }
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      submit();
                    }
                  }}
                />
              )}
              <button
                className="ask-send"
                disabled={disabled || !canSubmit}
                onClick={submit}
                aria-label="Send answer"
              >
                {ask.multi && picked.length > 0 && !text.trim()
                  ? <>Send {picked.length}</>
                  : null}
                <IconArrow size={15} />
              </button>
            </div>
          )}

          <div className="ask-foot">
            <button className="ask-skip" disabled={disabled} onClick={() => void answer({ cancelled: true })}>
              Skip — let it decide
            </button>
          </div>
        </>
      )}
      {error && <p className="ask-error">{error}</p>}
    </section>
  );
}

/**
 * The agent offering to set up an MCP server.
 *
 * Says what it is, why it beats what the agent would otherwise do, and
 * exactly what will run -- then asks for any key it needs right here. A key
 * typed on this card goes straight into the secret store and never into the
 * conversation: the answer that reaches the agent is only "Set it up".
 */
function OfferCard({
  ask, readOnly, onAnswer, sending, error,
}: {
  ask: Ask;
  readOnly: boolean;
  onAnswer: (body: { choices?: string[]; cancelled?: boolean }) => Promise<void>;
  sending: boolean;
  error: string | null;
}) {
  const offer = ask.offer!;
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const missing = offer.needs.filter((n) => !n.set);
  const ready = missing.every((n) => (keys[n.env] ?? "").trim());
  const disabled = readOnly || sending || saving;

  const accept = async () => {
    setSaving(true);
    setProblem(null);
    try {
      for (const need of missing) {
        const res = await fetch("/api/secrets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: need.env, value: keys[need.env].trim() }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setProblem(data?.error ?? `Could not save the ${need.label}.`);
          return;
        }
      }
      await onAnswer({ choices: ["Set it up"] });
    } catch {
      setProblem("Could not reach the server.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="ask is-offer" aria-live="polite">
      <div className="ask-glow" aria-hidden="true" />
      <header className="ask-head">
        <span className="ask-badge"><IconPlug size={14} /></span>
        <span className="ask-kicker">A better way to do this</span>
        <span className="ask-waiting"><i /> waiting on you</span>
      </header>

      <h3 className="ask-title">{ask.title}</h3>
      {ask.detail && <p className="ask-detail">{ask.detail}</p>}

      <dl className="offer-facts">
        <dt>What it gives me</dt>
        <dd>{offer.summary}</dd>
        <dt>What will run</dt>
        <dd><code>{offer.runs}</code></dd>
      </dl>

      {offer.needs.length > 0 && (
        <div className="offer-keys">
          {offer.needs.map((need) => need.set ? (
            <p key={need.env} className="offer-key is-set">
              <IconCheck size={12} /> {need.label} is already saved
            </p>
          ) : (
            <label key={need.env} className="offer-key">
              <span>
                {need.label}
                {need.url && (
                  <> · <a href={need.url} target="_blank" rel="noreferrer">get one</a></>
                )}
              </span>
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={keys[need.env] ?? ""}
                disabled={disabled}
                placeholder={need.hint ?? need.env}
                onChange={(e) => setKeys((k) => ({ ...k, [need.env]: e.target.value }))}
                aria-label={need.label}
              />
            </label>
          ))}
          {missing.length > 0 && (
            <p className="offer-note">
              Saved to Settings › API Keys › Secrets as {missing.map((n) => n.env).join(", ")}.
              I never see the value.
            </p>
          )}
        </div>
      )}

      <div className="ask-actions">
        <button className="ask-primary" disabled={disabled || !ready} onClick={() => void accept()}>
          <IconCheck size={15} /> {saving || sending ? "Setting up…" : "Set it up"}
        </button>
        <button className="ask-secondary" disabled={disabled} onClick={() => void onAnswer({ choices: ["Not now"] })}>
          Not now
        </button>
      </div>
      {(problem || error) && <p className="ask-error">{problem || error}</p>}
    </section>
  );
}
