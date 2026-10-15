import { useAgentCursor } from "../lib/agentCursor";
import { IconEye, IconEyeOff } from "./Icons";

/**
 * Visible work, beside Follow: on, the agent is seen working -- its cursor travels, clicks and types in each window;
 * off, it works at speed and things simply change, with no cursor and no typing to watch. The same switch as
 * Settings -> Working together (lib/agentCursor.ts), so the two always agree.
 *
 * `compact` drops the word for the phone's tight bars: the eye alone, with the words for a screen reader and a hover.
 */
export function VisibleWork({ className, compact = false }: { className: string; compact?: boolean }) {
  const [on, setOn] = useAgentCursor();
  const title = on
    ? "Visible work: you see the agent's cursor click and type. Click to let it work at speed instead"
    : "Working at speed: no cursor, the changes just land. Click to watch the agent work";
  return (
    <button
      type="button"
      className={`${className} visible-work${on ? " is-on" : ""}${compact ? " is-compact" : ""}`}
      onClick={() => setOn(!on)}
      aria-pressed={on}
      aria-label="Visible work"
      title={title}
    >
      {on ? <IconEye size={14} /> : <IconEyeOff size={14} />}
      {!compact && <span>Visible</span>}
    </button>
  );
}
