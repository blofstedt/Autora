import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { useAgentCursor } from "../lib/agentCursor";
import { previewApi } from "../lib/appApi";
import { NAMED_KEYS, SENTINEL, inField } from "../lib/pageInput";
import {
  usePreviewFrame, usePreviewState, type Device, type ElementInfo, type LightInfo, type Rect,
} from "../lib/preview";
import { AppInspector } from "./AppInspector";
import { AppReview } from "./AppReview";
import { IconAlert, IconArrowLeft, IconRotateCcw, IconX } from "./Icons";

/**
 * The app window: the thing being built, live, with a way to point at it.
 *
 * The page is the session's own browser, streamed as video, at the size of the
 * device chosen (phone, tablet, desktop), under its own back, reload and
 * address bar. Three things can be done to it:
 *
 *  - Use  click, type, drag and scroll as you would on the page itself (a
 *    dropdown's choices are listed here, since its popup never reaches the
 *    picture);
 *  - Select  hover to outline, tap to pick an element, step outwards or
 *    inwards or sideways with the arrows, hold shift to add more, then say
 *    what should change -- or try the change right on the page;
 *  - Region  drag a rectangle round anything, text or not.
 *
 * Every comment is kept with a picture and goes, together with the rest, as one
 * review (see AppReview). Nothing here runs the page's own scripts or reads
 * anything the person did not point at; the server does the reading, and only
 * of what was pointed at (server/pick.ts).
 */
type Mode = "use" | "inspect" | "region";

type Choice = { index: number; label: string; selected: boolean; disabled: boolean };

const DEVICE_LABEL: Record<Device, string> = { phone: "Phone", tablet: "Tablet", desktop: "Desktop" };

/* Small glyphs, drawn here: this window is the only place that needs them. */
const Glyph = ({ d, size = 15 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);
const GLYPH = {
  phone: "M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM11 18h2",
  tablet: "M6 2h12a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM11 18h2",
  desktop: "M3 4h18v12H3zM8 20h8M12 16v4",
  use: "M5 3l14 7-6 2-2 6z",
  select: "M12 3v4M12 17v4M3 12h4M17 12h4M12 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0",
  region: "M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3",
};

function isLight(info: ElementInfo | LightInfo): info is LightInfo {
  return (info as LightInfo).label !== undefined;
}

export function AppPreview({ sessionId, phone }: { sessionId: string; phone: boolean }) {
  const state = usePreviewState();
  const frame = usePreviewFrame();
  const [cursorOn, setCursorOn] = useAgentCursor();
  const api = useMemo(() => previewApi(sessionId), [sessionId]);
  const vp = state.viewport ?? { width: 1280, height: 800 };
  const device: Device = state.device ?? "desktop";

  const [mode, setMode] = useState<Mode>("use");
  const [sel, setSel] = useState<ElementInfo[]>([]);
  const [hover, setHover] = useState<LightInfo | null>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [region, setRegion] = useState<Rect | null>(null);
  const [reviewOpen, setReviewOpen] = useState(!phone);
  const [pinHover, setPinHover] = useState<string | null>(null);
  const [live, setLive] = useState<{ scroll: { x: number; y: number }; map: Record<string, Rect | null> } | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [epoch, setEpoch] = useState(0);
  const [area, setArea] = useState({ w: 0, h: 0 });
  /** A dropdown's choices, listed here: the page's own popup is drawn outside the page. */
  const [picker, setPicker] = useState<{ x: number; y: number; options: Choice[] } | null>(null);
  const [ripples, setRipples] = useState<Array<{ id: number; x: number; y: number }>>([]);
  const [typing, setTyping] = useState(false);
  /** The address being typed, or null while the bar just shows where the page is. */
  const [address, setAddress] = useState<string | null>(null);
  const [consoleOpen, setConsoleOpen] = useState(false);

  const areaRef = useRef<HTMLDivElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  const sinkRef = useRef<HTMLTextAreaElement>(null);
  const gesture = useRef<{
    sx: number; sy: number; moved: boolean; lastY: number; lastX: number; type: string; x0: number; y0: number; add: boolean;
    /** A mouse drag on the page in Use: pressed at x0,y0, last sent at px,py. */
    dragging: boolean; sentAt: number; px: number; py: number;
  } | null>(null);
  const hoverAt = useRef(0);
  const hoverBusy = useRef(false);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const inputChain = useRef<Promise<unknown>>(Promise.resolve());
  const scrollAcc = useRef({ dx: 0, dy: 0, timer: 0 });
  const pendingText = useRef("");
  const textTimer = useRef(0);
  const flashTimer = useRef(0);
  const rippleId = useRef(0);

  useEffect(() => () => {
    window.clearTimeout(flashTimer.current);
    window.clearTimeout(textTimer.current);
    window.clearTimeout(scrollAcc.current.timer);
  }, []);

  const say = useCallback((text: string) => {
    window.clearTimeout(flashTimer.current);
    setFlash(text);
    flashTimer.current = window.setTimeout(() => setFlash(null), 3500);
  }, []);

  // ----------------------------------------------------------------- layout --
  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    /* The room inside the area's own padding: measured against the padded
       box, the page ran under the edge. */
    const measure = () => {
      const s = getComputedStyle(el);
      const padX = parseFloat(s.paddingLeft) + parseFloat(s.paddingRight);
      const padY = parseFloat(s.paddingTop) + parseFloat(s.paddingBottom);
      setArea({ w: Math.max(0, el.clientWidth - padX), h: Math.max(0, el.clientHeight - padY) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const maxH = phone ? Math.min(Math.round((typeof window !== "undefined" ? window.innerHeight : 800) * 0.5), 480) : Math.max(area.h, 200);
  const scale = Math.max(0.05, Math.min((area.w || vp.width) / vp.width, maxH / vp.height, 1.5));
  const box = { w: Math.round(vp.width * scale), h: Math.round(vp.height * scale) };
  /** A popover beside the selection needs room; without it, a sheet. */
  const modal = phone || box.w < 600;

  // -------------------------------------------------------------- page input --
  /** Every input goes out in order: a click that lands after the text meant
      for the field it focuses is text lost. */
  const queue = useCallback(<T,>(job: () => Promise<T>) => {
    const next = inputChain.current.then(job, job);
    inputChain.current = next.catch(() => undefined);
    return next;
  }, []);

  /** Keystrokes are gathered for a moment and sent as one, not a round trip a letter. */
  const flushText = useCallback(() => {
    window.clearTimeout(textTimer.current);
    textTimer.current = 0;
    const text = pendingText.current;
    pendingText.current = "";
    if (text) void queue(() => api.type(text));
  }, [api, queue]);

  /** Anything that is not more typing goes out after the typing before it. */
  const send = useCallback(<T,>(job: () => Promise<T>) => {
    if (pendingText.current) flushText();
    return queue(job);
  }, [flushText, queue]);

  const typeText = (text: string) => {
    pendingText.current += text;
    if (!textTimer.current) textTimer.current = window.setTimeout(flushText, 40);
  };

  const flushScroll = useCallback(() => {
    const { dx, dy } = scrollAcc.current;
    scrollAcc.current = { dx: 0, dy: 0, timer: 0 };
    if (dx || dy) void send(() => api.scroll(Math.round(dx), Math.round(dy)));
  }, [api, send]);

  const scrollPage = useCallback((dx: number, dy: number) => {
    scrollAcc.current.dx += dx;
    scrollAcc.current.dy += dy;
    if (!scrollAcc.current.timer) scrollAcc.current.timer = window.setTimeout(flushScroll, 40);
  }, [flushScroll]);

  // The wheel needs a listener that may cancel it, which React's does not.
  useEffect(() => {
    const el = screenRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      scrollPage(e.deltaX / scale, e.deltaY / scale);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [scale, scrollPage]);

  const toPage = (clientX: number, clientY: number) => {
    const r = screenRef.current?.getBoundingClientRect();
    if (!r || r.width === 0 || r.height === 0) return null;
    return {
      x: Math.max(0, Math.min(vp.width, ((clientX - r.left) / r.width) * vp.width)),
      y: Math.max(0, Math.min(vp.height, ((clientY - r.top) / r.height) * vp.height)),
    };
  };

  // --------------------------------------------------------------- selecting --
  const pick = async (x: number, y: number, add: boolean) => {
    const r = await api.at(Math.round(x), Math.round(y));
    const info = r.ok ? r.data.info : null;
    if (!info || isLight(info)) return;
    setRegion(null);
    setEpoch((n) => n + 1);
    setSel((cur) => {
      if (!add) return [info];
      return cur.some((c) => c.selector === info.selector) ? cur.filter((c) => c.selector !== info.selector) : [...cur, info];
    });
  };

  const hoverOver = async (x: number, y: number) => {
    const now = performance.now();
    if (hoverBusy.current || now - hoverAt.current < 70) return;
    hoverBusy.current = true;
    hoverAt.current = now;
    const r = await api.at(Math.round(x), Math.round(y), true);
    hoverBusy.current = false;
    // Left Select while it was asked: nothing to outline any more.
    if (modeRef.current !== "inspect") return;
    const info = r.ok ? r.data.info : null;
    setHover(info && isLight(info) ? info : null);
  };

  const navigate = useCallback(async (dir: "parent" | "child" | "prev" | "next") => {
    const current = sel[sel.length - 1];
    if (!current) return;
    const r = await api.sel(current.selector, dir);
    const info = r.ok ? r.data.info : null;
    if (!info || isLight(info)) return;
    setSel((cur) => [...cur.slice(0, -1), info]);
  }, [api, sel]);

  const clearSelection = useCallback(() => {
    setSel([]);
    setRegion(null);
    setDrag(null);
    setHover(null);
  }, []);

  const changeMode = (next: Mode) => {
    setMode(next);
    setPicker(null);
    clearSelection();
  };

  // ------------------------------------------------------------ pointer logic --
  const focusSink = () => {
    const sink = sinkRef.current;
    if (!sink) return;
    sink.value = SENTINEL;
    sink.focus({ preventScroll: true });
  };

  /** A click on the page itself, in Use. */
  const click = (x: number, y: number, button: "left" | "right", touch: boolean) => {
    const at = { x: Math.round(x), y: Math.round(y) };
    /* Focus inside the tap: iOS only raises the keyboard for a focus that
       descends from one. On a touch screen only for a tap on a field -- for
       every tap it flashed the keyboard up and down on each button. */
    if (!touch || inField(state.fields ?? [], at.x, at.y)) focusSink();
    const id = ++rippleId.current;
    setRipples((prev) => [...prev, { id, ...at }]);
    window.setTimeout(() => setRipples((prev) => prev.filter((r) => r.id !== id)), 600);
    void send(async () => {
      const r = await api.click(at.x, at.y, button);
      if (r?.error) { say(r.error); return; }
      if (r?.select?.options?.length) { setPicker({ ...at, options: r.select.options }); return; }
      if (!touch || typeof r?.editable !== "boolean") return;
      // Tapped something that is not a field: put the phone's keyboard away.
      if (!r.editable) sinkRef.current?.blur();
      else if (document.activeElement !== sinkRef.current) focusSink();
    });
  };

  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const p = toPage(e.clientX, e.clientY);
    if (!p) return;
    /* A tap is followed by emulated mouse events, and their mousedown would
       take the focus off the keyboard sink the tap is about to focus. */
    if (e.pointerType !== "mouse") e.preventDefault();
    screenRef.current?.setPointerCapture(e.pointerId);
    setPicker(null);
    gesture.current = {
      sx: e.clientX, sy: e.clientY, lastX: e.clientX, lastY: e.clientY, moved: false, type: e.pointerType,
      x0: p.x, y0: p.y, add: e.shiftKey || e.metaKey || e.ctrlKey, dragging: false, sentAt: 0, px: p.x, py: p.y,
    };
    if (mode === "region") { setRegion(null); setSel([]); setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y }); }
  };

  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    const p = toPage(e.clientX, e.clientY);
    if (!p) return;
    if (!g) {
      if (mode === "inspect" && e.pointerType === "mouse") void hoverOver(p.x, p.y);
      return;
    }
    if (!g.moved && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) > 6) g.moved = true;
    if (mode === "region") {
      setDrag({ x0: g.x0, y0: g.y0, x1: p.x, y1: p.y });
    } else if (mode === "use" && g.moved && g.type === "mouse") {
      /* A mouse held down and moved drags on the page -- a slider, a canvas,
         a selection -- in parts, so what is dragged follows the pointer. A
         move every 60ms is what a hand is; one a pixel would queue up. */
      const now = Date.now();
      if (!g.dragging) {
        g.dragging = true;
        g.sentAt = now;
        const { x0, y0 } = g;
        void send(() => api.drag("start", x0, y0));
      } else if (now - g.sentAt >= 60) {
        g.sentAt = now;
        g.px = p.x;
        g.py = p.y;
        void send(() => api.drag("move", p.x, p.y));
      }
    } else if (g.moved && g.type !== "mouse") {
      // A finger dragging the page is scrolling it.
      scrollPage((g.lastX - e.clientX) / scale, (g.lastY - e.clientY) / scale);
    }
    g.lastX = e.clientX;
    g.lastY = e.clientY;
  };

  const up = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    const p = toPage(e.clientX, e.clientY) ?? { x: g.px, y: g.py };
    if (mode === "region") {
      const x = Math.min(g.x0, p.x), y = Math.min(g.y0, p.y);
      const w = Math.abs(p.x - g.x0), h = Math.abs(p.y - g.y0);
      setDrag(null);
      if (w * scale >= 10 && h * scale >= 10) { setEpoch((n) => n + 1); setRegion({ x, y, w, h }); }
      return;
    }
    if (g.dragging) {
      void send(() => api.drag("end", p.x, p.y));
      return;
    }
    if (g.moved) return;
    if (mode === "inspect") {
      void pick(p.x, p.y, g.add);
      return;
    }
    click(p.x, p.y, "left", g.type !== "mouse");
  };

  const cancel = () => {
    const g = gesture.current;
    gesture.current = null;
    setDrag(null);
    if (g?.dragging) void send(() => api.drag("end", g.px, g.py));
  };

  const onContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (mode !== "use") return;
    const p = toPage(e.clientX, e.clientY);
    if (p) click(p.x, p.y, "right", false);
  };

  // Typing, into whatever on the page has the focus.
  const onSinkKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key.length === 1) {
      if (e.key.toLowerCase() === "v") return; // the paste event carries it
      e.preventDefault();
      const key = `Control+${e.key.toLowerCase()}`;
      void send(() => api.key(key));
      return;
    }
    if (NAMED_KEYS.has(e.key)) {
      e.preventDefault();
      const key = e.key;
      void send(() => api.key(key));
    }
  };
  const onSinkInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
    const sink = e.currentTarget;
    const value = sink.value;
    sink.value = SENTINEL;
    // The sentinel went and nothing came: a phone keyboard's backspace.
    if (!value.includes(SENTINEL) && value.length === 0) {
      void send(() => api.key("Backspace"));
      return;
    }
    const text = value.split(SENTINEL).join("");
    if (text) typeText(text);
  };
  const onSinkPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text");
    if (text) typeText(text);
  };

  const choose = (index: number) => {
    if (!picker) return;
    const { x, y } = picker;
    setPicker(null);
    void send(async () => {
      const r = await api.choose(x, y, index);
      if (r?.error) say(r.error);
    });
  };

  // --------------------------------------------------------- the bar's tools --
  const back = () => void send(async () => {
    const r = await api.back();
    if (r?.error) say(r.error);
  });

  const go = (e: React.FormEvent) => {
    e.preventDefault();
    const typed = (address ?? "").trim();
    setAddress(null);
    if (!typed) return;
    // A bare path is on the app's own server.
    let target = typed;
    if (typed.startsWith("/") && state.url) {
      try { target = new URL(typed, state.url).toString(); } catch { /* sent as typed */ }
    }
    void send(async () => {
      const r = await api.go(target);
      if (r?.error) say(r.error);
    });
  };

  const reload = () => void send(async () => {
    const r = await api.reload();
    if (!r.ok) say(r.error);
  });

  // ------------------------------------------------- keeping boxes on things --
  const comments = state.comments;
  // Keyed by content: every state the window is sent is a new array of the same comments.
  const selectorKey = useMemo(() => {
    const list = new Set<string>();
    for (const c of comments) if (c.kind === "element" && c.elements[0]) list.add(c.elements[0].selector);
    for (const s of sel) list.add(s.selector);
    return [...list].join("\n");
  }, [comments, sel]);
  const selectors = useMemo(() => (selectorKey ? selectorKey.split("\n") : []), [selectorKey]);

  /* Where the picked and pinned things are now, while there are any: nothing
     to follow is nothing to ask for, and a slow page gets one question at a
     time rather than a queue of them. */
  const tracking = selectors.length > 0 || comments.some((c) => c.kind === "region");
  useEffect(() => {
    if (!tracking) return;
    let stopped = false;
    let asking = false;
    const tick = async () => {
      if (asking || document.visibilityState === "hidden") return;
      asking = true;
      const r = await api.rects(selectors);
      asking = false;
      if (stopped || !r.ok) return;
      const map: Record<string, Rect | null> = {};
      selectors.forEach((s, i) => { map[s] = r.data.rects[i] ?? null; });
      setLive({ scroll: r.data.scroll, map });
    };
    void tick();
    const id = window.setInterval(() => void tick(), 600);
    return () => { stopped = true; window.clearInterval(id); };
  }, [api, selectors, tracking]);

  // ---------------------------------------------------------------- comments --
  const addComment = async (c: { text: string; textEdit?: { from: string; to: string }; styleChanges: { property: string; from: string; to: string }[] }) => {
    const r = region
      ? await api.comment({ kind: "region", region, ...c })
      : await api.comment({ kind: "element", selectors: sel.map((s) => s.selector), ...c });
    if (!r.ok) return r.error;
    clearSelection();
    setReviewOpen(true);
    return null;
  };

  const sent = useCallback(() => say("Sent. Autora is on it."), [say]);

  // ---------------------------------------------------------------- keyboard --
  /* On the document, not on the window: a button that is pressed and then
     removed (a chip that leaves an element out) drops the focus to the page,
     and the keys would stop arriving with it. Only while something is being
     worked on, and never while a field is being typed in -- the page's own
     keys included, which go to the page. */
  const working = sel.length > 0 || region !== null;
  const listing = picker !== null;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target === sinkRef.current) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      const typing = tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT";
      if (e.key === "Escape") {
        if (listing) { e.preventDefault(); setPicker(null); }
        else if (working) { e.preventDefault(); clearSelection(); }
        return;
      }
      if (typing || mode !== "inspect" || sel.length === 0) return;
      const dir = ({ ArrowUp: "parent", ArrowDown: "child", ArrowLeft: "prev", ArrowRight: "next" } as Record<string, "parent" | "child" | "prev" | "next">)[e.key];
      if (dir) { e.preventDefault(); void navigate(dir); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [working, listing, mode, sel.length, clearSelection, navigate]);

  // ----------------------------------------------------------------- drawing --
  const at = (r: Rect): CSSProperties => ({
    left: r.x * scale, top: r.y * scale, width: Math.max(2, r.w * scale), height: Math.max(2, r.h * scale),
  });
  const rectOfSel = (s: ElementInfo): Rect => live?.map[s.selector] ?? s.rect;
  const primary = sel[sel.length - 1] ?? null;
  const focus: Rect | null = region ?? (primary ? rectOfSel(primary) : null);

  const anchor: CSSProperties = useMemo(() => {
    if (!focus || modal) return {};
    const PW = 310;
    const left = focus.x * scale, top = focus.y * scale, width = focus.w * scale, height = focus.h * scale;
    /* Beside the selection, so the change tried on it stays in view. A
       selection as wide as the page has no beside: the box goes under it, or
       over it when the bottom is too near. */
    if (width > box.w * 0.55) {
      const x = Math.max(0, Math.min(box.w - PW, left));
      const room = box.h - (top + height);
      const y = room >= 300 ? top + height + 12 : Math.max(0, top - 300);
      return { left: x, top: Math.max(0, Math.min(y, box.h - 120)) };
    }
    let x = left + width + 12;
    if (x + PW > box.w) x = left - PW - 12;
    if (x < 0) x = Math.max(0, Math.min(box.w - PW, left));
    return { left: x, top: Math.max(0, Math.min(top, box.h - 280)) };
  }, [focus, modal, scale, box.w, box.h]);

  const pins = useMemo(() => comments.flatMap((c, i) => {
    let r: Rect | null = null;
    if (c.kind === "element" && c.elements[0]) r = live?.map[c.elements[0].selector] ?? null;
    else if (c.region && c.viewport.width === vp.width) {
      // A box drawn at another size means nothing at this one.
      const dx = (c.scroll.x - (live?.scroll.x ?? c.scroll.x));
      const dy = (c.scroll.y - (live?.scroll.y ?? c.scroll.y));
      r = { ...c.region, x: c.region.x + dx, y: c.region.y + dy };
    }
    return r ? [{ c, n: i + 1, r }] : [];
  }), [comments, live, vp.width]);

  const dragRect: Rect | null = drag
    ? { x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1), w: Math.abs(drag.x1 - drag.x0), h: Math.abs(drag.y1 - drag.y0) }
    : null;

  const host = state.url ? state.url.replace(/^https?:\/\//, "").replace(/\/$/, "") : "";
  const errors = state.errors ?? 0;

  return (
    <div className={`app-window${phone ? " is-phone" : ""}`} tabIndex={-1}>
      <div className="app-bar">
        <div className="app-seg" role="radiogroup" aria-label="Device size">
          {(["phone", "tablet", "desktop"] as Device[]).map((d) => (
            <button
              key={d} type="button" role="radio" aria-checked={d === device}
              className={d === device ? "on" : ""} title={`${DEVICE_LABEL[d]} size`}
              onClick={() => {
                if (d === device) return;
                void api.device(d).then((r) => { if (!r.ok) say(r.error); });
              }}
            >
              <Glyph d={GLYPH[d]} />
              <span>{DEVICE_LABEL[d]}</span>
            </button>
          ))}
        </div>
        <button type="button" className="app-icon" onClick={back} title="Back" aria-label="Back">
          <IconArrowLeft size={15} />
        </button>
        <button type="button" className="app-icon" onClick={reload} title="Reload" aria-label="Reload the page">
          <IconRotateCcw size={15} />
        </button>
        {address === null ? (
          <button type="button" className="app-url" title={state.url ? `${state.url} (click to go somewhere else in the app)` : ""} onClick={() => setAddress(state.url ?? "")}>
            <i className={`app-live${state.serverDown ? " is-down" : ""}`} aria-hidden="true" />
            <span className="app-url-text">{host}</span>
          </button>
        ) : (
          <form className="app-url is-editing" onSubmit={go}>
            <input
              autoFocus
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
              onBlur={() => setAddress(null)}
              onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); setAddress(null); } }}
              aria-label="Address in the app"
              inputMode="url"
              enterKeyHint="go"
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
            />
          </form>
        )}
        {errors > 0 && (
          <button
            type="button" className={`app-errs${consoleOpen ? " on" : ""}`} aria-expanded={consoleOpen}
            title="The page's console has errors; Autora can see them" onClick={() => setConsoleOpen((v) => !v)}
          >
            {errors} error{errors === 1 ? "" : "s"}
          </button>
        )}
        <button
          type="button"
          className={`app-cursor${cursorOn ? " on" : ""}`}
          aria-pressed={cursorOn}
          onClick={() => setCursorOn(!cursorOn)}
          title={cursorOn ? "Stop showing where the agent works" : "Show where the agent works, and its cursor, as it builds"}
        >
          Agent cursor {cursorOn ? "on" : "off"}
        </button>
        <button type="button" className="app-icon" onClick={() => void api.close()} title="Close the app window" aria-label="Close the app window">
          <IconX size={15} />
        </button>
      </div>

      {consoleOpen && errors > 0 && (
        <div className="app-console" role="log" aria-label="The page's console errors">
          <ol>
            {(state.consoleErrors ?? []).map((line, i) => <li key={i}>{line}</li>)}
          </ol>
          {errors > (state.consoleErrors?.length ?? 0) && (
            <p className="app-console-more">and {errors - (state.consoleErrors?.length ?? 0)} earlier. Reload to start the count again.</p>
          )}
        </div>
      )}

      <div className="app-tools" role="radiogroup" aria-label="What a tap does">
        {([
          ["use", "Use", GLYPH.use, "Click, type, drag and scroll the page"],
          ["inspect", "Select", GLYPH.select, "Tap an element to comment on it (shift to add more)"],
          ["region", "Region", GLYPH.region, "Drag a box around anything"],
        ] as [Mode, string, string, string][]).map(([id, name, d, hint]) => (
          <button key={id} type="button" role="radio" aria-checked={mode === id} className={mode === id ? "on" : ""} title={hint} onClick={() => changeMode(id)}>
            <Glyph d={d} />
            <span>{name}</span>
          </button>
        ))}
        <span className="app-hint">
          {mode === "inspect" ? (sel.length ? "Arrow keys step through the page" : "Tap something") : mode === "region" ? "Drag to draw a box" : ""}
        </span>
      </div>

      <div className="app-area" ref={areaRef}>
        {state.serverDown && (
          <div className="app-down" role="status">
            <IconAlert size={14} />
            <span>
              <b>The dev server stopped{state.serverDown.exit !== null ? ` (exit ${state.serverDown.exit})` : ""}.</b>{" "}
              {state.serverDown.last && <code>{state.serverDown.last}</code>}{" "}
              Ask Autora to start it again.
            </span>
          </div>
        )}
        <div className="app-canvas" style={{ width: box.w, height: box.h }}>
          <div
            ref={screenRef}
            className={`app-screen is-${mode}`}
            style={{ width: box.w, height: box.h }}
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={cancel}
            onPointerLeave={() => setHover(null)}
            onContextMenu={onContextMenu}
          >
            {frame ? (
              <img className="app-frame" alt="The app, live" draggable={false} decoding="async"
                src={`data:${frame.mime};base64,${frame.data}`} width={box.w} height={box.h} />
            ) : (
              <div className="app-loading"><span className="attach-spin" aria-hidden="true" /> Loading the preview…</div>
            )}

            <div className="app-overlay" aria-hidden="true">
              {mode === "inspect" && hover && !sel.some((s) => s.selector === hover.selector) && (
                <>
                  <div className="app-box is-hover" style={at(hover.rect)} />
                  <div className="app-tag" style={{ left: hover.rect.x * scale, top: Math.max(0, hover.rect.y * scale - 20) }}>
                    {hover.label} · {Math.round(hover.rect.w)}×{Math.round(hover.rect.h)}
                  </div>
                </>
              )}
              {sel.map((s) => <div className="app-box is-picked" key={s.selector} style={at(rectOfSel(s))} />)}
              {dragRect && <div className="app-box is-region" style={at(dragRect)} />}
              {region && <div className="app-box is-region is-set" style={at(region)} />}
              {pinHover && pins.filter((p) => p.c.id === pinHover).map((p) => <div className="app-box is-pinned" key={p.c.id} style={at(p.r)} />)}
              {ripples.map((r) => <span key={r.id} className="click-ripple" style={{ left: r.x * scale, top: r.y * scale }} />)}
            </div>

            {picker && (
              <>
                <div className="shot-picker-scrim" onPointerDown={(e) => { e.stopPropagation(); setPicker(null); }} />
                <div
                  className="shot-picker"
                  role="listbox"
                  aria-label="Choose from the page's dropdown"
                  onPointerDown={(e) => e.stopPropagation()}
                  style={{
                    left: Math.max(0, Math.min(box.w - 160, picker.x * scale)),
                    top: Math.max(0, Math.min(box.h * 0.5, picker.y * scale)),
                  }}
                >
                  <div className="shot-picker-head">the page's dropdown</div>
                  <div className="shot-picker-list">
                    {picker.options.map((o) => (
                      <button
                        key={o.index} type="button" role="option" aria-selected={o.selected}
                        className={`shot-picker-opt ${o.selected ? "on" : ""}`}
                        disabled={o.disabled}
                        onClick={() => choose(o.index)}
                      >
                        {o.label || <em>blank</em>}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}

            {mode === "use" && typing && <span className="app-typing" aria-hidden="true">typing into the page</span>}

            {/* Where keys go: invisible and under the tap, so the keyboard a
                phone raises for it appears as if for the page's own field. */}
            <textarea
              ref={sinkRef}
              className="kbd-sink"
              aria-label="Type into the page"
              autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false}
              defaultValue={SENTINEL}
              tabIndex={mode === "use" ? 0 : -1}
              onKeyDown={onSinkKey}
              onInput={onSinkInput}
              onPaste={onSinkPaste}
              onFocus={() => setTyping(true)}
              onBlur={() => setTyping(false)}
            />
          </div>

          <div className="app-pins">
            {pins.map((p) => (
              <button
                key={p.c.id} type="button"
                className={`app-pin${pinHover === p.c.id ? " is-hover" : ""}`}
                style={{
                  left: Math.max(0, Math.min(box.w - 20, (p.r.x + p.r.w) * scale - 10)),
                  top: Math.max(0, Math.min(box.h - 20, p.r.y * scale - 10)),
                }}
                aria-label={`Comment ${p.n}`}
                onPointerDown={(e) => e.stopPropagation()}
                onMouseEnter={() => setPinHover(p.c.id)}
                onMouseLeave={() => setPinHover(null)}
                onClick={() => { setReviewOpen(true); setPinHover(p.c.id); }}
              >
                {p.n}
              </button>
            ))}
          </div>

          {(sel.length > 0 || region) && (
            <AppInspector
              api={api}
              selection={sel}
              region={region}
              epoch={epoch}
              modal={modal}
              anchor={anchor}
              onNav={(d) => void navigate(d)}
              onRemove={(s) => setSel((cur) => cur.filter((c) => c.selector !== s))}
              onAdd={addComment}
              onClose={clearSelection}
              onTried={(info) => setSel((cur) => cur.length ? [...cur.slice(0, -1), info] : cur)}
            />
          )}
        </div>
        {flash && <div className="app-flash" role="status">{flash}</div>}
      </div>

      <AppReview
        sessionId={sessionId}
        api={api}
        comments={comments}
        open={reviewOpen}
        onToggle={() => setReviewOpen((v) => !v)}
        hover={pinHover}
        onHover={setPinHover}
        onSent={sent}
      />
    </div>
  );
}
