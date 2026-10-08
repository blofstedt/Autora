import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconCheck } from "./Icons";
import { WORK_MODES, type WorkMode } from "../lib/modes";
import { usePhone } from "../lib/stage";

/**
 * How the agent goes about the work -- Build, Plan or Agent -- in the message
 * box, on the row above Send, so the mode sits next to the words it applies
 * to. One pill on every screen (a coloured icon, the mode's name on a wide
 * one) that opens the same centred sheet with the page dimmed behind it.
 *
 * Agent switches between planning and building by itself, and says so in the
 * thread; this control does not move when it does.
 */
const GLYPH: Record<WorkMode, string> = {
  build: "M14.7 6.3a4 4 0 0 0-5 5L3 18l3 3 6.7-6.7a4 4 0 0 0 5-5l-2.5 2.5-2.7-.7-.7-2.7z",
  plan: "M9 6h11M9 12h11M9 18h11M3 6l1 1 2-2M3 12l1 1 2-2M3 18l1 1 2-2",
  agent: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z",
};

function Glyph({ mode }: { mode: WorkMode }) {
  return (
    <svg
      width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    >
      <path d={GLYPH[mode]} />
    </svg>
  );
}

export function ModeSelect({
  mode,
  onChange,
  busy,
  compact = false,
}: {
  mode: WorkMode;
  onChange: (mode: WorkMode) => void;
  busy?: boolean;
  /** The message box is narrow (the app window is beside it): the pill, as on a phone. */
  compact?: boolean;
}) {
  const phone = usePhone();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement | null>(null);
  const sheet = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const inside = e.target as Node;
      if (!wrap.current?.contains(inside) && !sheet.current?.contains(inside)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = WORK_MODES.find((m) => m.id === mode) ?? WORK_MODES[2];
  /* The narrow form of this control -- a phone, or the chat with the app pane
     beside it -- is a glyph and a caret. Its word is what would push the
     composer's toolstrip onto a second line, and the glyph with its colour
     already says which mode is on; the sheet it opens spells it out. */
  const iconOnly = phone || compact;

  return (
    <div className="mode-sel-wrap" ref={wrap}>
      <button
        type="button"
        className={`mode-sel-pill m-${mode}${open ? " open" : ""}${iconOnly ? " is-icon" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`How Autora works: ${current.label}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="mode-sel-ico"><Glyph mode={mode} /></span>
        {!iconOnly && current.label}
        <span className="mode-sel-caret" aria-hidden="true">{open ? "▴" : "▾"}</span>
      </button>
      {open && createPortal(
        <div className="mode-sel-sheet" role="menu" ref={sheet}>
          <div className="mode-sel-head">How Autora works</div>
          {WORK_MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="menuitemradio"
              aria-checked={m.id === mode}
              className={`mode-sel-opt m-${m.id}${m.id === mode ? " on" : ""}`}
              disabled={busy}
              onClick={() => {
                setOpen(false);
                if (m.id !== mode) onChange(m.id);
              }}
            >
              <span className="mode-sel-ico is-big"><Glyph mode={m.id} /></span>
              <span>
                <b>{m.label}</b>
                <span>{m.blurb}</span>
              </span>
              {m.id === mode && <IconCheck size={14} />}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
