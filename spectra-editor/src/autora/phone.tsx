/**
 * The PDF editor on a phone.
 *
 * Spectra's window is a desktop application (menu bar, toolbar, tabs, a side rail, a tool dock with thirty tools). On a
 * phone that is a screen of chrome around a page you cannot read. This is the phone's arrangement of the same editor,
 * the one SecurePDF and Autora 3D share (docs/TOOL-RAIL.md):
 *
 *   - a bar along the bottom of round, coloured tool buttons: as many of the default tools as fit (it never scrolls),
 *     and the grid button last;
 *   - the grid: every tool the editor has, in a modal in the middle of the screen, each tile in its tool's colour;
 *   - a one-row tray above the bar for the open tool: three colours, a colour wheel and a thickness slider for
 *     Highlight, Draw and Shapes (a button that steps through the shapes), colours for Text;
 *   - Undo, Redo and Find in a slim bar at the top.
 *
 * Nothing here is a second implementation. Every button calls Spectra's own command (`invokeCommand`), the colour and
 * thickness go through `renderer/autora-style.ts` into the canvas Spectra already draws, and a tool that has no tray of
 * its own (Stamp, Callout, Measure...) keeps Spectra's own strip, restyled by `autora.css`. The agent has every tool
 * whatever is shown. The desktop is untouched.
 *
 * Only mounted when the window says it is a phone (`?phone=1`, from components/SpectraWindow.tsx).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { getCommandContext, invokeCommand, isCommandEnabled } from "../renderer/commands/context";
import type { CommandId } from "../renderer/commands/registry";
import { getAutoraDetect, setAutoraColor, setAutoraDetect, setAutoraWidth, type Detect, type WidthMode } from "../renderer/autora-style";
import { GRID, ICONS, PHONE_DEFAULT, TOOLS, type Tile } from "./phone-tools";

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

/* ------------------------------------------------------------------- bar */

const BTN = 40; // a round button on the bar
const GAP = 2;
const PAD = 8;

/** How many tools fit across `width`, grid button and its divider included. The bar never scrolls: what does not fit is in the grid. */
const slotsFor = (width: number): number => Math.max(1, Math.floor((width - 2 * PAD - 2 - 7 + GAP) / (BTN + GAP)) - 1);

function Bar({ open, onGrid, onPick }: { open: Open; onGrid: () => void; onPick: (t: Tile) => void }) {
  const [slots, setSlots] = useState(() => slotsFor(window.innerWidth));
  useEffect(() => {
    const on = () => setSlots(slotsFor(window.innerWidth));
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  const shown = PHONE_DEFAULT.slice(0, slots).map((id) => TOOLS[id]);
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
            aria-label={t.label}
            aria-pressed={on}
            // A tap must not take the page's focus (and the on-screen keyboard) with it.
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => onPick(t)}
          >
            <Icon name={t.icon} size={21} />
          </button>
        );
      })}
      <span className="autora-rail-div" />
      <button type="button" className="autora-rail-btn is-grid" data-phone="grid" aria-label="All tools" aria-haspopup="dialog" onPointerDown={(e) => e.preventDefault()} onClick={onGrid}>
        <Icon name="grid" size={21} />
      </button>
    </nav>
  );
}

/* ------------------------------------------------------------------ grid */

function Grid({ open, onClose, onPick }: { open: Open; onClose: () => void; onPick: (t: Tile) => void }) {
  const pick = (t: Tile) => {
    onClose();
    onPick(t);
  };
  return (
    <div className="autora-scrim" onClick={onClose} data-testid="phone-grid-scrim">
      <div className="autora-grid" role="dialog" aria-label="All tools" onClick={(e) => e.stopPropagation()} data-testid="phone-grid">
        <div className="autora-grid-head">
          <h3>All tools</h3>
          <button type="button" className="autora-x" aria-label="Close" data-testid="phone-grid-close" onClick={onClose}><Icon name="x" size={18} /></button>
        </div>
        <p className="autora-hint">Tap a tool to use it.</p>
        {GRID.map((g) => (
          <section key={g.title}>
            <h4>{g.title}</h4>
            <div className="autora-tiles">
              {g.ids.map((id) => {
                const t = TOOLS[id];
                const enabled = id === "select" || isCommandEnabled(commandOf(t));
                return (
                  <button
                    key={id}
                    type="button"
                    className={`autora-tile${isOn(t, open) ? " is-on" : ""}`}
                    style={{ ["--tc" as string]: t.color }}
                    data-tile={id}
                    disabled={!enabled}
                    onClick={() => pick(t)}
                  >
                    <Icon name={t.icon} size={18} />
                    <span>{t.label}</span>
                  </button>
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

/** A tray sits above the bar and must not cover the editor's own bottom controls (page and zoom, "Redact 2 regions"), so the shell leaves room for it. */
function useReserve() {
  const ref = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement.style;
    const set = () => root.setProperty("--autora-tray-h", `${Math.ceil(el.getBoundingClientRect().height) + 8}px`);
    set();
    const watch = new ResizeObserver(set);
    watch.observe(el);
    return () => { watch.disconnect(); root.removeProperty("--autora-tray-h"); };
  }, []);
  return ref;
}

/** The modes that get the one-row tray: what each shows. Anything else keeps Spectra's own strip. */
const TRAYS: Record<string, { tool: string; width?: { mode: WidthMode; min: number; max: number; step: number; start: number; label: string }; presets: string[]; start: string }> = {
  highlight: { tool: "highlight", presets: ["#ffd54a", "#2fbf71", "#ff8fc7"], start: "#ffd54a" },
  inkhighlight: { tool: "inkhighlight", width: { mode: "inkhighlight", min: 6, max: 28, step: 1, start: 14, label: "Thickness" }, presets: ["#ffd54a", "#2fbf71", "#ff8fc7"], start: "#ffd54a" },
  freetext: { tool: "text", presets: ["#e0393e", "#2f6fed", "#16161a"], start: "#16161a" },
  ink: { tool: "draw", width: { mode: "ink", min: 1, max: 12, step: 1, start: 2, label: "Thickness" }, presets: ["#e0393e", "#2f6fed", "#16161a"], start: "#2f6fed" },
  note: { tool: "note", presets: ["#ffd54a", "#e0393e", "#2f6fed"], start: "#ffd54a" },
  callout: { tool: "callout", presets: ["#e0393e", "#2f6fed", "#16161a"], start: "#e0393e" },
  shape: { tool: "shape", width: { mode: "shape", min: 1, max: 10, step: 1, start: 2, label: "Thickness" }, presets: ["#e0393e", "#2f6fed", "#16161a"], start: "#e0393e" },
};

/** Redact's tray: what a tap takes. The marks it makes are Spectra's own pending redactions, with handles on each side. */
function RedactTray() {
  const tile = TOOLS.redact;
  const [detect, setDetect] = useState<Detect>(getAutoraDetect);
  const choose = (d: Detect) => { setDetect(d); setAutoraDetect(d); };
  const reserve = useReserve();
  return (
    <section ref={reserve} className="autora-tray" style={{ ["--tc" as string]: tile.color }} data-testid="phone-tray" data-mode="redact" aria-label="Redact options">
      <span className="autora-tray-icon" aria-hidden="true"><Icon name={tile.icon} size={21} /></span>
      <div className="autora-seg" role="group" aria-label="A tap redacts">
        <button type="button" aria-pressed={detect === "word"} data-detect="word" onPointerDown={(e) => e.preventDefault()} onClick={() => choose("word")}>A word</button>
        <button type="button" aria-pressed={detect === "line"} data-detect="line" onPointerDown={(e) => e.preventDefault()} onClick={() => choose("line")}>A line</button>
      </div>
      <p className="autora-tray-hint">Tap text to redact it. Drag a handle to resize.</p>
      <button type="button" className="autora-x autora-tray-x" aria-label="Close options" onPointerDown={(e) => e.preventDefault()} onClick={() => { invokeCommand("tools.close"); }}>
        <Icon name="x" size={18} />
      </button>
    </section>
  );
}

/** The shapes Spectra draws, in the order the button steps through them. */
const SHAPES = ["rect", "ellipse", "line", "arrow", "polygon", "polyline", "cloud"] as const;
const SHAPE_NAMES: Record<string, string> = { rect: "Box", ellipse: "Circle", line: "Line", arrow: "Arrow", polygon: "Polygon", polyline: "Polyline", cloud: "Cloud" };
const SHAPE_ICONS: Record<string, string> = { rect: "shape", ellipse: "circle", line: "line", arrow: "arrow", polygon: "polygon", polyline: "polyline", cloud: "cloud" };

/** Spectra's own strip holds the current figure; its buttons are in the DOM (hidden) and are the one way to read and set it. */
const shapeNow = (): string => SHAPES.find((s) => document.querySelector(`[data-testid="shape-type-${s}"]`)?.getAttribute("aria-pressed") === "true") ?? "rect";

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
    document.querySelector<HTMLElement>(`[data-testid="shape-type-${next}"]`)?.click();
    setShape(next);
  };

  return (
    <section ref={reserve} className="autora-tray" style={{ ["--tc" as string]: tile.color }} data-testid="phone-tray" data-mode={mode} aria-label={`${tile.label} options`}>
      {mode === "shape" ? (
        <button type="button" className="autora-cyc" data-testid="phone-shape" aria-label={`Shape: ${SHAPE_NAMES[shape]}. Tap for the next shape`} onPointerDown={(e) => e.preventDefault()} onClick={stepShape}>
          <Icon name={SHAPE_ICONS[shape]} size={20} />
          <span className="autora-rot"><Icon name="cycle" size={10} /></span>
        </button>
      ) : (
        <span className="autora-tray-icon" aria-hidden="true"><Icon name={tile.icon} size={21} /></span>
      )}
      <div className="autora-sw" role="group" aria-label="Colour">
        {spec.presets.map((c) => (
          <button key={c} type="button" className="autora-swatch" style={{ background: c }} aria-label={`Colour ${c}`} aria-pressed={color === c} onPointerDown={(e) => e.preventDefault()} onClick={() => choose(c)} />
        ))}
        <label className="autora-wheel" aria-pressed={custom} title="More colours">
          <input type="color" value={color} aria-label="Pick any colour" data-testid="phone-wheel" onChange={(e) => choose(e.target.value)} />
          <i style={{ background: custom ? color : "var(--autora-s2)" }} />
        </label>
      </div>
      {spec.width && (
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
      )}
      <button type="button" className="autora-x autora-tray-x" aria-label="Close options" onPointerDown={(e) => e.preventDefault()} onClick={() => { invokeCommand("tools.close"); }}>
        <Icon name="x" size={18} />
      </button>
    </section>
  );
}

/* ------------------------------------------------------------------- top */

function Top() {
  const act = (id: CommandId) => (
    <button
      key={id}
      type="button"
      className="autora-top-btn"
      aria-label={id === "edit.undo" ? "Undo" : id === "edit.redo" ? "Redo" : "Find"}
      data-phone={id.slice(5)}
      onPointerDown={(e) => e.preventDefault()}
      onClick={() => { invokeCommand(id); }}
    >
      <Icon name={id.slice(5)} size={19} />
    </button>
  );
  return <div className="autora-top" data-testid="phone-top">{(["edit.undo", "edit.redo", "edit.find"] as CommandId[]).map(act)}</div>;
}

/* ------------------------------------------------------------------ root */

function Phone() {
  const raw = useOpen();
  const [grid, setGrid] = useState(false);
  const [signing, setSigning] = useState(false);
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

  return (
    <>
      <Top />
      {tray && <Tray mode={tray} />}
      {redact && <RedactTray />}
      <Bar open={open} onGrid={() => setGrid(true)} onPick={pick} />
      {grid && <Grid open={open} onClose={() => setGrid(false)} onPick={pick} />}
      <GridKeys active={grid} onClose={() => setGrid(false)} />
    </>
  );
}

/** Escape closes the grid, as it closes everything else. */
function GridKeys({ active, onClose }: { active: boolean; onClose: () => void }) {
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

/** Whether this frame was opened as the phone's. Read once: a window does not change its mind. */
export const isPhone = (): boolean => new URLSearchParams(location.search).get("phone") === "1";

/** The class that turns the desktop chrome off (autora.css), before the first paint, and the bar once there is a page to hold. */
export function installPhone(): void {
  if (!isPhone()) return;
  document.documentElement.classList.add("autora-phone");
  const mount = () => {
    if (document.getElementById("autora-phone-root")) return;
    const host = document.createElement("div");
    host.id = "autora-phone-root";
    document.body.appendChild(host);
    createRoot(host).render(<Phone />);
  };
  if (document.body) mount();
  else window.addEventListener("DOMContentLoaded", mount, { once: true });
}
