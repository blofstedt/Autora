/**
 * What each corner of the conversation holds.
 *
 * Four corners, and a corner is a row: the corner's name, what is on it now,
 * and -- opened -- the nine widgets that could be, as tiles wearing the same
 * glyph they will wear in the corner itself. Picking one closes the row.
 *
 * It was four native <select>s, and the option text carried each widget's
 * sentence ("Schedules — What is running, and what is next") because a menu
 * has nowhere else to put it. A system menu dropping over the panel looked
 * like nothing else in Settings, so this is drawn the way the appearance tab
 * draws every other choice: rows and tiles, the chosen one in the accent, and
 * the sentence on the tile's hover.
 *
 * Why not a modal of its own: the settings panel already scrolls, and a
 * floating panel near the bottom of it has nowhere to go. The row the pick is
 * made from is the row the answer appears on.
 */
import { useState } from "react";
import {
  DOCK_SLOTS, DOCK_WIDGETS, type DockConfig, type DockSlot, type DockWidgetId,
} from "../lib/theme";
import { dockIcon, dockLabel } from "./Dock";
import { IconChevron, IconMinus } from "./Icons";

/** Nothing pinned, drawn rather than spelled. */
const Dash = <IconMinus size={13} />;

export function DockPicker({
  dock, onPick,
}: {
  dock: DockConfig;
  onPick: (slot: DockSlot, id: DockWidgetId) => void;
}) {
  const [open, setOpen] = useState<DockSlot | null>(null);
  return (
    <div className="sm-dock">
      {DOCK_SLOTS.map((slot) => {
        const pick = dock[slot.id];
        const shown = open === slot.id;
        return (
          <div key={slot.id} className={`sm-dock-row ${shown ? "is-open" : ""}`}>
            <button
              type="button"
              className="sm-dock-head"
              onClick={() => setOpen(shown ? null : slot.id)}
              aria-expanded={shown}
              aria-label={`${slot.label}: ${dockLabel(pick)}. Pick a widget.`}
            >
              <span className="sm-dock-label">{slot.label}</span>
              <span className="sm-dock-pick">
                <span className="sm-dock-ico">{dockIcon(pick) ?? Dash}</span>
                <span className="sm-dock-name">{dockLabel(pick)}</span>
              </span>
              <IconChevron size={12} />
            </button>
            {shown && (
              <div className="sm-dock-grid" role="group" aria-label={`${slot.label} widget`}>
                {DOCK_WIDGETS.map((w) => {
                  const on = pick === w.id;
                  return (
                    <button
                      key={w.id}
                      type="button"
                      className={`sm-dock-w ${on ? "on" : ""}`}
                      onClick={() => { onPick(slot.id, w.id); setOpen(null); }}
                      aria-pressed={on}
                      title={w.hint}
                    >
                      <span className="sm-dock-ico">{dockIcon(w.id) ?? Dash}</span>
                      <span className="sm-dock-name">{w.label}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
