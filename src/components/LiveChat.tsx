import { useCallback, useEffect, useRef, useState } from "react";
import { turnPause, useDictation } from "../lib/voice";
import { AutoraMark } from "./AutoraMark";
import { IconStop, IconX } from "./Icons";

/** Single stray syllables are usually the room, not a request. */
const MIN_CHARS = 2;

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
  onUtterance,
  onExit,
  onInterrupt,
  onStop,
  agentSpeaking,
  agentWorking,
  agentDoing,
  disabled,
  onSpeakingChange,
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
  /** Report when the user is actively speaking in live mode. */
  onSpeakingChange?: (speaking: boolean) => void;
}) {
  /** Phrases the engine has committed to. */
  const pending = useRef("");
  /** The phrase still forming, which may never be committed to at all. */
  const live = useRef("");
  const timer = useRef(0);
  const speakingTimer = useRef<number>(0);
  const utteranceRef = useRef(onUtterance);
  utteranceRef.current = onUtterance;
  const speakingCbRef = useRef(onSpeakingChange);
  speakingCbRef.current = onSpeakingChange;

  /** Set once the hook below exists; sending unsettled words is only half the
      job without it -- see `accept` in lib/voice. */
  const acceptRef = useRef<() => void>(() => {});
  /** What will go out when you stop talking, shown so you can see it forming. */
  const [heard, setHeard] = useState("");
  const [userSpeaking, setUserSpeaking] = useState(false);

  const markSpeaking = useCallback(() => {
    speakingCbRef.current?.(true);
    setUserSpeaking(true);
    window.clearTimeout(speakingTimer.current);
    speakingTimer.current = window.setTimeout(() => {
      speakingCbRef.current?.(false);
      setUserSpeaking(false);
    }, 850);
  }, []);

  /**
   * Send what we have, settled or not.
   */
  const flush = useCallback(() => {
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

  /** Restart the quiet-for-long-enough clock. Talking keeps resetting it. */
  const schedule = useCallback((quiet: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, quiet);
  }, [flush]);

  const onPhrase = useCallback((phrase: string) => {
    markSpeaking();
    pending.current = `${pending.current} ${phrase}`.trim();
    // Settled, so it is no longer in flight -- keeping both would say it twice.
    live.current = "";
    setHeard(pending.current);
    schedule(turnPause(pending.current, true));
  }, [schedule, markSpeaking]);

  const dictation = useDictation({ onPhrase, continuous: true });
  const { start, stop, interim, level, supported, listening, error } = dictation;
  acceptRef.current = dictation.accept;

  // Show the words forming and mark speech active as interim results stream in
  useEffect(() => {
    if (!interim) return;
    markSpeaking();
    live.current = interim;
    const text = `${pending.current} ${interim}`.trim();
    setHeard(text);
    schedule(turnPause(text, false));
  }, [interim, schedule, markSpeaking]);

  // Audio loudness level detection
  useEffect(() => {
    if (level > 0.12) {
      markSpeaking();
    }
  }, [level, markSpeaking]);

  // Hold the microphone shut while the agent has the floor, and take it back
  // the moment it stops.
  useEffect(() => {
    if (disabled || !supported) return;
    if (agentSpeaking) stop();
    else start();
  }, [agentSpeaking, disabled, supported, start, stop]);

  useEffect(() => () => {
    window.clearTimeout(timer.current);
    window.clearTimeout(speakingTimer.current);
    speakingCbRef.current?.(false);
  }, []);

  const status = error
    ? `Microphone trouble: ${error}`
    : heard
      ? heard
      : agentSpeaking
        ? "Autora is speaking. Tap the mark to cut in."
        : agentWorking
          ? `${agentDoing || "Autora is working"}. Listening…`
          : listening
            ? "Listening…"
            : "Starting the microphone…";

  // The strip you would type into becomes the live bar: it says live mode is
  // on, shows the words as they form, and is the way back out.
  return (
    <div className="live-bar" role="group" aria-label="Live voice chat">
      <button
        type="button"
        className={`mob-live-btn live-bar-orb is-${userSpeaking || agentSpeaking ? "working" : "live"}`}
        onClick={agentSpeaking ? onInterrupt : undefined}
        title={agentSpeaking ? "Cut in" : "Live voice is on"}
        aria-label={agentSpeaking ? "Cut in" : "Live voice is on"}
      >
        <span className="mob-live-glow" aria-hidden="true" />
        <AutoraMark state={userSpeaking || agentSpeaking ? "working" : "live"} size={23} />
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
