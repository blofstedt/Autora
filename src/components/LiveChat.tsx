import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useDictation } from "../lib/voice";
import { AutoraMark } from "./AutoraMark";
import { IconStop, IconX } from "./Icons";

/** Single stray syllables are usually the room, not a request. */
const MIN_CHARS = 2;

/** How long after you let go to wait for the engine to settle the last words
    before sending what it had. Chrome on Android may never settle them. */
const RELEASE_GRACE_MS = 1200;

/**
 * Live voice, in place of the composer.
 *
 * The screen above does not change: the same thread, the same stage, the same
 * steps scrolling past. Only the strip you would normally type into becomes
 * the conversation -- which is the whole point, because the reason to talk to
 * this thing is to watch it work while your hands are somewhere else.
 *
 * Autora answers out loud, and you talk by holding the mark: press and hold,
 * speak, let go, and it goes. The microphone used to stay open between turns
 * and decide for itself when you had finished, which meant it kept chiming on
 * and off around the agent's voice and sent whatever the room said. Holding is
 * unambiguous: nothing is heard unless you are pressing, and pressing cuts the
 * agent off -- its voice stops at once, and what you say interrupts the turn
 * in flight, the same as typing while it works.
 */
export function LiveChat({
  onUtterance,
  onExit,
  onInterrupt,
  onStop,
  agentSpeaking,
  agentWorking,
  agentDoing,
  disabled,
}: {
  onUtterance: (text: string) => void;
  onExit?: () => void;
  /** Stop the agent talking, for barge-in. */
  onInterrupt?: () => void;
  /** Stop the agent's turn. */
  onStop?: () => void;
  agentSpeaking: boolean;
  agentWorking?: boolean;
  /** What it is on, in a few words, when it is working. */
  agentDoing?: string | null;
  disabled?: boolean;
}) {
  /** Phrases the engine has committed to. */
  const pending = useRef("");
  /** The phrase still forming, which may never be committed to at all. */
  const live = useRef("");
  /** Set between letting go and sending, while the last words settle. */
  const releasing = useRef(false);
  const graceTimer = useRef(0);
  const utteranceRef = useRef(onUtterance);
  utteranceRef.current = onUtterance;

  /** Set once the hook below exists; sending unsettled words is only half the
      job without it -- see `accept` in lib/voice. */
  const acceptRef = useRef<() => void>(() => {});
  /** What will go out when you let go, shown so you can see it forming. */
  const [heard, setHeard] = useState("");
  const [holding, setHolding] = useState(false);

  /** Send what we have, settled or not. */
  const flush = useCallback(() => {
    window.clearTimeout(graceTimer.current);
    releasing.current = false;
    const text = `${pending.current} ${live.current}`.trim();
    pending.current = "";
    live.current = "";
    setHeard("");
    // These words are spent, settled or not. Without this the engine's
    // eventual final still carries the ones just sent, and they go out again.
    acceptRef.current();
    if (text.length >= MIN_CHARS) {
      utteranceRef.current(text);
    }
  }, []);

  const onPhrase = useCallback((phrase: string) => {
    pending.current = `${pending.current} ${phrase}`.trim();
    // Settled, so it is no longer in flight -- keeping both would say it twice.
    live.current = "";
    setHeard(pending.current);
  }, []);

  const dictation = useDictation({ onPhrase, continuous: true });
  const { start, stop, interim, supported, listening, error } = dictation;
  acceptRef.current = dictation.accept;

  // Show the words forming as interim results stream in.
  useEffect(() => {
    if (!interim) return;
    live.current = interim;
    setHeard(`${pending.current} ${interim}`.trim());
  }, [interim]);

  // Once the engine has closed after you let go, everything it was going to
  // settle has settled: send it now rather than waiting out the grace.
  useEffect(() => {
    if (!listening && releasing.current) flush();
  }, [listening, flush]);

  const press = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (disabled || !supported || event.button > 0) return;
    event.preventDefault();
    // Keep the release even if the finger slides off the mark.
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* not supported */ }
    // Still settling the last thing you said: send it before starting again.
    if (releasing.current) flush();
    onInterrupt?.();
    setHolding(true);
    start();
  }, [disabled, supported, flush, onInterrupt, start]);

  const release = useCallback(() => {
    if (!holding) return;
    setHolding(false);
    releasing.current = true;
    stop();
    window.clearTimeout(graceTimer.current);
    graceTimer.current = window.setTimeout(flush, RELEASE_GRACE_MS);
  }, [holding, stop, flush]);

  // Losing the page (or live mode going read-only) mid-hold is a release.
  useEffect(() => {
    if (disabled && holding) release();
  }, [disabled, holding, release]);

  useEffect(() => () => {
    window.clearTimeout(graceTimer.current);
  }, []);

  const hint = "Hold the mark to talk.";
  const status = error
    ? `Microphone trouble: ${error}`
    : heard
      ? heard
      : holding
        ? listening ? "Listening… let go to send." : "Starting the microphone…"
        : agentSpeaking
          ? `Autora is speaking. ${hint}`
          : agentWorking
            ? `${agentDoing || "Autora is working"}. ${hint}`
            : hint;

  const lit = holding || agentSpeaking;

  // The strip you would type into becomes the live bar: it says live mode is
  // on, shows the words as they form, and is the way back out.
  return (
    <div className="live-bar" role="group" aria-label="Live voice chat">
      <button
        type="button"
        className={`mob-live-btn live-bar-orb is-${lit ? "working" : "live"} ${holding ? "is-holding" : ""}`}
        onPointerDown={press}
        onPointerUp={release}
        onPointerCancel={release}
        onContextMenu={(event) => event.preventDefault()}
        disabled={disabled || !supported}
        title="Hold to talk"
        aria-label="Hold to talk"
        aria-pressed={holding}
      >
        <span className="mob-live-glow" aria-hidden="true" />
        <AutoraMark state={lit ? "working" : "live"} size={23} />
      </button>
      <div className="live-bar-text">
        <span className="live-bar-label"><span className="live-bar-dot" />Live</span>
        <span className={`live-bar-status ${heard ? "is-heard" : ""}`} aria-live="polite">
          {status}
        </span>
      </div>
      {agentWorking && onStop && (
        <button
          type="button"
          className="composer-stop"
          onClick={onStop}
          title="Stop the agent"
          aria-label="Stop the agent"
        >
          <IconStop size={14} />
        </button>
      )}
      <button
        type="button"
        className="btn live-bar-end"
        onClick={onExit}
        title="End live voice chat (v)"
        aria-label="End live voice chat"
      >
        <IconX size={14} /> End
      </button>
    </div>
  );
}
