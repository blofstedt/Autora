import type { Command } from "../lib/commands";

/**
 * The commands a draft starting with "/" could be, above the box.
 *
 * Arrow keys move, Enter or Tab picks, Escape puts it away; the keys are
 * handled by the box, since that is where focus stays.
 */
export function SlashMenu({
  commands, active, onPick, onHover,
}: {
  commands: Command[];
  active: number;
  onPick: (command: Command) => void;
  onHover: (index: number) => void;
}) {
  if (commands.length === 0) return null;
  return (
    <div className="slash-menu" role="listbox" aria-label="Commands">
      {commands.map((c, index) => (
        <button
          key={c.id}
          type="button"
          role="option"
          aria-selected={index === active}
          className={`slash-item ${index === active ? "on" : ""}`}
          // Keep focus in the box: a mousedown on a button would take it.
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => onHover(index)}
          onClick={() => onPick(c)}
        >
          <span className="slash-name">/{c.name}{c.arg && <em> {c.arg}</em>}</span>
          <span className="slash-hint">{c.hint}</span>
        </button>
      ))}
    </div>
  );
}
