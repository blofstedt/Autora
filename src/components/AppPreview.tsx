import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { previewApi } from "../lib/appApi";
import {
  usePreviewFrame, usePreviewState, type Device, type ElementInfo, type LightInfo, type Rect,
} from "../lib/preview";
import { AppInspector } from "./AppInspector";
import { AppReview } from "./AppReview";
import { IconRotateCcw, IconX } from "./Icons";

/**
 * The app window: the thing being built, live, with a way to point at it.
 *
 * The page is the session's own browser, streamed as video, at the size of the
 * device chosen (phone, tablet, desktop). Three things can be done to it:
 *
 *  - Use  click, type and scroll as you would on the page itself;
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

const NAMED_KEYS = new Set([
  "Enter", "Tab", "Backspace", "Delete", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Home", "End", "PageUp", "PageDown",
]);

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
  const [, bump] = useState(0);

  const areaRef = useRef<HTMLDivElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  const sinkRef = useRef<HTMLTextAreaElement>(null);
  const gesture = useRef<{
    sx: number; sy: number; moved: boolean; lastY: number; lastX: number; type: string; x0: number; y0: number; add: boolean;
  } | null>(null);
  const hoverAt = useRef(0);
  const hoverBusy = useRef(false);
  const inputChain = useRef<Promise<unknown>>(Promise.resolve());
  const scrollAcc = useRef({ dx: 0, dy: 0, timer: 0 });

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
  const queue = useCallback(<T,>(job: () => Promise<T>) => {
    const next = inputChain.current.then(job, job);
    inputChain.current = next.catch(() => undefined);
    return next;
  }, []);

  const flushScroll = useCallback(() => {
    const { dx, dy } = scrollAcc.current;
    scrollAcc.current = { dx: 0, dy: 0, timer: 0 };
    if (dx || dy) void queue(() => api.scroll(Math.round(dx), Math.round(dy)));
  }, [api, queue]);

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
    if (!r || r.width === 0) return { x: 0, y: 0 };
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
    clearSelection();
  };

  // ------------------------------------------------------------ pointer logic --
  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    screenRef.current?.setPointerCapture(e.pointerId);
    const p = toPage(e.clientX, e.clientY);
    gesture.current = {
      sx: e.clientX, sy: e.clientY, lastX: e.clientX, lastY: e.clientY, moved: false, type: e.pointerType,
      x0: p.x, y0: p.y, add: e.shiftKey || e.metaKey || e.ctrlKey,
    };
    if (mode === "region") { setRegion(null); setSel([]); setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y }); }
  };

  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    const p = toPage(e.clientX, e.clientY);
    if (!g) {
      if (mode === "inspect" && e.pointerType === "mouse") void hoverOver(p.x, p.y);
      return;
    }
    if (!g.moved && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) > 6) g.moved = true;
    if (mode === "region") {
      setDrag({ x0: g.x0, y0: g.y0, x1: p.x, y1: p.y });
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
    const p = toPage(e.clientX, e.clientY);
    if (mode === "region") {
      const x = Math.min(g.x0, p.x), y = Math.min(g.y0, p.y);
      const w = Math.abs(p.x - g.x0), h = Math.abs(p.y - g.y0);
      setDrag(null);
      if (w * scale >= 10 && h * scale >= 10) { setEpoch((n) => n + 1); setRegion({ x, y, w, h }); }
      return;
    }
    if (g.moved) return;
    if (mode === "inspect") {
      void pick(p.x, p.y, g.add);
      return;
    }
    void queue(async () => {
      const r = await api.click(Math.round(p.x), Math.round(p.y));
      if (r?.editable) sinkRef.current?.focus({ preventScroll: true });
    });
  };

  // Typing, once a click has landed in a field.
  const onSinkInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
    const text = e.currentTarget.value;
    e.currentTarget.value = "";
    if (text) void queue(() => api.type(text));
  };
  const onSinkKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (NAMED_KEYS.has(e.key)) {
      e.preventDefault();
      void queue(() => api.key(e.key));
    }
  };

  // ------------------------------------------------- keeping boxes on things --
  const comments = state.comments;
  const selectors = useMemo(() => {
    const list = new Set<string>();
    for (const c of comments) if (c.kind === "element" && c.elements[0]) list.add(c.elements[0].selector);
    for (const s of sel) list.add(s.selector);
    return [...list];
  }, [comments, sel]);

  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      const r = await api.rects(selectors);
      if (stopped || !r.ok) return;
      const map: Record<string, Rect | null> = {};
      selectors.forEach((s, i) => { map[s] = r.data.rects[i] ?? null; });
      setLive({ scroll: r.data.scroll, map });
    };
    void tick();
    const id = window.setInterval(() => void tick(), 600);
    return () => { stopped = true; window.clearInterval(id); };
  }, [api, selectors]);

  // A new device, or a reload, changes what a box means.
  useEffect(() => { bump((n) => n + 1); }, [vp.width, vp.height]);

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

  const sent = () => {
    setFlash("Sent. Autora is on it.");
    window.setTimeout(() => setFlash(null), 3500);
  };

  // ---------------------------------------------------------------- keyboard --
  /* On the document, not on the window: a button that is pressed and then
     removed (a chip that leaves an element out) drops the focus to the page,
     and the keys would stop arriving with it. Only while something is being
     worked on, and never while a field is being typed in. */
  const working = sel.length > 0 || region !== null;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      const typing = tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT";
      if (e.key === "Escape") {
        if (working) { e.preventDefault(); clearSelection(); }
        return;
      }
      if (typing || mode !== "inspect" || sel.length === 0) return;
      const dir = ({ ArrowUp: "parent", ArrowDown: "child", ArrowLeft: "prev", ArrowRight: "next" } as Record<string, "parent" | "child" | "prev" | "next">)[e.key];
      if (dir) { e.preventDefault(); void navigate(dir); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [working, mode, sel.length, clearSelection, navigate]);

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

  const pins = comments.flatMap((c, i) => {
    let r: Rect | null = null;
    if (c.kind === "element" && c.elements[0]) r = live?.map[c.elements[0].selector] ?? null;
    else if (c.region && c.viewport.width === vp.width) {
      // A box drawn at another size means nothing at this one.
      const dx = (c.scroll.x - (live?.scroll.x ?? c.scroll.x));
      const dy = (c.scroll.y - (live?.scroll.y ?? c.scroll.y));
      r = { ...c.region, x: c.region.x + dx, y: c.region.y + dy };
    }
    return r ? [{ c, n: i + 1, r }] : [];
  });

  const dragRect: Rect | null = drag
    ? { x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1), w: Math.abs(drag.x1 - drag.x0), h: Math.abs(drag.y1 - drag.y0) }
    : null;

  const host = state.url ? state.url.replace(/^https?:\/\//, "").replace(/\/$/, "") : "";

  return (
    <div className={`app-window${phone ? " is-phone" : ""}`} tabIndex={-1}>
      <div className="app-bar">
        <div className="app-seg" role="radiogroup" aria-label="Device size">
          {(["phone", "tablet", "desktop"] as Device[]).map((d) => (
            <button
              key={d} type="button" role="radio" aria-checked={d === device}
              className={d === device ? "on" : ""} title={`${DEVICE_LABEL[d]} size`}
              onClick={() => { if (d !== device) void api.device(d); }}
            >
              <Glyph d={GLYPH[d]} />
              <span>{DEVICE_LABEL[d]}</span>
            </button>
          ))}
        </div>
        <span className="app-url" title={state.url ?? ""}>
          <i className="app-live" aria-hidden="true" />
          {host}
          {(state.errors ?? 0) > 0 && <em className="app-errs" title="The page's console has errors; Autora can see them">{state.errors} error{state.errors === 1 ? "" : "s"}</em>}
        </span>
        <button type="button" className="app-icon" onClick={() => void api.reload()} title="Reload" aria-label="Reload the page">
          <IconRotateCcw size={15} />
        </button>
        <button type="button" className="app-icon" onClick={() => void api.close()} title="Close the app window" aria-label="Close the app window">
          <IconX size={15} />
        </button>
      </div>

      <div className="app-tools" role="radiogroup" aria-label="What a tap does">
        {([
          ["use", "Use", GLYPH.use, "Click, type and scroll the page"],
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
        <div className="app-canvas" style={{ width: box.w, height: box.h }}>
          <div
            ref={screenRef}
            className={`app-screen is-${mode}`}
            style={{ width: box.w, height: box.h }}
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={() => { gesture.current = null; setDrag(null); }}
            onPointerLeave={() => setHover(null)}
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
            </div>
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
        <textarea
          ref={sinkRef}
          className="app-sink"
          aria-label="Type into the page"
          autoCapitalize="off" autoCorrect="off" spellCheck={false}
          onInput={onSinkInput}
          onKeyDown={onSinkKey}
        />
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
