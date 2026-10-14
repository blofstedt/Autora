import type { Mentionable } from "../lib/mentions";

/**
 * The agents an "@" in the box could mean, above it. Arrow keys move, Enter or Tab picks, Escape puts it away;
 * the keys are handled by the box, since that is where focus stays. Looks like the slash menu on purpose.
 */
export function MentionMenu({
  agents, active, onPick, onHover,
}: {
  agents: Mentionable[];
  active: number;
  onPick: (agent: Mentionable) => void;
  onHover: (index: number) => void;
}) {
  if (agents.length === 0) return null;
  return (
    <div className="slash-menu" role="listbox" aria-label="Agents">
      {agents.map((a, index) => (
        <button
          key={a.id}
          type="button"
          role="option"
          aria-selected={index === active}
          className={`slash-item ${index === active ? "on" : ""}`}
          // Keep focus in the box: a mousedown on a button would take it.
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => onHover(index)}
          onClick={() => onPick(a)}
        >
          <span className="slash-name">@{a.name}</span>
          <span className="slash-hint">{a.role}</span>
        </button>
      ))}
    </div>
  );
}
