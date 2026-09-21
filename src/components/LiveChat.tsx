import { useCallback, useEffect, useRef, useState } from "react";
import { useDictation } from "../lib/voice";
import { IconX } from "./Icons";

/** Quiet for this long after a phrase settles and the thought is finished.
    Short enough not to feel like waiting, long enough to think mid-sentence. */
const SETTLE_MS = 1100;

/** And this long when the tail is still unsettled.
 *
 * A final means the engine decided you had stopped; an interim that has simply
 * gone quiet means it is still chewing, and on Chrome for Android that is the
 * only kind of result a whole sentence ever gets. Sending on the same short
 * pause there cuts people off mid-sentence -- which is what the words landing
 * twice looked like from the outside, half a sentence going out and then the
 * whole of it. */
const UNSETTLED_MS = 1800;

/** Single stray syllables are usually the room, not a request. */
const MIN_CHARS = 2;

type State = "listening" | "thinking" | "speaking" | "blocked";

const HEADING: Record<State, string> = {
  listening: "Listening",
  thinking: "Working",
  speaking: "Speaking",
  blocked: "Voice unavailable",
};

const HINT: Record<State, string> = {
  listening: "Say what you need. It sends when you stop.",
  thinking: "Working on it — keep talking to interrupt.",
  speaking: "Tap the orb to cut in.",
  blocked: "",
};

/**
 * Live voice, in place of the composer.
 *
 * The screen above does not change: the same thread, the same stage, the same
 * steps scrolling past. Only the strip you would normally type into becomes
 * the conversation -- which is the whole point, because the reason to talk to
 * this thing is to watch it work while your hands are somewhere else.
 *
 * The loop is speak, pause, send: a phrase settles, a beat of silence ends the
 * thought, and it goes. The microphone closes while the agent talks, because a
 * phone speaker two inches from a phone microphone will happily transcribe the
 * agent back to itself; the orb is the way back in, and cutting it off mid
 * sentence is expected rather than rude.
 */
export function LiveChat({
  onUtterance, onExit, onInterrupt, agentSpeaking, agentWorking, disabled,
}: {
  onUtterance: (text: string) => void;
  onExit: () => void;
  /** Stop the agent talking, for barge-in. */
  onInterrupt: () => void;
  agentSpeaking: boolean;
  agentWorking: boolean;
  disabled?: boolean;
}) {
  const [caption, setCaption] = useState("");
  /** Phrases the engine has committed to. */
  const pending = useRef("");
  /** The phrase still forming, which may never be committed to at all. */
  const live = useRef("");
  const timer = useRef(0);
  const utteranceRef = useRef(onUtterance);
  utteranceRef.current = onUtterance;
  /** Set once the hook below exists; sending unsettled words is only half the
      job without it -- see `accept` in lib/voice. */
  const acceptRef = useRef<() => void>(() => {});

  /**
   * Send what we have, settled or not.
   *
   * Including the unsettled part is the whole fix. Chrome on Android, in
   * continuous mode, will happily stream interim results for a whole sentence
   * and then never mark any of it final -- so a loop that waits for `isFinal`
   * waits forever, and the interface sits there captioning your words back to
   * you while sending nothing. A pause is the signal to act on; whether the
   * engine has made up its mind by then is its business.
   */
  const flush = useCallback(() => {
    const text = `${pending.current} ${live.current}`.trim();
    pending.current = "";
    live.current = "";
    setCaption("");
    // These words are spent, settled or not. Without this the engine's
    // eventual final still carries the ones just sent, and they go out again.
    acceptRef.current();
    if (text.length >= MIN_CHARS) utteranceRef.current(text);
  }, []);

  /** Restart the quiet-for-long-enough clock. Talking keeps resetting it. */
  const schedule = useCallback((quiet: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, quiet);
  }, [flush]);

  const onPhrase = useCallback((phrase: string) => {
    pending.current = `${pending.current} ${phrase}`.trim();
    // Settled, so it is no longer in flight -- keeping both would say it twice.
    live.current = "";
    setCaption(pending.current);
    schedule(SETTLE_MS);
  }, [schedule]);

  const dictation = useDictation({ onPhrase, continuous: true });
  const { start, stop, listening, interim, error, level, supported } = dictation;
  acceptRef.current = dictation.accept;

  // Show the words forming, not just the ones that have landed -- and count
  // them as something to send, since they may be all we ever get.
  useEffect(() => {
    if (!interim) return;
    live.current = interim;
    setCaption(`${pending.current} ${interim}`.trim());
    schedule(UNSETTLED_MS);
  }, [interim, schedule]);

  // Hold the microphone shut while the agent has the floor, and take it back
  // the moment it stops.
  useEffect(() => {
    if (disabled || !supported) return;
    if (agentSpeaking) stop();
    else start();
  }, [agentSpeaking, disabled, supported, start, stop]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const state: State = !supported || error
    ? "blocked"
    : agentSpeaking
      ? "speaking"
      : agentWorking ? "thinking" : "listening";

  return (
    <div
      className={`live-bar ${listening ? "is-hearing" : ""}`}
      data-state={state}
      style={{ "--level": listening ? level : 0 } as React.CSSProperties}
      role="region"
      aria-label="Live voice chat"
    >
      <button
        type="button"
        className="live-orb"
        onClick={() => { if (agentSpeaking) onInterrupt(); }}
        aria-label={agentSpeaking ? "Interrupt" : HEADING[state]}
      >
        <span className="orb-wash" aria-hidden="true" />
        <span className="orb-ring ring-1" aria-hidden="true" />
        <span className="orb-ring ring-2" aria-hidden="true" />
        <span className="orb-core" aria-hidden="true" />
      </button>

      <div className="live-mid">
        <span className="live-state">
          {HEADING[state]}
          <em className="live-pips" aria-hidden="true"><i /><i /><i /></em>
        </span>
        {/* Polite: the caption rewrites itself several times a second, and an
            assertive region would read every revision over the top of itself. */}
        <span className="live-caption" aria-live="polite">
          {error ?? caption ?? ""}
          {!error && !caption && <em className="live-hint">{HINT[state]}</em>}
        </span>
      </div>

      <span className="live-eq" aria-hidden="true">
        <i /><i /><i /><i /><i />
      </span>

      <button
        type="button"
        className="btn ghost live-end"
        onClick={onExit}
        title="End live chat"
        aria-label="End live chat"
      >
        <IconX size={14} />
        <span className="live-end-word">End</span>
      </button>
    </div>
  );
}
