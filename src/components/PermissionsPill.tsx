import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePhone } from "../lib/stage";
import { IconCheck } from "./Icons";
import {
  ASK_SUGGESTIONS, ASK_WHEN_MAX, PERMISSIONS, toggleRule, hasRule, type Permissions,
} from "../lib/modes";

/**
 * What this chat may do without asking, in the header, where the chat is.
 *
 * Yolo runs calls as they come; Ask holds the ones that change something for
 * a yes. Ask can be narrowed in the person's own words -- "before deleting
 * anything, before sending messages" -- with a tap-to-add list of ideas, and
 * left empty it asks about every change. It is set for this conversation and
 * saved with it (see server/modes.ts); how the agent goes about the work
 * (Build, Plan, Agent) is the other selector, in the message box.
 */
export function PermissionsPill({
  permissions,
  askWhen,
  onChange,
  onChangeWhen,
  busy,
  error,
}: {
  permissions: Permissions;
  askWhen: string;
  onChange: (permissions: Permissions) => void;
  onChangeWhen: (text: string) => void;
  busy?: boolean;
  error?: string | null;
}) {
  const phone = usePhone();
  const [open, setOpen] = useState(false);
  const closeRef = useRef<() => void>(() => undefined);
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
      const inside = e.target as Node;
      if (!wrap.current?.contains(inside) && !menu.current?.contains(inside)) closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
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
  }, [open, permissions]);

  // (saved words are sent when the menu closes, however it closes)
  const current = PERMISSIONS.find((m) => m.id === permissions) ?? PERMISSIONS[0];
  /* The words are edited here and saved when the menu closes or Save is
     pressed, so typing is not a request to the server per letter. */
  const [draft, setDraft] = useState(askWhen);
  useEffect(() => { if (!open) setDraft(askWhen); }, [askWhen, open]);
  const save = () => {
    const next = draft.trim();
    if (next !== askWhen.trim()) onChangeWhen(next);
  };
  const close = () => { save(); setOpen(false); };
  closeRef.current = close;

  const summary = permissions === "ask" && askWhen.trim() ? "Ask · custom" : current.label;

  return (
    <div className="mode-pill-wrap" ref={wrap}>
      <button
        className={`badge mode-pill m-${current.id}${open ? " open" : ""}`}
        onClick={() => (open ? close() : setOpen(true))}
        title={`Permissions for this chat: ${current.label} — press to change`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="mode-dot" aria-hidden="true" />
        {summary}
      </button>

      {open && (() => {
        const popup = (
        <div
            className="mode-menu"
            role="menu"
            ref={menu}
            style={{ left: at?.left, top: at?.top, visibility: at ? "visible" : "hidden" }}
          >
            <p className="mode-menu-head">Permissions for this chat</p>
            {PERMISSIONS.map((m) => (
              <button
                key={m.id}
                className={`mode-option${m.id === current.id ? " on" : ""}`}
                role="menuitemradio"
                aria-checked={m.id === current.id}
                disabled={busy}
                onClick={() => {
                  if (m.id !== current.id) onChange(m.id);
                  if (m.id === "yolo") close();
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

            {permissions === "ask" && (
              <div className="ask-when">
                <label className="ask-when-label" htmlFor="ask-when-text">When should it ask?</label>
                <textarea
                  id="ask-when-text"
                  className="ask-when-text"
                  value={draft}
                  maxLength={ASK_WHEN_MAX}
                  rows={3}
                  placeholder="Empty asks before every change. Or say when: before deleting anything, before sending a message…"
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={save}
                />
                <div className="ask-when-chips" role="group" aria-label="Ideas for when to ask">
                  {ASK_SUGGESTIONS.map((sug) => (
                    <button
                      key={sug.id}
                      type="button"
                      className={`ask-chip${hasRule(draft, sug.rule) ? " on" : ""}`}
                      aria-pressed={hasRule(draft, sug.rule)}
                      onClick={() => setDraft((d) => toggleRule(d, sug.rule))}
                    >
                      {sug.label}
                    </button>
                  ))}
                </div>
                <div className="ask-when-foot">
                  <span>{draft.trim() ? "Asks only about these." : "Asks about every change."}</span>
                  <button type="button" className="btn small" onClick={close}>Done</button>
                </div>
              </div>
            )}

            {error && <p className="mode-menu-error">{error}</p>}
            <p className="mode-menu-foot">
              Set for this chat, and saved with it. The guard's standing agreements and anything
              that cannot be undone still ask, whatever this says.
            </p>
          </div>
        );
        /* On a phone it is a centred modal, and a fixed box inside the header
           is placed against whatever in the header has a transform or a
           filter, so it goes to the body where fixed means the window. */
        return phone ? createPortal(popup, document.body) : popup;
      })()}
    </div>
  );
}
