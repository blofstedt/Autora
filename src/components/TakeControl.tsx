import { holdSurface } from "../lib/collab";
import { IconHand } from "./Icons";

/**
 * The window's hand-over switch: work on the document yourself while the agent carries on elsewhere, or hand it back.
 * A labelled pill in a desktop's bar; on a phone, where the bar has room for the name and three controls, one round
 * hand button that lights while the document is the person's (the same `holdSurface`, the same state).
 */
export function TakeControl({ sessionId, surface, mine, phone, thing }: {
  sessionId: string;
  surface: "pdf" | "video" | "office";
  mine: boolean;
  phone: boolean;
  thing: string;
}) {
  const title = mine ? `Let the agent work on the ${thing} again` : `Work on the ${thing} yourself; the agent carries on with other work`;
  const flip = () => void holdSurface(sessionId, surface, !mine);
  if (phone) {
    return (
      <button className={`btn icon ghost pdf-hold-btn${mine ? " is-on" : ""}`} onClick={flip} aria-pressed={mine} title={title} aria-label={mine ? "Hand back" : "Take control"}>
        <IconHand size={16} />
      </button>
    );
  }
  return (
    <button className={`pdf-pill${mine ? " is-accept" : ""}`} onClick={flip} aria-pressed={mine} title={title}>
      {mine ? "Hand back" : "Take control"}
    </button>
  );
}
