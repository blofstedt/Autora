import { useCallback, useEffect, useRef } from "react";
import { useDictation } from "../lib/voice";
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
 * microphone.
 */
export function DictateButton({
  onText, disabled,
}: {
  /** A settled phrase, to append to whatever is already typed. */
  onText: (text: string) => void;
  disabled?: boolean;
}) {
  const textRef = useRef(onText);
  textRef.current = onText;

  const dictation = useDictation({
    meter: true,
    onPhrase: useCallback((phrase: string) => textRef.current(phrase), []),
  });

  const { listening, stop } = dictation;
  // A composer that has gone read-only mid-phrase should not keep the mic open.
  useEffect(() => {
    if (disabled && listening) stop();
  }, [disabled, listening, stop]);

  if (!dictation.supported) return null;

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
