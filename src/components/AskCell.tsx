import { useState } from "react";
import type { Ask } from "../lib/derive";
import { AutoraMark } from "./AutoraMark";
import { IconArrow, IconCheck, IconKey, IconX } from "./Icons";

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
  ask, sessionId, readOnly, docked,
}: {
  ask: Ask;
  sessionId: string;
  readOnly: boolean;
  /** The live page is in the side panel rather than under this card. */
  docked?: boolean;
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

  if (!ask.open) {
    const a = ask.answer;
    const said = !a
      ? "No longer waiting"
      : a.cancelled
        ? a.who === "user" ? (isBrowser ? "You couldn't do this one" : "Skipped") : "Went unanswered"
        : isBrowser
          ? "Done in the browser"
          : [...a.choices, a.text].filter(Boolean).join(" · ");
    return (
      <div className={`ask is-settled ${a && !a.cancelled ? "is-answered" : ""}`}>
        <span className="ask-settled-mark">
          {a && !a.cancelled ? <IconCheck size={12} /> : <IconX size={12} />}
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
            {docked
              ? "The page is unlocked in the panel on the right."
              : "The page is unlocked just above: tap into it and type as you normally would."}
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
