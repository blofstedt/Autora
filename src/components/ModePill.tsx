import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { IconCheck } from "./Icons";

/**
 * How much this chat may do on its own, in the header, where the chat is.
 *
 * The mode is a property of the conversation rather than of the install (see
 * server/modes.ts): the same console watches one chat in Plan while another
 * runs in Auto, and which one you are in should be readable at a glance
 * without opening Settings. So it is a pill beside the session name, and
 * pressing it offers the three modes with one line each.
 *
 * Auto -- the default and what Autora has always done -- says nothing here:
 * a pill on every chat saying "nothing special" is noise, and the thing worth
 * noticing is the chat that is NOT in auto.
 */
export type ChatMode = "plan" | "ask" | "auto";

export const MODES: { id: ChatMode; short: string; label: string; blurb: string }[] = [
  {
    id: "plan",
    short: "Plan",
    label: "Plan only",
    blurb: "Nothing is changed. Every call that would is put to you first, and the agent says what it intends.",
  },
  {
    id: "ask",
    short: "Ask",
    label: "Ask first",
    blurb: "Looking is free. Anything that writes, runs or sends waits for your yes.",
  },
  {
    id: "auto",
    short: "Auto",
    label: "Auto",
    blurb: "The default: calls run as they come and are shown as they happen. Nothing irreversible runs without you.",
  },
];

export function ModePill({
  mode,
  onChange,
  busy,
  error,
}: {
  mode: ChatMode;
  onChange: (mode: ChatMode) => void;
  busy?: boolean;
  error?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);
  /* Where the menu goes, in the pill's own coordinates, until it has been
     measured and put inside the window. */
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);

  /* A menu that stays open while you look somewhere else is a menu you have
     to close twice. Same rule as the other popovers here. */
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  /* The menu is 340px wide and the pill is not always near the left of the
     header: with a long session name it sits hard against the right of the
     window, and a menu anchored to the pill's left edge hung off the side of
     the screen where it could not be read or reached. So it is measured
     against the window and moved inside it -- and flipped above the pill when
     there is no room below -- rather than trusting where it was anchored. */
  useLayoutEffect(() => {
    if (!open) {
      setAt(null);
      return;
    }
    const place = () => {
      const el = menu.current;
      const anchor = wrap.current;
      if (!el || !anchor) return;
      const pad = 10; /* clear of the window's own edge */
      const gap = 6; /* and of the pill */
      const a = anchor.getBoundingClientRect();
      const winW = window.innerWidth;
      const winH = window.innerHeight;

      /* Never wider or taller than the window it has to sit in. */
      const width = Math.min(340, winW - pad * 2);
      el.style.width = `${width}px`;
      el.style.maxHeight = "";
      const height = el.offsetHeight;

      const left = Math.max(pad, Math.min(a.left, winW - pad - width));

      const below = winH - pad - (a.bottom + gap);
      const above = a.top - gap - pad;
      let top: number;
      if (height <= below || below >= above) {
        top = a.bottom + gap;
        if (height > below) el.style.maxHeight = `${Math.max(140, below)}px`;
      } else {
        top = a.top - gap - height;
        if (height > above) el.style.maxHeight = `${Math.max(140, above)}px`;
      }

      setAt({ left: left - a.left, top: top - a.top });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  const current = MODES.find((m) => m.id === mode) ?? MODES[2];

  return (
    <div className="mode-pill-wrap" ref={wrap}>
      <button
        className={`badge mode-pill m-${current.id}${open ? " open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        title={`This chat is in ${current.label} mode — press to change it`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="mode-dot" aria-hidden="true" />
        {current.short}
      </button>

      {open && (
        <div
          className="mode-menu"
          role="menu"
          ref={menu}
          style={{ left: at?.left, top: at?.top, visibility: at ? "visible" : "hidden" }}
        >
          <p className="mode-menu-head">What this chat may do on its own</p>
          {MODES.map((m) => (
            <button
              key={m.id}
              className={`mode-option${m.id === current.id ? " on" : ""}`}
              role="menuitemradio"
              aria-checked={m.id === current.id}
              disabled={busy}
              onClick={() => {
                setOpen(false);
                if (m.id !== current.id) onChange(m.id);
              }}
            >
              <span className="mode-option-top">
                <span className={`mode-dot m-${m.id}`} aria-hidden="true" />
                <span className="mode-option-label">{m.label}</span>
                {m.id === current.id && <IconCheck size={13} />}
              </span>
              <span className="mode-option-blurb">{m.blurb}</span>
            </button>
          ))}
          {error && <p className="mode-menu-error">{error}</p>}
          <p className="mode-menu-foot">
            Set for this chat, and saved with it. The guard's standing agreements and anything
            that cannot be undone still ask, whatever this says.
          </p>
        </div>
      )}
    </div>
  );
}
