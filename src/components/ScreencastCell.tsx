import { Children, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Shot } from "../lib/derive";
import { onField, useLiveFrame } from "../lib/liveFrame";
import { Frame } from "./Frame";
import {
  IconArrowLeft, IconChevron, IconGlobe, IconMaximize, IconMinimize, IconMonitor, IconRotateCcw, IconStop,
} from "./Icons";

/** The viewport the browser harness captures. Frame pixels map 1:1 to page
    pixels, so a click at 640,400 is the middle of the picture. */
const VIEWPORT = { w: 1280, h: 800 };

/** Kept in the keyboard sink so a phone's backspace has something to delete:
    Android reports soft-keyboard keys as "Unidentified", and the only reliable
    sign of a backspace is the field getting shorter. */
const SENTINEL = "\u200b";

/** Keys that are keys rather than text, forwarded by name. */
const NAMED_KEYS = new Set([
  "Enter", "Tab", "Backspace", "Delete", "Escape", "ArrowUp", "ArrowDown",
  "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown",
]);

/**
 * A stretch of screen work -- a page, or the relayed desktop -- kept where it
 * happened.
 *
 * The page the agent is on now is also a page you can use: click or tap the
 * picture and the click lands on the page, type and the keys go to whatever
 * you clicked into, scroll and it scrolls. Above it is the browser's own
 * toolbar -- back, reload, and an address you can type into. It is locked while the agent is driving -- two pairs of hands on
 * one page is how a sign-in ends up half typed by each -- and unlocks when the
 * agent finishes, stops, or asks you to take over.
 *
 * Older cards are the record: every frame the agent produced stays with the
 * card, and the strip under it moves through them.
 */
export function ScreencastCell({
  sessionId, source, url, shots, actions, live, followsFeed = false, current = false,
  driving = false, waitingOnYou = false, onStop, children,
}: {
  sessionId: string;
  source: "browser" | "desktop";
  url: string | null;
  shots: Shot[];
  actions: string[];
  live: boolean;
  /** This is the card whose page is still open, so the video is its to show. */
  followsFeed?: boolean;
  /** The newest browser card: the only one looking at a page that exists. */
  current?: boolean;
  /** The agent is at the wheel, so the page is not yours to touch. */
  driving?: boolean;
  /** The agent has handed the page to you and is waiting. */
  waitingOnYou?: boolean;
  onStop?: () => void;
  /** What the agent said while it worked this screen, shown in the card so
      the page stays put rather than being pushed up by each sentence. */
  children?: ReactNode;
}) {
  const feed = useLiveFrame(followsFeed);
  const logRef = useRef<HTMLDivElement>(null);
  const logFollows = useRef(true);
  const logCount = Children.count(children);
  const [at, setAt] = useState(shots.length - 1);
  const [held, setHeld] = useState(false);
  const [showActions, setShowActions] = useState(false);
  /** Big while the agent is driving the page right now, inline otherwise;
      either way the corner button overrides it. */
  const [bigChoice, setBigChoice] = useState<boolean | null>(null);
  const [max, setMax] = useState(false);
  const [nudge, setNudge] = useState<{ text: string; stop?: boolean } | null>(null);
  const [ripples, setRipples] = useState<Array<{ id: number; x: number; y: number }>>([]);
  const [typing, setTyping] = useState(false);
  /** The address bar's text while you are editing it; the page's address
      otherwise. */
  const [address, setAddress] = useState(url ?? "");
  const [editingAddress, setEditingAddress] = useState(false);
  const addressRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!editingAddress) setAddress(url ?? "");
  }, [url, editingAddress]);
  const holdRef = useRef(held);
  holdRef.current = held;
  const stageRef = useRef<HTMLDivElement>(null);
  const sinkRef = useRef<HTMLTextAreaElement>(null);
  /** Every input goes out in order, one after another: a click that lands
      after the text meant for the field it focuses is a lost password. */
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const pointer = useRef<{ x: number; y: number; lastY: number; moved: boolean; type: string } | null>(null);
  const scrollAccum = useRef({ dx: 0, dy: 0, timer: 0 });

  useEffect(() => {
    if (!holdRef.current) setAt(shots.length - 1);
  }, [shots.length]);

  useEffect(() => {
    if (!nudge) return;
    const timer = window.setTimeout(() => setNudge(null), 3200);
    return () => window.clearTimeout(timer);
  }, [nudge]);

  useEffect(() => {
    if (!max) return;
    const onKey = (e: KeyboardEvent) => {
      // Escape inside the page belongs to the page.
      if (e.key === "Escape" && e.target !== sinkRef.current) setMax(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [max]);

  const watching = !!feed && !held;
  const canUse = source === "browser" && current && watching && !driving;

  // Losing the page (the agent took it back, or it closed) drops the keyboard;
  // getting it back retires the note saying it was taken.
  useEffect(() => {
    if (canUse) setNudge(null);
    else if (document.activeElement === sinkRef.current) sinkRef.current?.blur();
  }, [canUse]);

  // Handed the page: bring it into view, since the card asking you to use it
  // sits below it and the page may have scrolled off the top.
  const handedOver = waitingOnYou && canUse;
  useEffect(() => {
    if (!handedOver) return;
    // After the thread has finished laying out the card that asked, or its
    // own jump to the bottom lands after this one. The thread only:
    // scrollIntoView also scrolls the document, which on a phone slides the
    // whole app up under the status bar.
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => {
      const stage = stageRef.current;
      const scroller = stage?.closest(".thread");
      if (!stage || !scroller) return;
      const top = stage.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      scroller.scrollTo({ top: scroller.scrollTop + top - 12 });
    }));
    return () => cancelAnimationFrame(frame);
  }, [handedOver]);

  const send = useCallback((path: string, body: unknown): Promise<any> => {
    // Anything that is not more typing goes out after the typing before it.
    if (path !== "type" && pendingText.current) flushText();
    return enqueue(path, body);
    // enqueue and flushText only read refs and sessionId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  /** Keystrokes are gathered for a moment and sent as one: a request per
      character made a fast typist wait on a round trip for every letter. */
  const pendingText = useRef("");
  const textTimer = useRef(0);
  const flushText = () => {
    window.clearTimeout(textTimer.current);
    textTimer.current = 0;
    const text = pendingText.current;
    pendingText.current = "";
    if (text) void enqueue("type", { text });
  };
  const typeText = (text: string) => {
    pendingText.current += text;
    if (!textTimer.current) textTimer.current = window.setTimeout(flushText, 40);
  };

  const enqueue = (path: string, body: unknown): Promise<any> => {
    const next = chain.current.then(async () => {
      const res = await fetch(`/api/sessions/${sessionId}/browser/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409) setNudge({ text: data?.error ?? "The agent is using the browser.", stop: true });
      return data;
    }).catch(() => ({}));
    chain.current = next;
    return next;
  };

  /** Client pixels to page pixels, against the picture actually drawn. */
  const toPage = (clientX: number, clientY: number) => {
    const img = stageRef.current?.querySelector("img.frame") as HTMLImageElement | null;
    if (!img) return null;
    const b = img.getBoundingClientRect();
    const x = ((clientX - b.left) / b.width) * VIEWPORT.w;
    const y = ((clientY - b.top) / b.height) * VIEWPORT.h;
    if (x < 0 || y < 0 || x > VIEWPORT.w || y > VIEWPORT.h) return null;
    return { x: Math.round(x), y: Math.round(y), scale: VIEWPORT.w / b.width };
  };

  const flushScroll = useCallback(() => {
    const { dx, dy } = scrollAccum.current;
    scrollAccum.current.dx = 0;
    scrollAccum.current.dy = 0;
    scrollAccum.current.timer = 0;
    if (Math.abs(dx) + Math.abs(dy) >= 1) void send("scroll", { dx, dy });
  }, [send]);

  const queueScroll = useCallback((dx: number, dy: number) => {
    scrollAccum.current.dx += dx;
    scrollAccum.current.dy += dy;
    if (!scrollAccum.current.timer) {
      scrollAccum.current.timer = window.setTimeout(flushScroll, 70);
    }
  }, [flushScroll]);

  // The wheel has to be a native listener: React's is passive, and a wheel
  // over the page that also scrolls the conversation behind it is useless.
  useEffect(() => {
    const el = stageRef.current;
    if (!el || !canUse) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      queueScroll(e.deltaX, e.deltaY);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [canUse, queueScroll]);

  /** Whether a drag on the stage scrolls the page. Inline on a phone it
      scrolls the conversation instead -- otherwise a page in the middle of the
      thread is a wall you cannot scroll past -- and the expanded view is where
      you scroll the page itself. */
  const dragScrollsPage = max;

  const refuse = () => {
    if (driving) setNudge({ text: "The agent is using the browser.", stop: !!onStop });
  };

  const click = (clientX: number, clientY: number, button: "left" | "right", touch: boolean) => {
    if (!canUse) { refuse(); return; }
    const at = toPage(clientX, clientY);
    if (!at) return;
    const sink = sinkRef.current;
    const focusSink = () => {
      if (!sink) return;
      sink.value = SENTINEL;
      sink.focus({ preventScroll: true });
    };
    // Focus inside the gesture: iOS only raises the keyboard for a focus
    // that descends from a tap. On a touch screen, only for a tap on one of
    // the page's fields -- focusing for every tap flashed the keyboard up
    // and straight back down on every button. A mouse raises no keyboard,
    // so there the keys are always ready.
    if (!touch || onField(at.x, at.y)) focusSink();
    const id = Date.now() + Math.random();
    setRipples((prev) => [...prev, { id, x: at.x, y: at.y }]);
    window.setTimeout(() => setRipples((prev) => prev.filter((r) => r.id !== id)), 600);
    void send("click", { x: at.x, y: at.y, button }).then((result: any) => {
      if (!touch || !result || typeof result.editable !== "boolean") return;
      // Tapped something that is not a field: put the phone's keyboard away.
      if (!result.editable) sink?.blur();
      // A field the map had not caught up with yet. Android still raises the
      // keyboard this soon after the tap; iOS needs a second tap, which the
      // refreshed map then catches.
      else if (document.activeElement !== sink) focusSink();
    });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    // A touch is followed by emulated mouse events, and that mousedown lands
    // on the stage -- which is not focusable -- and blurs the keyboard sink
    // the tap just focused. Cancelling here suppresses them. Scrolling is
    // governed by touch-action, not by this.
    if (canUse) e.preventDefault();
    pointer.current = { x: e.clientX, y: e.clientY, lastY: e.clientY, moved: false, type: e.pointerType };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const p = pointer.current;
    if (!p) return;
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > 10) p.moved = true;
    if (canUse && p.type !== "mouse" && dragScrollsPage && p.moved) {
      const scale = toPage(e.clientX, e.clientY)?.scale ?? 1;
      queueScroll(0, (p.lastY - e.clientY) * scale);
      p.lastY = e.clientY;
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const p = pointer.current;
    pointer.current = null;
    if (!p || p.moved || e.button === 2) return;
    click(e.clientX, e.clientY, "left", p.type !== "mouse");
  };

  const onSinkKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!canUse) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.length === 1) {
      if (e.key.toLowerCase() === "v") return; // the paste event carries it
      e.preventDefault();
      void send("key", { key: `Control+${e.key.toLowerCase()}` });
      return;
    }
    if (NAMED_KEYS.has(e.key)) {
      e.preventDefault();
      if (e.key === "Escape" && max) setMax(false);
      void send("key", { key: e.key });
    }
  };

  const onSinkInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
    const sink = e.currentTarget;
    const value = sink.value;
    sink.value = SENTINEL;
    if (!canUse) return;
    if (!value.includes(SENTINEL) && value.length === 0) {
      void send("key", { key: "Backspace" });
      return;
    }
    const text = value.split(SENTINEL).join("");
    if (text) typeText(text);
  };

  const onSinkPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text");
    if (canUse && text) typeText(text);
  };

  // The narration follows its newest line, unless the reader scrolled up in it.
  // Above the early return: a hook after it runs on some renders and not
  // others, and React throws when the first screenshot arrives.
  useLayoutEffect(() => {
    const el = logRef.current;
    if (el && logFollows.current) el.scrollTop = el.scrollHeight;
  });

  if (shots.length === 0 && actions.length === 0 && !feed) return null;

  const shot = shots[Math.min(Math.max(at, 0), shots.length - 1)];
  const Icon = source === "browser" ? IconGlobe : IconMonitor;
  const stageSrc = watching
    ? `data:${feed.mime};base64,${feed.data}`
    : shot
      ? `/api/sessions/${sessionId}/blobs/${shot.blob}`
      : null;
  const latest = actions[actions.length - 1];
  const big = bigChoice ?? (source === "browser" && live && (watching || !stageSrc));
  const waiting = !stageSrc && source === "browser" && live;

  /* `short` is what a phone has room for beside the address bar. */
  const state: { label: string; short: string; tone: string } | null =
    waitingOnYou && canUse ? { label: "your turn", short: "your turn", tone: "is-yours" }
      : canUse ? { label: "live · yours to use", short: "yours", tone: "is-open" }
        : watching && driving ? { label: "agent driving", short: "agent", tone: "is-driving" }
          : watching ? { label: "live", short: "live", tone: "is-open" }
            : live ? { label: "live", short: "live", tone: "is-driving" }
              : null;
  /** The browser's own toolbar -- back, reload, the address -- on the page
      that is open now, and usable whenever the page is yours. */
  const toolbar = source === "browser" && current && watching;
  const go = (e: React.FormEvent) => {
    e.preventDefault();
    const target = address.trim();
    addressRef.current?.blur();
    if (!target || !canUse) return;
    const url = /^[a-z][a-z0-9+.-]*:/i.test(target) ? target
      : /^[^\s]+\.[^\s]+$/.test(target) ? `https://${target}`
        : `https://duckduckgo.com/?q=${encodeURIComponent(target)}`;
    void send("navigate", { url });
  };

  return (
    <section
      className={`cell shot ${live ? "is-live" : ""} ${
        max ? "is-max" : ""} ${waitingOnYou && canUse ? "is-yours" : ""}`}
    >
      <header className="cell-top">
        {toolbar ? (
          <>
            <button
              className="shot-tool"
              disabled={!canUse}
              onClick={() => void send("back", {})}
              aria-label="Back"
              title="Back"
            >
              <IconArrowLeft size={15} />
            </button>
            <button
              className="shot-tool"
              disabled={!canUse}
              onClick={() => void send("reload", {})}
              aria-label="Reload"
              title="Reload"
            >
              <IconRotateCcw size={14} />
            </button>
            <form className="shot-address" onSubmit={go}>
              <input
                ref={addressRef}
                className="shot-where"
                value={address}
                readOnly={!canUse}
                onChange={(e) => setAddress(e.target.value)}
                onFocus={(e) => { setEditingAddress(true); if (canUse) e.currentTarget.select(); }}
                onBlur={() => setEditingAddress(false)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") { setAddress(url ?? ""); e.currentTarget.blur(); }
                }}
                title={url ?? undefined}
                aria-label="Address"
                inputMode="url"
                enterKeyHint="go"
                autoCapitalize="off"
                autoCorrect="off"
                autoComplete="off"
                spellCheck={false}
              />
            </form>
          </>
        ) : (
          <>
            <Icon size={13} />
            <span className="shot-where" title={url ?? undefined}>
              {source === "browser" ? (url ?? "about:blank") : "Desktop"}
            </span>
          </>
        )}
        {state && (
          <em className={`cell-chip shot-state ${state.tone}`} title={state.label}>
            <span className="watch-dot" aria-hidden="true" />
            <span className="shot-state-long">{state.label}</span>
            <span className="shot-state-short">{state.short}</span>
          </em>
        )}
        {held && feed && (
          <button className="cell-act" onClick={() => { setHeld(false); setAt(shots.length - 1); }}>
            back to live
          </button>
        )}
        {stageSrc && (
          <button
            className="shot-corner"
            onClick={() => {
              if (!max && !big) { setBigChoice(true); return; }
              setMax((m) => !m);
            }}
            aria-label={max ? "Leave full screen" : "Enlarge"}
            title={max ? "Leave full screen (Esc)" : "Enlarge"}
          >
            {max ? <IconMinimize size={15} /> : <IconMaximize size={15} />}
          </button>
        )}
      </header>

      {waiting && (
        <div className="shot-stage is-waiting">
          <span className="watch-dot" aria-hidden="true" />
          <span>{latest ?? "Starting the browser…"}</span>
        </div>
      )}

      {stageSrc && (
        <div
          ref={stageRef}
          className={`shot-stage ${big ? "is-big" : ""} ${watching ? "is-watching" : ""} ${
            canUse ? "is-usable" : ""} ${canUse && dragScrollsPage ? "is-dragging-page" : ""} ${
            driving && watching ? "is-locked" : ""}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => { pointer.current = null; }}
          onContextMenu={(e) => {
            if (!canUse) return;
            e.preventDefault();
            click(e.clientX, e.clientY, "right", false);
          }}
        >
          <Frame
            src={stageSrc}
            alt={watching ? "the page, live" : source === "browser" ? "page the agent saw" : "desktop the agent saw"}
          >
            {ripples.map((r) => (
              <span
                key={r.id}
                className="click-ripple"
                style={{ left: `${(r.x / VIEWPORT.w) * 100}%`, top: `${(r.y / VIEWPORT.h) * 100}%` }}
              />
            ))}
            {!watching && shot?.mark && (
              <span
                className="marker"
                style={{ left: `${(shot.mark.x / VIEWPORT.w) * 100}%`, top: `${(shot.mark.y / VIEWPORT.h) * 100}%` }}
              />
            )}
            {watching && driving && latest && <span className="shot-caption">{latest}</span>}
            {canUse && typing && <span className="shot-caption is-typing">typing into the page</span>}
          </Frame>

          {nudge && (
            <div className="shot-nudge" role="status" onPointerUp={(e) => e.stopPropagation()}>
              <span>{nudge.text}</span>
              {nudge.stop && onStop && (
                <button className="shot-nudge-stop" onClick={() => { setNudge(null); onStop(); }}>
                  <IconStop size={12} /> Stop it
                </button>
              )}
            </div>
          )}

          {/* Where keys go. Invisible and under the tap, so the keyboard a
              phone raises for it appears exactly as if the page's own field
              had been tapped. */}
          <textarea
            ref={sinkRef}
            className="kbd-sink"
            aria-label="Type into the page"
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            defaultValue={SENTINEL}
            onKeyDown={onSinkKeyDown}
            onInput={onSinkInput}
            onPaste={onSinkPaste}
            onFocus={() => setTyping(true)}
            onBlur={() => setTyping(false)}
            tabIndex={canUse ? 0 : -1}
          />
        </div>
      )}

      {logCount > 0 && !max && (
        <div
          ref={logRef}
          className="shot-log"
          aria-label="What the agent said while working here"
          onScroll={(e) => {
            const el = e.currentTarget;
            logFollows.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
        >
          {children}
        </div>
      )}

      {shots.length > 1 && !max && (
        <div className="shot-strip">
          <input
            type="range"
            min={0}
            max={shots.length - 1}
            value={Math.min(at, shots.length - 1)}
            aria-label={`Frame ${at + 1} of ${shots.length}`}
            onChange={(e) => { setHeld(true); setAt(Number(e.target.value)); }}
          />
          <span className="shot-count">
            {Math.min(at, shots.length - 1) + 1} / {shots.length}
          </span>
        </div>
      )}

      {actions.length > 0 && !max && (
        <div className="shot-acts">
          <button
            className={`shot-acts-toggle ${showActions ? "on" : ""}`}
            onClick={() => setShowActions((v) => !v)}
            aria-expanded={showActions}
          >
            <IconChevron size={11} />
            {actions.length} action{actions.length === 1 ? "" : "s"}
          </button>
          {showActions && (
            <ol className="shot-acts-list">
              {actions.map((a, i) => <li key={i}>{a}</li>)}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}
