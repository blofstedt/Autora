import { useCallback, useEffect, useRef } from "react";
import { recognitionAvailable, secureOrigin, useDictation } from "../lib/voice";
import { IconMic } from "./Icons";

/**
 * Dictation for the composer: hold a thought, speak it, send it yourself.
 *
 * Deliberately not the live conversation. This one only fills the box -- what
 * you said is still text you can read, fix and think better of before it goes
 * anywhere, which is the right default when the agent's next move might be to
 * run something. Live chat is the other button.
 *
 * It renders nothing at all where the browser has no recognition engine, on
 * the grounds that a microphone that cannot hear you is worse than no
 * microphone. An http page is not that case: the engine is right there and
 * only the origin is wrong, so the button stays, disabled, and says so. It
 * having silently vanished is what made voice look unbuilt rather than one
 * redirect away.
 */
export function DictateButton({
  onText, disabled, onBlocked, onTrouble,
}: {
  /** A settled phrase, to append to whatever is already typed. */
  onText: (text: string) => void;
  disabled?: boolean;
  /** Tapped on an insecure page, where there is a microphone but no permission
      to open it. The composer knows where the secure page is; this does not. */
  onBlocked?: () => void;
  /** Said out loud rather than parked in a `title` nobody on a phone can
      hover. A microphone that fails silently is indistinguishable from one
      that was never built, which is how this went unnoticed. */
  onTrouble?: (message: string) => void;
}) {
  const textRef = useRef(onText);
  textRef.current = onText;

  const dictation = useDictation({
    meter: true,
    onPhrase: useCallback((phrase: string) => textRef.current(phrase), []),
  });

  const { listening, stop, error } = dictation;
  const troubleRef = useRef(onTrouble);
  troubleRef.current = onTrouble;
  useEffect(() => {
    if (error) troubleRef.current?.(error);
  }, [error]);
  // A composer that has gone read-only mid-phrase should not keep the mic open.
  useEffect(() => {
    if (disabled && listening) stop();
  }, [disabled, listening, stop]);

  if (!recognitionAvailable) return null;

  if (!secureOrigin) {
    const why = "Dictation needs an https page — tap to see why";
    return (
      <button
        type="button"
        className="btn icon ghost mic-btn is-blocked"
        onClick={onBlocked}
        disabled={disabled || !onBlocked}
        title={why}
        aria-label={why}
      >
        <IconMic size={15} />
      </button>
    );
  }

  const title = dictation.error ?? (listening ? "Stop dictating" : "Dictate");

  return (
    <button
      type="button"
      className={`btn icon ghost mic-btn ${listening ? "on" : ""}${
        dictation.error ? " has-error" : ""}`}
      onClick={dictation.toggle}
      disabled={disabled}
      title={title}
      aria-label={title}
      aria-pressed={listening}
      // The ring tracks the voice, so it is visibly listening to *you* rather
      // than merely animating.
      style={listening ? ({ "--level": dictation.level } as React.CSSProperties) : undefined}
    >
      <span className="mic-halo" aria-hidden="true" />
      <IconMic size={15} />
    </button>
  );
}
