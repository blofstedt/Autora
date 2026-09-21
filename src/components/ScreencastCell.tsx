import { useCallback, useEffect, useRef, useState } from "react";
import type { Shot } from "../lib/derive";
import { Frame } from "./Frame";
import { IconChevron, IconGlobe, IconMonitor, IconX } from "./Icons";

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
  sessionId, source, url, shots, actions, live, pickable,
}: {
  sessionId: string;
  source: "browser" | "desktop";
  url: string | null;
  shots: Shot[];
  actions: string[];
  live: boolean;
  /** Only the newest browser card looks at a page that still exists. */
  pickable: boolean;
}) {
  const [at, setAt] = useState(shots.length - 1);
  const [held, setHeld] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Pick | null>(null);
  const [busy, setBusy] = useState(false);
  const [showActions, setShowActions] = useState(false);
  /** Inline by default, big on request. A screenshot at its natural size is
      two thirds of a laptop screen, and a conversation where every page the
      agent opened is a full screen is a conversation you cannot skim. */
  const [big, setBig] = useState(false);
  const holdRef = useRef(held);
  holdRef.current = held;

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

  if (shots.length === 0 && actions.length === 0) return null;

  const box = picked?.pick?.box;
  const Icon = source === "browser" ? IconGlobe : IconMonitor;

  return (
    <section className={`cell shot ${live ? "is-live" : ""}`}>
      <header className="cell-top">
        <Icon size={13} />
        <span className="shot-where" title={url ?? undefined}>
          {source === "browser" ? (url ?? "about:blank") : "Desktop"}
        </span>
        <div className="spacer" />
        {live && <em className="cell-chip is-running">live</em>}
        {shots.length > 0 && (
          <button
            className={`cell-act ${big ? "on" : ""}`}
            onClick={() => setBig((v) => !v)}
            aria-pressed={big}
          >
            {big ? "shrink" : "expand"}
          </button>
        )}
        {pickable && shots.length > 0 && (
          <button
            className={`cell-act ${selecting ? "on" : ""}`}
            aria-pressed={selecting}
            onClick={() => { setSelecting((v) => !v); setPicked(null); }}
            title="Click an element on the page to ask about it"
          >
            {selecting ? "selecting…" : "select"}
          </button>
        )}
      </header>

      {shot && (
        <div
          className={`shot-stage ${selecting ? "is-selecting" : ""} ${big ? "is-big" : ""}`}
          onClick={onPick}
        >
          <Frame
            src={`/api/sessions/${sessionId}/blobs/${shot.blob}`}
            alt={source === "browser" ? "page the agent saw" : "desktop the agent saw"}
          >
            {shot.mark && (
              <span
                className="marker"
                style={{
                  left: `${(shot.mark.x / VIEWPORT.w) * 100}%`,
                  top: `${(shot.mark.y / VIEWPORT.h) * 100}%`,
                }}
              />
            )}
            {box && at === shots.length - 1 && (
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
          </Frame>
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
