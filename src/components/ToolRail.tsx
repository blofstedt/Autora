import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { usePins, type RailTool } from "../lib/toolrail";
import { IconGrid, IconPin, IconX } from "./Icons";

const BTN = { phone: 40, desktop: 44 };
const GAP = { phone: 2, desktop: 4 };
const PAD = 8;

/**
 * The one tool bar (docs/TOOL-RAIL.md). A vertical pill down the right of the window on a desktop, a dock along the
 * bottom on a phone. It shows only as many tools as fit the room its window has, measured, and never scrolls; the grid
 * button is always last, and opens every tool in a modal in the middle of the screen. On a desktop each tile has a pin
 * (what the bar shows is the person's choice); a phone has no pins, just the app's default tools.
 *
 * The window puts the rail in a box with `position: relative` and the class `has-rail` (see the `.rail-*` rules in
 * styles.css), which keeps room for it so it never covers the canvas.
 */
export function ToolRail({
  app, tools, phone, extra, hint,
}: {
  app: string;
  tools: RailTool[];
  phone: boolean;
  /** More for the grid after the tools, such as things to ask Autora. */
  extra?: (close: () => void) => ReactNode;
  /** The line under the grid's title. */
  hint?: string;
}) {
  const bar = useRef<HTMLElement>(null);
  const [room, setRoom] = useState(99);
  const [grid, setGrid] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const pins = usePins(app, tools);
  const byId = new Map(tools.map((t) => [t.id, t]));
  const ids = phone ? tools.filter((t) => t.phone).map((t) => t.id) : pins.pins.filter((id) => byId.has(id));
  const kind = phone ? "phone" : "desktop";

  // The window's own size is the room: height on a desktop (the bar is a column), width on a phone (a row).
  useLayoutEffect(() => {
    const host = bar.current?.parentElement;
    if (!host) return;
    const measure = () => {
      const space = phone ? host.clientWidth : host.clientHeight - 80;
      const slots = Math.floor((space - 2 * PAD - 12 + GAP[kind]) / (BTN[kind] + GAP[kind])) - 1;
      setRoom(Math.max(1, slots));
    };
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(host);
    return () => watch.disconnect();
  }, [phone, kind]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (!grid) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setGrid(false); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [grid]);

  const style = (t: RailTool) => ({ "--tc": t.color }) as CSSProperties;
  const groups: string[] = [];
  for (const t of tools) if (!groups.includes(t.group)) groups.push(t.group);
  const press = (t: RailTool) => { setGrid(false); t.run(); };

  return (
    <>
      <nav ref={bar} className={`rail-bar is-${kind}`} aria-label={`${app} tools`}>
        {ids.slice(0, room).map((id) => {
          const t = byId.get(id)!;
          return (
            <button
              key={id} type="button" className={`rail-btn${t.on ? " is-on" : ""}`} style={style(t)}
              aria-label={t.label} aria-pressed={t.on ?? undefined} title={t.about ? `${t.label}: ${t.about}` : t.label}
              disabled={t.disabled} onPointerDown={(e) => e.preventDefault()} onClick={() => press(t)}
            >
              {t.icon}
            </button>
          );
        })}
        <i className="rail-div" aria-hidden="true" />
        <button type="button" className="rail-btn is-grid" aria-label="All tools" aria-haspopup="dialog" title="All tools" onPointerDown={(e) => e.preventDefault()} onClick={() => setGrid(true)}>
          <IconGrid size={18} />
        </button>
      </nav>

      {grid && createPortal(
        <div className="rail-scrim" onClick={() => setGrid(false)} role="presentation">
          <div className={`rail-grid is-${kind}`} role="dialog" aria-modal="true" aria-label="All tools" onClick={(e) => e.stopPropagation()}>
            <div className="rail-grid-head">
              <h3>All tools</h3>
              <div className="spacer" />
              {!phone && <button type="button" className="rail-reset" onClick={pins.reset}>Reset bar</button>}
              <button type="button" className="rail-x" aria-label="Close" onClick={() => setGrid(false)}><IconX size={16} /></button>
            </div>
            <p className="rail-grid-hint">
              {toast ?? hint ?? (phone ? "Tap a tool to use it." : `Pin the tools you use most to your bar. It has room for ${room} at this window size (${ids.length} pinned).`)}
            </p>
            {groups.map((g) => (
              <section key={g}>
                <h4>{g}</h4>
                <div className="rail-tiles">
                  {tools.filter((t) => t.group === g).map((t) => {
                    const pinned = ids.includes(t.id);
                    return (
                      <div key={t.id} className="rail-tile-wrap" style={style(t)}>
                        <button type="button" className={`rail-tile${t.on ? " is-on" : ""}`} disabled={t.disabled} title={t.about} onClick={() => press(t)}>
                          {t.icon}
                          <span>{t.label}</span>
                        </button>
                        {!phone && (
                          <button
                            type="button" className={`rail-pin${pinned ? " is-pinned" : ""}`}
                            aria-label={`${pinned ? "Unpin" : "Pin"} ${t.label} ${pinned ? "from" : "to"} the bar`} aria-pressed={pinned}
                            onClick={() => { if (pins.toggle(t.id, room) === "full") setToast("The bar is full. Unpin a tool first."); }}
                          >
                            <IconPin size={11} />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
            {extra?.(() => setGrid(false))}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

/** The open tool's options: a card beside the bar on a desktop, one row above the dock on a phone. In the tool's colour. */
export function RailTray({
  tool, onClose, children, hint,
}: {
  tool: RailTool;
  onClose: () => void;
  children: ReactNode;
  /** One short line, only where the tool needs it. */
  hint?: string;
}) {
  return (
    <section className="rail-tray" style={{ "--tc": tool.color } as CSSProperties} aria-label={`${tool.label} options`}>
      <span className="rail-tray-head">
        <span className="rail-tray-icon" aria-hidden="true">{tool.icon}</span>
        <b className="rail-tray-title">{tool.label}</b>
      </span>
      <div className="rail-tray-body">{children}</div>
      {hint && <p className="rail-tray-hint">{hint}</p>}
      <button type="button" className="rail-x rail-tray-x" aria-label="Close options" onPointerDown={(e) => e.preventDefault()} onClick={onClose}><IconX size={14} /></button>
    </section>
  );
}
