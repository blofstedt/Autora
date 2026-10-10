/**
 * The PDF editor's interface: one floating tool bar, the one SecurePDF and Autora 3D share (docs/TOOL-RAIL.md).
 *
 * Spectra's own window is a desktop application (menu bar, toolbar, tabs, a tool dock with thirty tools). This replaces that
 * chrome entirely, on a phone and on a desktop, with the same parts:
 *
 *   - a bar of round, coloured tool buttons: along the bottom on a phone, down the right side on a desktop. It shows as many
 *     tools as fit and never scrolls; the grid button is always last. A phone shows the default tools; a desktop shows the
 *     ones the person pinned (and has room for many more);
 *   - the grid: every tool the editor has, in a modal in the middle of the screen, each tile in its tool's colour. On a
 *     desktop each tile has a pin, to choose what the bar shows;
 *   - a tray for the open tool: one row above the bar on a phone, a card beside the bar on a desktop. Three colours, a colour
 *     wheel and a thickness slider for Highlight, Draw and Shapes, colours for Text, Note and Callout; Redact has what a tap takes;
 *   - a slim bar along the top: the menu (what the menu bar held), Undo, Redo and Find.
 *
 * Nothing here is a second implementation. Every button calls Spectra's own command (`invokeCommand`), the colour and
 * thickness go through `renderer/autora-style.ts` into the canvas Spectra already draws, and a tool that has no tray of its
 * own (Stamp, Measure...) keeps Spectra's own strip, restyled by `autora.css`. The agent has every tool whatever is shown.
 *
 * Mounted by `installRail()` in every window of the editor; `?phone=1` (from components/SpectraWindow.tsx) picks the phone's
 * arrangement.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { getCommandContext, invokeCommand, isCommandEnabled } from "../renderer/commands/context";
import { availableMenus, type MenuNode } from "../renderer/commands/menus";
import { COMMANDS, type CommandId } from "../renderer/commands/registry";
import { tCommandTitle } from "../renderer/i18n";
import { getAutoraDetect, setAutoraColor, setAutoraDetect, setAutoraWidth, type Detect, type WidthMode } from "../renderer/autora-style";
import { DESKTOP_DEFAULT, GRID, ICONS, PHONE_DEFAULT, TOOLS, type Tile } from "./rail-tools";

/** Whether this frame was opened as the phone's. Read once: a window does not change its mind. */
export const isPhone = (): boolean => new URLSearchParams(location.search).get("phone") === "1";
const PHONE = isPhone();

/* ------------------------------------------------------------------ icons */

function Icon({ name, size = 20 }: { name: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: ICONS[name] ?? ICONS.grid }} />
  );
}

/* ------------------------------------------------------- what is open now */

interface Open {
  /** The armed canvas mode (`select` when none). */
  mode: string;
  /** The open tool (Comment, Redact, Protect...), or null. */
  tool: string | null;
  /** Sign is up: Spectra's stamp mode with only the signatures showing (see the `autora-signing` rules in autora.css). */
  signing?: boolean;
}

function readOpen(): Open {
  const ui = getCommandContext()?.state.ui;
  return { mode: (ui?.tool as string | undefined) ?? "select", tool: (ui?.activeToolId as string | null | undefined) ?? null };
}

/** The editor's state is not observable from here, but every change of it repaints the DOM: so the DOM is the clock. */
function useOpen(): Open {
  const [open, setOpen] = useState<Open>(readOpen);
  useEffect(() => {
    let frame = 0;
    const read = () => {
      frame = 0;
      const next = readOpen();
      setOpen((prev) => (prev.mode === next.mode && prev.tool === next.tool ? prev : next));
    };
    const poke = () => { if (!frame) frame = requestAnimationFrame(read); };
    poke();
    const watch = new MutationObserver(poke);
    watch.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-pressed", "data-tool", "class"] });
    const timer = window.setInterval(poke, 800);
    return () => { watch.disconnect(); window.clearInterval(timer); if (frame) cancelAnimationFrame(frame); };
  }, []);
  return open;
}

/** Whether a tile's tool or mode is the one open. */
const isOn = (t: Tile, open: Open): boolean => (t.id === "sign" ? !!open.signing : t.id === "stamp" ? open.mode === "stamp" && !open.signing : t.mode ? open.mode === t.mode : t.tool ? open.tool === t.tool && open.mode === "select" : t.id === "select" && open.mode === "select" && open.tool === null);

/** A tile's own command; the Select button puts the open tool away. */
const commandOf = (t: Tile): CommandId => (t.id === "sign" ? "tools.stamp" : t.id === "select" ? "tools.close" : t.command ?? (t.mode ? (`tools.${t.mode}` as CommandId) : (`tools.open.${t.tool}` as CommandId)));

/* ------------------------------------------------------------------ pins */

const PINS_KEY = "autora-pdf-pins";

/** What a desktop's bar shows, in order. A phone never reads this: its bar is the defaults. */
function loadPins(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(PINS_KEY) ?? "null") as unknown;
    if (Array.isArray(saved)) return saved.filter((id): id is string => typeof id === "string" && id in TOOLS);
  } catch { /* private window or no storage: the defaults */ }
  return DESKTOP_DEFAULT.slice();
}

function savePins(pins: string[]): void {
  try { localStorage.setItem(PINS_KEY, JSON.stringify(pins)); } catch { /* the bar still works for this session */ }
}

/* ------------------------------------------------------------------- bar */

// A round button on the bar, and what is between buttons; the bar's own padding.
const BTN = PHONE ? 40 : 44;
const GAP = PHONE ? 2 : 4;
const PAD = 8;

/** How many tools fit in the space the window has, grid button and its divider not counted. The bar never scrolls: what does not fit is in the grid. */
function slotsNow(): number {
  const room = PHONE ? window.innerWidth - 2 * PAD - 2 - 7 : window.innerHeight - 40 - 60 - 2 * PAD - 2 - 5;
  return Math.max(1, Math.floor((room + GAP) / (BTN + GAP)) - 1);
}

function useSlots(): number {
  const [slots, setSlots] = useState(slotsNow);
  useEffect(() => {
    const on = () => setSlots(slotsNow());
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return slots;
}

function Bar({ open, slots, ids, onGrid, onPick }: { open: Open; slots: number; ids: string[]; onGrid: () => void; onPick: (t: Tile) => void }) {
  const shown = ids.slice(0, slots).map((id) => TOOLS[id]);
  return (
    <nav className="autora-rail" aria-label="PDF tools" data-testid="phone-bar">
      {shown.map((t) => {
        const on = isOn(t, open);
        return (
          <button
            key={t.id}
            type="button"
            className={`autora-rail-btn${on ? " is-on" : ""}`}
            style={{ ["--tc" as string]: t.color }}
            data-phone={t.id}
            data-tip={t.label}
            aria-label={t.label}
            aria-pressed={on}
            // A tap must not take the page's focus (and the on-screen keyboard) with it.
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => onPick(t)}
          >
            <Icon name={t.icon} size={PHONE ? 21 : 22} />
          </button>
        );
      })}
      <span className="autora-rail-div" />
      <button type="button" className="autora-rail-btn is-grid" data-phone="grid" data-tip="All tools" aria-label="All tools" aria-haspopup="dialog" onPointerDown={(e) => e.preventDefault()} onClick={onGrid}>
        <Icon name="grid" size={PHONE ? 21 : 22} />
      </button>
    </nav>
  );
}

/* ------------------------------------------------------------------ grid */

function Grid({ open, slots, pins, setPins, onClose, onPick, toast }: {
  open: Open; slots: number; pins: string[]; setPins: (p: string[]) => void; onClose: () => void; onPick: (t: Tile) => void; toast: (m: string) => void;
}) {
  const pick = (t: Tile) => {
    onClose();
    onPick(t);
  };
  const togglePin = (id: string) => {
    if (pins.includes(id)) setPins(pins.filter((p) => p !== id));
    else if (pins.length >= slots) toast(`The bar is full (${slots}). Unpin a tool first.`);
    else setPins([...pins, id]);
  };
  return (
    <div className="autora-scrim" onClick={onClose} data-testid="phone-grid-scrim">
      <div className="autora-grid" role="dialog" aria-label="All tools" onClick={(e) => e.stopPropagation()} data-testid="phone-grid">
        <div className="autora-grid-head">
          <h3>All tools</h3>
          <span className="autora-grid-actions">
            {!PHONE && <button type="button" className="autora-reset" data-testid="phone-grid-reset" onClick={() => setPins(DESKTOP_DEFAULT.slice())}>Reset bar</button>}
            <button type="button" className="autora-x" aria-label="Close" data-testid="phone-grid-close" onClick={onClose}><Icon name="x" size={18} /></button>
          </span>
        </div>
        <p className="autora-hint">
          {PHONE ? "Tap a tool to use it." : `Pin the tools you use most to your bar. It has room for ${slots} at this window size (${Math.min(pins.length, slots)} pinned).`}
        </p>
        {GRID.map((g) => (
          <section key={g.title}>
            <h4>{g.title}</h4>
            <div className="autora-tiles">
              {g.ids.map((id) => {
                const t = TOOLS[id];
                const enabled = id === "select" || isCommandEnabled(commandOf(t));
                const pinned = pins.includes(id);
                return (
                  <div key={id} className="autora-cell">
                    <button
                      type="button"
                      className={`autora-tile${isOn(t, open) ? " is-on" : ""}`}
                      style={{ ["--tc" as string]: t.color }}
                      data-tile={id}
                      disabled={!enabled}
                      onClick={() => pick(t)}
                    >
                      <Icon name={t.icon} size={PHONE ? 18 : 22} />
                      <span>{t.label}</span>
                    </button>
                    {!PHONE && (
                      <button
                        type="button"
                        className="autora-pin"
                        style={{ ["--tc" as string]: t.color }}
                        aria-pressed={pinned}
                        data-pin={id}
                        title={pinned ? "Unpin from the bar" : "Pin to the bar"}
                        aria-label={`${pinned ? "Unpin" : "Pin"} ${t.label} ${pinned ? "from" : "to"} the bar`}
                        onClick={() => togglePin(id)}
                      >
                        <Icon name="pin" size={14} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ tray */

/** A tray sits above the bar (phone) or beside it (desktop) and must not cover the editor's own bottom controls (page and zoom, "Redact 2 regions"), so a phone's shell leaves room for it. */
function useReserve() {
  const ref = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !PHONE) return;
    const root = document.documentElement.style;
    const set = () => root.setProperty("--autora-tray-h", `${Math.ceil(el.getBoundingClientRect().height) + 8}px`);
    set();
    const watch = new ResizeObserver(set);
    watch.observe(el);
    return () => { watch.disconnect(); root.removeProperty("--autora-tray-h"); };
  }, []);
  return ref;
}

/** The modes that get a tray, and what each shows. Anything else keeps Spectra's own strip. */
const TRAYS: Record<string, { tool: string; width?: { mode: WidthMode; min: number; max: number; step: number; start: number; label: string }; presets: string[]; start: string; hint?: string }> = {
  highlight: { tool: "highlight", presets: ["#ffd54a", "#2fbf71", "#ff8fc7"], start: "#ffd54a", hint: "Select text to highlight it." },
  inkhighlight: { tool: "inkhighlight", width: { mode: "inkhighlight", min: 6, max: 28, step: 1, start: 14, label: "Thickness" }, presets: ["#ffd54a", "#2fbf71", "#ff8fc7"], start: "#ffd54a", hint: "Drag over anything, text or not." },
  freetext: { tool: "text", presets: ["#e0393e", "#2f6fed", "#16161a"], start: "#16161a", hint: "Drag a box where the text goes, then type." },
  ink: { tool: "draw", width: { mode: "ink", min: 1, max: 12, step: 1, start: 2, label: "Thickness" }, presets: ["#e0393e", "#2f6fed", "#16161a"], start: "#2f6fed" },
  note: { tool: "note", presets: ["#ffd54a", "#e0393e", "#2f6fed"], start: "#ffd54a", hint: "Click the page to drop a note." },
  callout: { tool: "callout", presets: ["#e0393e", "#2f6fed", "#16161a"], start: "#e0393e", hint: "Drag a box for the text; the pointer follows." },
  shape: { tool: "shape", width: { mode: "shape", min: 1, max: 10, step: 1, start: 2, label: "Thickness" }, presets: ["#e0393e", "#2f6fed", "#16161a"], start: "#e0393e" },
};

/** The shapes Spectra draws, in the order the button steps through them. */
const SHAPES = ["rect", "ellipse", "line", "arrow", "polygon", "polyline", "cloud"] as const;
const SHAPE_NAMES: Record<string, string> = { rect: "Box", ellipse: "Circle", line: "Line", arrow: "Arrow", polygon: "Polygon", polyline: "Polyline", cloud: "Cloud" };
const SHAPE_ICONS: Record<string, string> = { rect: "shape", ellipse: "circle", line: "line", arrow: "arrow", polygon: "polygon", polyline: "polyline", cloud: "cloud" };

/** Spectra's own strip holds the current figure; its buttons are in the DOM (hidden) and are the one way to read and set it. */
const shapeNow = (): string => SHAPES.find((s) => document.querySelector(`[data-testid="shape-type-${s}"]`)?.getAttribute("aria-pressed") === "true") ?? "rect";
const setShapeTo = (s: string): void => document.querySelector<HTMLElement>(`[data-testid="shape-type-${s}"]`)?.click();

const remembered: Record<string, string> = {};
const widths: Record<string, number> = {};

function Tray({ mode }: { mode: string }) {
  const spec = TRAYS[mode];
  const tile = TOOLS[spec.tool];
  const [color, setColor] = useState(() => remembered[mode] ?? spec.start);
  const [width, setWidth] = useState(() => (spec.width ? widths[spec.width.mode] ?? spec.width.start : 0));
  const [shape, setShape] = useState(shapeNow);
  const reserve = useReserve();

  // Arming a mode takes the colour (and thickness) this tray last had for it.
  useEffect(() => {
    const c = remembered[mode] ?? spec.start;
    setColor(c);
    setAutoraColor(c);
    if (spec.width) {
      const w = widths[spec.width.mode] ?? spec.width.start;
      setWidth(w);
      setAutoraWidth(spec.width.mode, w);
    }
    if (mode === "shape") setShape(shapeNow());
  }, [mode, spec]);

  const choose = useCallback((c: string) => {
    remembered[mode] = c;
    setColor(c);
    setAutoraColor(c);
  }, [mode]);

  const custom = !spec.presets.includes(color);
  const stepShape = () => {
    const next = SHAPES[(SHAPES.indexOf(shapeNow() as (typeof SHAPES)[number]) + 1) % SHAPES.length];
    setShapeTo(next);
    setShape(next);
  };

  return (
    <section ref={reserve} className="autora-tray" style={{ ["--tc" as string]: tile.color }} data-testid="phone-tray" data-mode={mode} aria-label={`${tile.label} options`}>
      <div className="autora-tray-head">
        {mode === "shape" ? (
          <button type="button" className="autora-cyc" data-testid="phone-shape" aria-label={`Shape: ${SHAPE_NAMES[shape]}. Tap for the next shape`} onPointerDown={(e) => e.preventDefault()} onClick={stepShape}>
            <Icon name={SHAPE_ICONS[shape]} size={20} />
            <span className="autora-rot"><Icon name="cycle" size={10} /></span>
          </button>
        ) : (
          <span className="autora-tray-icon" aria-hidden="true"><Icon name={tile.icon} size={21} /></span>
        )}
        <b className="autora-tray-title">{tile.label}</b>
        <button type="button" className="autora-x autora-tray-x" aria-label="Close options" onPointerDown={(e) => e.preventDefault()} onClick={() => { invokeCommand("tools.close"); }}>
          <Icon name="x" size={18} />
        </button>
      </div>
      {mode === "shape" && (
        <div className="autora-shapes" role="group" aria-label="Shape">
          {SHAPES.map((s) => (
            <button key={s} type="button" aria-pressed={shape === s} title={SHAPE_NAMES[s]} aria-label={SHAPE_NAMES[s]} data-shape={s} onPointerDown={(e) => e.preventDefault()} onClick={() => { setShapeTo(s); setShape(s); }}>
              <Icon name={SHAPE_ICONS[s]} size={18} />
            </button>
          ))}
        </div>
      )}
      <div className="autora-group">
        <div className="autora-lab">Colour</div>
        <div className="autora-sw" role="group" aria-label="Colour">
          {spec.presets.map((c) => (
            <button key={c} type="button" className="autora-swatch" style={{ background: c }} aria-label={`Colour ${c}`} aria-pressed={color === c} onPointerDown={(e) => e.preventDefault()} onClick={() => choose(c)} />
          ))}
          <label className="autora-wheel" aria-pressed={custom} title="More colours">
            <input type="color" value={color} aria-label="Pick any colour" data-testid="phone-wheel" onChange={(e) => choose(e.target.value)} />
            <i style={{ background: custom ? color : "var(--autora-s2)" }} />
          </label>
        </div>
      </div>
      {spec.width && (
        <div className="autora-group autora-group-grow">
          <div className="autora-lab">{spec.width.label}</div>
          <input
            type="range"
            className="autora-range"
            min={spec.width.min}
            max={spec.width.max}
            step={spec.width.step}
            value={width}
            aria-label={spec.width.label}
            data-testid="phone-width"
            onChange={(e) => {
              const w = Number(e.target.value);
              widths[spec.width!.mode] = w;
              setWidth(w);
              setAutoraWidth(spec.width!.mode, w);
            }}
          />
        </div>
      )}
      {spec.hint && <p className="autora-hint autora-lg">{spec.hint}</p>}
    </section>
  );
}

/** Redact's tray: what a tap takes. The marks it makes are Spectra's own pending redactions, with handles on each side. */
function RedactTray() {
  const tile = TOOLS.redact;
  const [detect, setDetect] = useState<Detect>(getAutoraDetect);
  const choose = (d: Detect) => { setDetect(d); setAutoraDetect(d); };
  const reserve = useReserve();
  return (
    <section ref={reserve} className="autora-tray" style={{ ["--tc" as string]: tile.color }} data-testid="phone-tray" data-mode="redact" aria-label="Redact options">
      <div className="autora-tray-head">
        <span className="autora-tray-icon" aria-hidden="true"><Icon name={tile.icon} size={21} /></span>
        <b className="autora-tray-title">Redact</b>
        <button type="button" className="autora-x autora-tray-x" aria-label="Close options" onPointerDown={(e) => e.preventDefault()} onClick={() => { invokeCommand("tools.close"); }}>
          <Icon name="x" size={18} />
        </button>
      </div>
      <div className="autora-group">
        <div className="autora-lab">A {PHONE ? "tap" : "click"} redacts</div>
        <div className="autora-seg" role="group" aria-label="A tap redacts">
          <button type="button" aria-pressed={detect === "word"} data-detect="word" onPointerDown={(e) => e.preventDefault()} onClick={() => choose("word")}>A word</button>
          <button type="button" aria-pressed={detect === "line"} data-detect="line" onPointerDown={(e) => e.preventDefault()} onClick={() => choose("line")}>A line</button>
        </div>
      </div>
      <p className="autora-tray-hint">{PHONE ? "Tap text to redact it. Drag a handle to resize." : "Click text to redact it, or drag over an area. Drag a handle to resize. Nothing leaves the file until you press Redact."}</p>
    </section>
  );
}

/* ------------------------------------------------------------------- top */

/** The menu bar's contents, as a menu: every item is a Spectra command. */
function MenuItems({ nodes, close }: { nodes: MenuNode[]; close: () => void }) {
  const ctx = getCommandContext();
  return (
    <>
      {nodes.map((n, i) => {
        if (n.kind === "separator") return <hr key={i} className="autora-menu-sep" />;
        if (n.kind === "command") {
          const c = COMMANDS[n.command];
          const enabled = isCommandEnabled(n.command);
          return (
            <button key={n.command} type="button" role="menuitem" className="autora-menu-item" disabled={!enabled} onClick={() => { close(); invokeCommand(n.command); }}>
              {tCommandTitle(n.command, c.title)}
            </button>
          );
        }
        if (n.kind === "submenu") {
          return (
            <div key={n.id} className="autora-menu-sub">
              <div className="autora-menu-subtitle">{n.label}</div>
              <MenuItems nodes={n.items} close={close} />
            </div>
          );
        }
        return ctx ? n.build(ctx).map((leaf, j) => (
          <button key={`${n.id}-${j}`} type="button" role="menuitem" className="autora-menu-item" disabled={leaf.disabled} onClick={() => { close(); leaf.run(ctx); }}>
            {leaf.label}
          </button>
        )) : null;
      })}
    </>
  );
}

function Menu({ onClose }: { onClose: () => void }) {
  const menus = useMemo(() => availableMenus(), []);
  const [openId, setOpenId] = useState<string>(() => menus[0]?.id ?? "");
  return (
    <div className="autora-scrim is-clear" onClick={onClose} data-testid="phone-menu-scrim">
      <div className="autora-menu" role="menu" aria-label="Menu" onClick={(e) => e.stopPropagation()} data-testid="phone-menu">
        {menus.map((m) => (
          <section key={m.id} className="autora-menu-section">
            <button type="button" className="autora-menu-head" aria-expanded={openId === m.id} data-menu={m.id} onClick={(e) => { const head = e.currentTarget; setOpenId(openId === m.id ? "" : m.id); window.setTimeout(() => head.scrollIntoView({ block: "nearest" }), 0); }}>
              {m.label}
              <Icon name={openId === m.id ? "up" : "down"} size={16} />
            </button>
            {openId === m.id && <MenuItems nodes={m.items} close={onClose} />}
          </section>
        ))}
      </div>
    </div>
  );
}

function Top({ onMenu }: { onMenu: () => void }) {
  const act = (id: CommandId) => (
    <button
      key={id}
      type="button"
      className="autora-top-btn"
      aria-label={id === "edit.undo" ? "Undo" : id === "edit.redo" ? "Redo" : "Find"}
      data-tip={id === "edit.undo" ? "Undo" : id === "edit.redo" ? "Redo" : "Find"}
      data-phone={id.slice(5)}
      onPointerDown={(e) => e.preventDefault()}
      onClick={() => { invokeCommand(id); }}
    >
      <Icon name={id.slice(5)} size={19} />
    </button>
  );
  return (
    <div className="autora-top" data-testid="phone-top">
      <button type="button" className="autora-top-btn autora-top-menu" aria-label="Menu" aria-haspopup="menu" data-tip="Menu" data-testid="phone-menu-button" onPointerDown={(e) => e.preventDefault()} onClick={onMenu}>
        <Icon name="menu" size={19} />
      </button>
      <span className="autora-top-gap" />
      {(["edit.undo", "edit.redo", "edit.find"] as CommandId[]).map(act)}
    </div>
  );
}

/* ------------------------------------------------------------------ root */

function Toast({ text }: { text: string | null }) {
  return text ? <div className="autora-toast" role="status">{text}</div> : null;
}

function Rail() {
  const raw = useOpen();
  const slots = useSlots();
  const [grid, setGrid] = useState(false);
  const [menu, setMenu] = useState(false);
  const [signing, setSigning] = useState(false);
  const [pins, setPinsState] = useState(loadPins);
  const [toast, setToast] = useState<string | null>(null);
  const setPins = useCallback((p: string[]) => { setPinsState(p); savePins(p); }, []);
  const say = useCallback((m: string) => { setToast(m); window.setTimeout(() => setToast(null), 1800); }, []);
  // Sign is Spectra's stamp mode with only the signatures showing, so it ends when the mode does.
  const open = useMemo<Open>(() => ({ ...raw, signing: signing && raw.mode === "stamp" }), [raw, signing]);
  // (Not before the mode has actually arrived: arming it takes a render, and this would end Sign as it began.)
  const reached = useRef(false);
  useEffect(() => {
    if (!signing) { reached.current = false; return; }
    if (raw.mode === "stamp") reached.current = true;
    else if (reached.current) setSigning(false);
  }, [signing, raw.mode]);
  const tray = TRAYS[open.mode] ? open.mode : null;
  const redact = open.mode === "redact";
  // Spectra's own strip steps aside while a tray is up; otherwise it is the tool's own (and restyled to fit).
  useLayoutEffect(() => {
    const root = document.documentElement.classList;
    root.toggle("autora-tray-on", tray !== null || redact);
    root.toggle("autora-signing", !!open.signing);
  }, [tray, redact, open.signing]);

  const pick = useCallback((t: Tile) => {
    if (t.id === "sign") {
      if (open.signing) { invokeCommand("tools.stamp"); return; }
      setSigning(true);
      if (raw.mode !== "stamp") invokeCommand("tools.stamp");
      // With no signature saved yet, the first thing wanted is to make one: open Spectra's own dialog (Draw or Type).
      window.setTimeout(() => {
        if (!document.querySelector(".signature-preset")) document.querySelector<HTMLElement>('[data-testid="signature-create"]')?.click();
      }, 300);
      return;
    }
    setSigning(false);
    // A tool's pane (Protect, Compress...) is a sheet over the page; picking something to draw with puts it away.
    if (t.mode) document.querySelector<HTMLElement>('[data-testid="tool-dock-close"]')?.click();
    // Stamps while Sign is up is the same mode: the mode is already armed, so it only changes what shows.
    if (t.id === "stamp" && raw.mode === "stamp" && open.signing) return;
    invokeCommand(commandOf(t));
  }, [open.signing, raw.mode]);

  const ids = PHONE ? PHONE_DEFAULT : pins;
  return (
    <>
      <Top onMenu={() => setMenu(true)} />
      {tray && <Tray mode={tray} />}
      {redact && <RedactTray />}
      <Bar open={open} slots={slots} ids={ids} onGrid={() => setGrid(true)} onPick={pick} />
      {grid && <Grid open={open} slots={slots} pins={pins.slice(0, slots)} setPins={setPins} onClose={() => setGrid(false)} onPick={pick} toast={say} />}
      {menu && <Menu onClose={() => setMenu(false)} />}
      <EscapeCloses active={grid || menu} onClose={() => { setGrid(false); setMenu(false); }} />
      <Toast text={toast} />
    </>
  );
}

/** Escape closes the grid and the menu, as it closes everything else. */
function EscapeCloses({ active, onClose }: { active: boolean; onClose: () => void }) {
  const ref = useRef(onClose);
  ref.current = onClose;
  useEffect(() => {
    if (!active) return;
    const on = (e: KeyboardEvent) => { if (e.key === "Escape") ref.current(); };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [active]);
  return null;
}

/** The classes that put Spectra's own chrome away (autora.css), before the first paint, and the bar once there is a page to hold. */
export function installRail(): void {
  const root = document.documentElement.classList;
  root.add("autora-rail-ui", PHONE ? "autora-phone" : "autora-desktop");
  const mount = () => {
    if (document.getElementById("autora-phone-root")) return;
    const host = document.createElement("div");
    host.id = "autora-phone-root";
    document.body.appendChild(host);
    createRoot(host).render(<Rail />);
  };
  if (document.body) mount();
  else window.addEventListener("DOMContentLoaded", mount, { once: true });
}
