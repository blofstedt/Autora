import { useCallback, useEffect, useRef } from "react";
import { useDictation } from "../lib/voice";

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
  onExit: _onExit,
  onInterrupt: _onInterrupt,
  agentSpeaking,
  agentWorking: _agentWorking,
  disabled,
  onSpeakingChange,
}: {
  onUtterance: (text: string) => void;
  onExit?: () => void;
  /** Stop the agent talking, for barge-in. */
  onInterrupt?: () => void;
  agentSpeaking: boolean;
  agentWorking?: boolean;
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

  const markSpeaking = useCallback(() => {
    speakingCbRef.current?.(true);
    window.clearTimeout(speakingTimer.current);
    speakingTimer.current = window.setTimeout(() => {
      speakingCbRef.current?.(false);
    }, 850);
  }, []);

  /**
   * Send what we have, settled or not.
   */
  const flush = useCallback(() => {
    const text = `${pending.current} ${live.current}`.trim();
    pending.current = "";
    live.current = "";
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
    schedule(SETTLE_MS);
  }, [schedule, markSpeaking]);

  const dictation = useDictation({ onPhrase, continuous: true });
  const { start, stop, interim, level, supported } = dictation;
  acceptRef.current = dictation.accept;

  // Show the words forming and mark speech active as interim results stream in
  useEffect(() => {
    if (!interim) return;
    markSpeaking();
    live.current = interim;
    schedule(UNSETTLED_MS);
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

  // Headless voice coordinator: no separate popup bubble renders.
  // The bottom-middle live button is the indicator of live mode.
  return null;
}
