import { useCallback, useEffect, useRef, useState } from "react";
import type { Shot } from "../lib/derive";
import type { LiveFrame } from "../lib/types";
import { Frame } from "./Frame";
import {
  IconArrowLeft,
  IconBot,
  IconChevron,
  IconGlobe,
  IconKeyboard,
  IconLock,
  IconMonitor,
  IconMousePointer,
  IconRotateCcw,
  IconUser,
  IconX,
} from "./Icons";

/** The viewport the browser harness captures. Frame pixels map 1:1 to page
    pixels, so a click at 640,400 is the middle of the picture. */
const VIEWPORT = { w: 1280, h: 800 };

type Pick = {
  ok: boolean;
  text?: string;
  error?: string;
  pick?: {
    kind: string;
    ref: number | null;
    selector: string;
    box: { x: number; y: number; w: number; h: number };
    source: { file?: string; line?: number; component?: string; via?: string } | null;
    fingerprint: { tag: string; id: string | null; classes: string[]; text: string | null };
    params: Record<string, Record<string, string>>;
    retargeted: { tag: string } | null;
  };
};

/**
 * A stretch of screen work — a page, or the relayed desktop — kept where it
 * happened.
 *
 * Every frame the agent produced during this stretch stays with the card, so
 * the way to review what it did on a page is to scroll back to it and move
 * through its own frames. That is what the session scrubber was for, except
 * that this one is already pointed at the thing you wanted to re-watch, and
 * moving it does not drag the rest of the app back in time with it.
 */
export function ScreencastCell({
  sessionId, source, url, shots, actions, live, feed, pickable,
}: {
  sessionId: string;
  source: "browser" | "desktop";
  url: string | null;
  shots: Shot[];
  actions: string[];
  live: boolean;
  /** The video, if this is the card whose page is still open. Frames arrive
      several times a second and are never stored, so this is the one thing on
      the card that is happening rather than having happened. */
  feed: LiveFrame | null;
  /** Only the newest browser card looks at a page that still exists. */
  pickable: boolean;
}) {
  const [at, setAt] = useState(shots.length - 1);
  const [held, setHeld] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Pick | null>(null);
  const [busy, setBusy] = useState(false);
  const [showActions, setShowActions] = useState(false);
  /** Big while the agent is driving the page right now, inline otherwise. A
      finished card at full size is two thirds of a laptop screen and makes a
      conversation you cannot skim; the page the agent is working in *now* is
      the thing you are there to watch. Either toggle overrides it. */
  const [bigChoice, setBigChoice] = useState<boolean | null>(null);
  const [interactive, setInteractive] = useState(false);
  const [controlHolder, setControlHolder] = useState<"agent" | "human">("agent");
  const [handoffReason, setHandoffReason] = useState<string | null>(null);
  const [typeInput, setTypeInput] = useState("");
  const [maskPassword, setMaskPassword] = useState(false);
  const [navUrl, setNavUrl] = useState(url ?? "");
  const [navBusy, setNavBusy] = useState(false);
  const [clickRipples, setClickRipples] = useState<Array<{ id: number; x: number; y: number }>>([]);
  const [hoverCoords, setHoverCoords] = useState<{ x: number; y: number } | null>(null);
  const holdRef = useRef(held);
  holdRef.current = held;

  const wheelTimerRef = useRef<number | null>(null);
  const wheelAccumRef = useRef<{ dx: number; dy: number }>({ dx: 0, dy: 0 });

  // Poll browser control status for handoff requests and external changes
  useEffect(() => {
    if (source !== "browser" || (!feed && !live)) return;
    const checkControl = async () => {
      try {
        const res = await fetch(`/api/sessions/${sessionId}/browser/status`);
        if (res.ok) {
          const status = await res.json();
          const holder = status?.control?.holder === "human" ? "human" : "agent";
          setControlHolder(holder);
          setInteractive(holder === "human");
          if (status?.control?.reason) {
            setHandoffReason(status.control.reason);
          } else if (holder === "agent") {
            setHandoffReason(null);
          }
          if (status?.url && !navUrl) {
            setNavUrl(status.url);
          }
        }
      } catch {}
    };
    checkControl();
    const interval = setInterval(checkControl, 1500);
    return () => clearInterval(interval);
  }, [sessionId, source, feed, live, navUrl]);

  const setControlMode = async (target: "agent" | "human", reason?: string) => {
    const isHuman = target === "human";
    setInteractive(isHuman);
    setControlHolder(target);
    if (!isHuman) {
      setHandoffReason(null);
    }
    try {
      await fetch(`/api/sessions/${sessionId}/browser/control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          holder: target,
          reason: reason ?? (isHuman ? "Human manual takeover" : null),
        }),
      });
    } catch {}
  };

  const toggleInteractive = () => {
    if (interactive) {
      setControlMode("agent");
    } else {
      setControlMode("human", handoffReason || "Manual user takeover");
    }
  };

  const sendClick = async (x: number, y: number, button = "left", double = false) => {
    try {
      await fetch(`/api/sessions/${sessionId}/browser/click`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ x, y, button, double }),
      });
    } catch {}
  };

  const sendType = async (text: string) => {
    if (!text) return;
    try {
      await fetch(`/api/sessions/${sessionId}/browser/type`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
    } catch {}
  };

  const sendKey = async (key: string) => {
    try {
      await fetch(`/api/sessions/${sessionId}/browser/key`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });
    } catch {}
  };

  const sendReload = async () => {
    setNavBusy(true);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/browser/reload`, { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        if (data.url) setNavUrl(data.url);
      }
    } catch {} finally {
      setNavBusy(false);
    }
  };

  const sendBack = async () => {
    setNavBusy(true);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/browser/back`, { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        if (data.url) setNavUrl(data.url);
      }
    } catch {} finally {
      setNavBusy(false);
    }
  };

  const onWheel = useCallback((e: React.WheelEvent) => {
    if (!interactive || source !== "browser") return;
    wheelAccumRef.current.dx += e.deltaX;
    wheelAccumRef.current.dy += e.deltaY;
    if (!wheelTimerRef.current) {
      wheelTimerRef.current = window.setTimeout(async () => {
        const { dx, dy } = wheelAccumRef.current;
        wheelAccumRef.current = { dx: 0, dy: 0 };
        wheelTimerRef.current = null;
        try {
          await fetch(`/api/sessions/${sessionId}/browser/scroll`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ dx, dy }),
          });
        } catch {}
      }, 60);
    }
  }, [interactive, source, sessionId]);

  const onStageKeyDown = (e: React.KeyboardEvent) => {
    if (!interactive || source !== "browser") return;
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT") {
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      sendKey("Tab");
    } else if (e.key === "Enter") {
      e.preventDefault();
      sendKey("Enter");
    } else if (e.key === "Backspace") {
      e.preventDefault();
      sendKey("Backspace");
    } else if (e.key === "Escape") {
      e.preventDefault();
      sendKey("Escape");
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      sendKey("ArrowDown");
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      sendKey("ArrowUp");
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      sendKey("ArrowLeft");
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      sendKey("ArrowRight");
    } else if (e.key === " ") {
      e.preventDefault();
      sendKey("Space");
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      sendType(e.key);
    }
  };

  const pasteClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        await sendType(text);
      }
    } catch {
      // Fallback: prompt user if browser clipboard access is blocked
      const text = window.prompt("Paste credentials or text to send directly to the browser:");
      if (text) await sendType(text);
    }
  };

  const onNavigate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!navUrl.trim()) return;
    setNavBusy(true);
    try {
      await fetch(`/api/sessions/${sessionId}/browser/navigate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: navUrl.trim() }),
      });
    } catch {} finally {
      setNavBusy(false);
    }
  };

  // Follow the newest frame unless someone has taken hold of the strip, which
  // is the whole point of being able to take hold of it.
  useEffect(() => {
    if (!holdRef.current) setAt(shots.length - 1);
  }, [shots.length]);

  const shot = shots[Math.min(Math.max(at, 0), shots.length - 1)];

  const onPick = useCallback(async (e: React.MouseEvent<HTMLDivElement>) => {
    if (!selecting || busy) return;
    const img = (e.currentTarget.querySelector("img.frame-over")
      ?? e.currentTarget.querySelector("img")) as HTMLImageElement | null;
    if (!img) return;
    const box = img.getBoundingClientRect();
    const x = ((e.clientX - box.left) / box.width) * VIEWPORT.w;
    const y = ((e.clientY - box.top) / box.height) * VIEWPORT.h;
    if (x < 0 || y < 0 || x > VIEWPORT.w || y > VIEWPORT.h) return;

    setBusy(true);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/pick`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ x, y }),
      });
      setPicked(await res.json());
    } catch {
      setPicked({ ok: false, error: "Could not reach the page." });
    } finally {
      setBusy(false);
    }
  }, [selecting, busy, sessionId]);

  if (shots.length === 0 && actions.length === 0 && !feed) return null;

  const box = picked?.pick?.box;
  const Icon = source === "browser" ? IconGlobe : IconMonitor;

  /* Watching, rather than reviewing. The feed only ever reaches the card whose
     page is still open, and taking hold of the frame strip is what says "stop
     following, I want to look at something that already happened" -- the same
     gesture that already meant that for stored frames. */
  const watching = !!feed && !held;
  const stageSrc = watching
    ? `data:${feed.mime};base64,${feed.data}`
    : shot
      ? `/api/sessions/${sessionId}/blobs/${shot.blob}`
      : null;
  const latest = actions[actions.length - 1];
  const big = bigChoice ?? (source === "browser" && live && (watching || !stageSrc));
  /* The card appears the moment the agent says what it is opening, which is
     before Chrome has painted anything. Showing the stage anyway, with the
     step in words, means you are looking at the right place when the first
     frame lands rather than at a header that grows a picture later. */
  const waiting = !stageSrc && source === "browser" && live;

  return (
    <section className={`cell shot ${live ? "is-live" : ""}`}>
      <header className="cell-top">
        <Icon size={13} />
        <span className="shot-where" title={url ?? undefined}>
          {source === "browser" ? (url ?? "about:blank") : "Desktop"}
        </span>

        {/* Clear UI indicator for who holds browser control */}
        {source === "browser" && (
          controlHolder === "human" ? (
            <div
              className="browser-control-indicator is-human"
              title="Human in Control: Keystrokes, mouse pointer, and wheel scrolling are forwarded directly to the page."
            >
              <span className="browser-control-dot" />
              <IconUser size={12} />
              <span>Human in Control</span>
            </div>
          ) : (
            <div
              className="browser-control-indicator is-agent"
              title="Autonomous Mode: AI Agent operates the browser automatically."
            >
              <span className="browser-control-dot" />
              <IconBot size={12} />
              <span>Agent in Control</span>
            </div>
          )
        )}

        <div className="spacer" />

        {/* Two different claims, deliberately worded differently: "watching"
            means frames are arriving right now, "live" means this is the
            newest card in a turn that has not finished. The first is the one
            worth trusting. */}
        {watching ? (
          <em className="cell-chip is-watching" title={`${feed ? "streaming" : ""}`}>
            <span className="watch-dot" aria-hidden="true" />
            watching
          </em>
        ) : feed ? (
          <button className="cell-act" onClick={() => { setHeld(false); setAt(shots.length - 1); }}>
            back to live
          </button>
        ) : live ? (
          <em className="cell-chip is-running">live</em>
        ) : null}
        {(shots.length > 0 || feed) && (
          <button
            className={`cell-act ${big ? "on" : ""}`}
            onClick={() => setBigChoice(!big)}
            aria-pressed={big}
          >
            {big ? "shrink" : "expand"}
          </button>
        )}
        {pickable && (shots.length > 0 || feed) && (
          <button
            className={`cell-act ${selecting ? "on" : ""}`}
            aria-pressed={selecting}
            onClick={() => { setSelecting((v) => !v); setPicked(null); }}
            title="Click an element on the page to ask about it"
          >
            {selecting ? "selecting…" : "select"}
          </button>
        )}
        {source === "browser" && (watching || live) && (
          <button
            className={`cell-act ${interactive ? "on" : ""}`}
            onClick={toggleInteractive}
            title={interactive ? "Return control to AI agent" : "Take direct control of keyboard and pointer"}
            style={interactive ? { background: "#4f46e5", color: "#fff", borderColor: "transparent" } : undefined}
          >
            {interactive ? (
              <>
                <IconBot size={12} />
                <span>hand back</span>
              </>
            ) : (
              <>
                <IconUser size={12} />
                <span>take control</span>
              </>
            )}
          </button>
        )}
      </header>

      {/* Prominent Handoff Banner: shows when handoff is requested (e.g. SSO login, CAPTCHA) */}
      {source === "browser" && handoffReason && (
        <div className={`browser-handoff-alert ${interactive ? "is-active" : ""}`}>
          <div className="browser-handoff-main">
            <span className={`browser-handoff-tag ${interactive ? "is-active" : ""}`}>
              {interactive ? "Handoff Active" : "Action Needed"}
            </span>
            <div className="browser-handoff-desc">
              <strong>{interactive ? "Human in Control: " : "Agent Requested Intervention: "}</strong>
              {handoffReason}
              <div style={{ fontSize: "11px", color: "var(--text-3)", marginTop: "2px" }}>
                Keystrokes &amp; SSO passwords entered here are forwarded directly to Chrome and never saved to chat logs.
              </div>
            </div>
          </div>
          <div className="browser-handoff-actions">
            {interactive ? (
              <button
                type="button"
                className="browser-handoff-btn hand-back"
                onClick={() => setControlMode("agent")}
              >
                <IconBot size={13} />
                <span>Done / Hand Back</span>
              </button>
            ) : (
              <button
                type="button"
                className="browser-handoff-btn take-control"
                onClick={() => setControlMode("human", handoffReason)}
              >
                <IconUser size={13} />
                <span>Take Control &amp; Sign In</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* When interactive takeover is on without a specific handoff reason */}
      {source === "browser" && interactive && !handoffReason && (
        <div className="browser-handoff-alert is-active">
          <div className="browser-handoff-main">
            <span className="browser-handoff-tag is-active">
              <IconUser size={11} /> Human Active
            </span>
            <div className="browser-handoff-desc">
              <strong>You have direct keyboard and pointer control.</strong> Click the page to focus, scroll with mouse wheel, or type credentials below.
            </div>
          </div>
          <div className="browser-handoff-actions">
            <button
              type="button"
              className="browser-handoff-btn hand-back"
              onClick={() => setControlMode("agent")}
            >
              <IconBot size={13} />
              <span>Hand Back to Agent</span>
            </button>
          </div>
        </div>
      )}

      {waiting && (
        <div className="shot-stage is-waiting">
          <span className="watch-dot" aria-hidden="true" />
          <span>{latest ?? "Starting the browser…"}</span>
        </div>
      )}

      {stageSrc && (
        <div
          tabIndex={interactive ? 0 : undefined}
          className={`shot-stage ${selecting ? "is-selecting" : ""} ${big ? "is-big" : ""} ${
            watching ? "is-watching" : ""}`}
          style={interactive ? { cursor: "crosshair", outline: "none" } : undefined}
          onWheel={onWheel}
          onKeyDown={onStageKeyDown}
          onContextMenu={(e) => {
            if (interactive) e.preventDefault();
          }}
          onMouseMove={(e) => {
            if (!interactive || source !== "browser") return;
            const img = (e.currentTarget.querySelector("img.frame-over")
              ?? e.currentTarget.querySelector("img")) as HTMLImageElement | null;
            if (!img) return;
            const b = img.getBoundingClientRect();
            const x = Math.round(((e.clientX - b.left) / b.width) * VIEWPORT.w);
            const y = Math.round(((e.clientY - b.top) / b.height) * VIEWPORT.h);
            if (x >= 0 && y >= 0 && x <= VIEWPORT.w && y <= VIEWPORT.h) {
              setHoverCoords({ x, y });
            }
          }}
          onMouseLeave={() => setHoverCoords(null)}
          onClick={(e) => {
            if (selecting) {
              onPick(e);
              return;
            }
            if (!interactive || source !== "browser") return;
            const img = (e.currentTarget.querySelector("img.frame-over")
              ?? e.currentTarget.querySelector("img")) as HTMLImageElement | null;
            if (!img) return;
            const b = img.getBoundingClientRect();
            const x = Math.round(((e.clientX - b.left) / b.width) * VIEWPORT.w);
            const y = Math.round(((e.clientY - b.top) / b.height) * VIEWPORT.h);
            if (x < 0 || y < 0 || x > VIEWPORT.w || y > VIEWPORT.h) return;

            // Transient visual click ripple
            const rippleId = Date.now() + Math.random();
            setClickRipples((prev) => [...prev, { id: rippleId, x, y }]);
            setTimeout(() => {
              setClickRipples((prev) => prev.filter((r) => r.id !== rippleId));
            }, 600);

            sendClick(x, y, e.button === 2 ? "right" : "left", e.detail === 2);
          }}
        >
          <Frame
            src={stageSrc}
            alt={
              watching
                ? "the page, live"
                : source === "browser" ? "page the agent saw" : "desktop the agent saw"
            }
          >
            {/* User click ripples */}
            {interactive && clickRipples.map((r) => (
              <span
                key={r.id}
                className="click-ripple"
                style={{
                  left: `${(r.x / VIEWPORT.w) * 100}%`,
                  top: `${(r.y / VIEWPORT.h) * 100}%`,
                }}
              />
            ))}

            {/* A stored frame gets a painted marker where the click landed. */}
            {!watching && shot?.mark && (
              <span
                className="marker"
                style={{
                  left: `${(shot.mark.x / VIEWPORT.w) * 100}%`,
                  top: `${(shot.mark.y / VIEWPORT.h) * 100}%`,
                }}
              />
            )}
            {box && !watching && at === shots.length - 1 && (
              <span
                className="pickbox"
                style={{
                  left: `${(box.x / VIEWPORT.w) * 100}%`,
                  top: `${(box.y / VIEWPORT.h) * 100}%`,
                  width: `${(box.w / VIEWPORT.w) * 100}%`,
                  height: `${(box.h / VIEWPORT.h) * 100}%`,
                }}
              />
            )}
            {/* What it is doing, over the picture of it doing it. */}
            {watching && latest && !interactive && <span className="shot-caption">{latest}</span>}

            {/* Interactive mode status tag on stage */}
            {interactive && hoverCoords && (
              <span className="shot-caption" style={{ left: "auto", right: "10px" }}>
                {hoverCoords.x}, {hoverCoords.y}
              </span>
            )}
          </Frame>
        </div>
      )}

      {/* Interactive Control Panel */}
      {source === "browser" && interactive && (
        <div className="browser-interactive-bar">
          {/* Address & Navigation bar */}
          <form onSubmit={onNavigate} style={{ display: "flex", gap: "6px", alignItems: "center" }}>
            <button
              type="button"
              className="cell-act"
              onClick={sendBack}
              disabled={navBusy}
              title="Navigate back"
            >
              <IconArrowLeft size={12} />
              <span>Back</span>
            </button>
            <button
              type="button"
              className="cell-act"
              onClick={sendReload}
              disabled={navBusy}
              title="Reload current page"
            >
              <IconRotateCcw size={12} />
              <span>Reload</span>
            </button>
            <input
              type="text"
              value={navUrl}
              onChange={(e) => setNavUrl(e.target.value)}
              placeholder="https://..."
              style={{
                flex: 1,
                padding: "5px 9px",
                fontSize: "12px",
                borderRadius: "4px",
                border: "1px solid rgba(255,255,255,0.15)",
                background: "rgba(0,0,0,0.4)",
                color: "#fff",
              }}
            />
            <button type="submit" className="cell-act" disabled={navBusy}>
              {navBusy ? "Going…" : "Go"}
            </button>
          </form>

          {/* Direct typing and keyboard shortcuts */}
          <div style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
            <input
              type={maskPassword ? "password" : "text"}
              value={typeInput}
              onChange={(e) => setTypeInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  sendType(typeInput);
                  sendKey("Enter");
                  setTypeInput("");
                }
              }}
              placeholder={maskPassword ? "Type password / token then press Enter…" : "Type credentials or text here, then press Enter…"}
              style={{
                flex: "1 1 220px",
                padding: "5px 9px",
                fontSize: "12px",
                borderRadius: "4px",
                border: "1px solid rgba(255,255,255,0.15)",
                background: "rgba(0,0,0,0.4)",
                color: "#fff",
              }}
            />
            <button
              type="button"
              className={`cell-act ${maskPassword ? "on" : ""}`}
              onClick={() => setMaskPassword((v) => !v)}
              title={maskPassword ? "Click to reveal typed characters" : "Click to mask typed characters"}
            >
              <IconLock size={12} />
              <span>{maskPassword ? "Masked" : "Mask"}</span>
            </button>
            <button
              type="button"
              className="cell-act"
              onClick={() => {
                if (typeInput) {
                  sendType(typeInput);
                  setTypeInput("");
                }
              }}
            >
              Type
            </button>
            <button
              type="button"
              className="cell-act"
              onClick={pasteClipboard}
              title="Paste text from clipboard directly into focused browser input"
            >
              Paste Clipboard
            </button>
            <button type="button" className="cell-act" onClick={() => sendKey("Enter")}>
              Enter ↵
            </button>
            <button type="button" className="cell-act" onClick={() => sendKey("Tab")}>
              Tab ⇥
            </button>
            <button type="button" className="cell-act" onClick={() => sendKey("Backspace")}>
              ⌫
            </button>
            <button type="button" className="cell-act" onClick={() => sendKey("Escape")}>
              Esc
            </button>
            <button type="button" className="cell-act" onClick={() => sendKey("Space")}>
              Space
            </button>
          </div>

          <div className="browser-interactive-hint">
            <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
              <IconMousePointer size={12} />
              <IconKeyboard size={12} />
              <span>
                <strong>Tip:</strong> Click the screen to focus fields, or type directly with your physical keyboard (<kbd>Tab</kbd>, <kbd>Enter</kbd>, <kbd>Backspace</kbd>, letters). Mouse wheel scrolls.
              </span>
            </span>
            <span style={{ fontFamily: "var(--mono)", fontSize: "10.5px" }}>
              1280 × 800
            </span>
          </div>
        </div>
      )}

      {shots.length > 1 && (
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
          {held && (
            <button
              className="cell-act"
              onClick={() => { setHeld(false); setAt(shots.length - 1); }}
            >
              latest
            </button>
          )}
        </div>
      )}

      {actions.length > 0 && (
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

      {picked && (
        <aside className="pickpanel">
          <div className="pp-top">
            <b>{picked.ok ? describe(picked) : "Nothing there"}</b>
            <div className="spacer" />
            <button className="btn icon ghost" onClick={() => setPicked(null)}
                    aria-label="Dismiss selection">
              <IconX size={13} />
            </button>
          </div>
          {picked.ok && picked.pick ? (
            <>
              {picked.pick.source?.file ? (
                <div className="pp-source">
                  {picked.pick.source.file}
                  {picked.pick.source.line ? `:${picked.pick.source.line}` : ""}
                  {picked.pick.source.component ? ` · <${picked.pick.source.component}>` : ""}
                </div>
              ) : (
                <div className="pp-source muted">
                  source not exposed by this build — selector{" "}
                  <code>{picked.pick.selector}</code>
                </div>
              )}
              <div className="pp-params">
                {Object.entries(picked.pick.params).map(([group, values]) => (
                  <div className="pp-group" key={group}>
                    <span className="pp-glabel">{group}</span>
                    {Object.entries(values).map(([k, v]) => (
                      <div className="pp-row" key={k}>
                        <span>{k}</span>
                        <em>{v}</em>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
              <p className="pp-hint">
                The agent has been told what you picked — say what you want changed.
              </p>
            </>
          ) : (
            <p className="pp-hint">{picked.error}</p>
          )}
        </aside>
      )}
    </section>
  );
}

function describe(p: Pick): string {
  const f = p.pick?.fingerprint;
  if (!f) return "Selected";
  const name = f.text ? `“${f.text.slice(0, 40)}”` : `<${f.tag}>`;
  return p.pick?.ref != null ? `[${p.pick.ref}] ${name}` : name;
}
