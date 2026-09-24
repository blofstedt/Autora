import { useEffect, useMemo, useRef, useState } from "react";
import type { Widget } from "../lib/derive";
import {
  DEFAULT_PALETTE, usesThree, widgetDocument, WIDGET_MAX_HEIGHT, type WidgetPalette,
} from "../lib/widget";
import { IconAlert, IconMaximize, IconMinimize, IconRotateCcw, IconSpark } from "./Icons";

/**
 * Three.js as a data: URL, fetched once for every widget in the tab.
 *
 * The frame's opaque origin cannot load it from this server itself (see
 * src/widget/three.ts), so the page does, with its own sign-in, and hands it
 * over inline. Null when the server has none to give: the frame then loads
 * it from the CDN, which is still better than a card that never draws.
 */
let threeBundle: Promise<string | null> | null = null;
function loadThree(): Promise<string | null> {
  threeBundle ??= fetch("/widget/three.js")
    .then(async (res) => {
      if (!res.ok) throw new Error(String(res.status));
      const blob = new Blob([await res.arrayBuffer()], { type: "text/javascript" });
      return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
    })
    .catch(() => {
      threeBundle = null;
      return null;
    });
  return threeBundle;
}

/** The thread's own colours, read off the page so every theme carries over. */
function currentPalette(): WidgetPalette {
  const css = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    bg: read("--s1", DEFAULT_PALETTE.bg),
    surface: read("--s2", DEFAULT_PALETTE.surface),
    text: read("--text", DEFAULT_PALETTE.text),
    muted: read("--text-2", DEFAULT_PALETTE.muted),
    accent: read("--accent", DEFAULT_PALETTE.accent),
    accent2: read("--accent-2", DEFAULT_PALETTE.accent2),
    border: read("--border-strong", DEFAULT_PALETTE.border),
    font: read("--sans", DEFAULT_PALETTE.font),
  };
}

/** How many times a widget may grow the card. A canvas sized to the frame
    plus a margin would otherwise grow it forever, a few pixels a report. */
const MAX_GROWTHS = 8;

/**
 * An interactive explainer, live in the conversation.
 *
 * The agent's code runs in a frame sandboxed to scripts only: no same
 * origin, so it cannot read this app's storage, call its API or reach the
 * page around it. What it can do is draw, animate and answer the pointer,
 * which is all an explainer needs.
 *
 * Expanding it is CSS, not the Fullscreen API and not a second frame: the
 * frame is never re-parented, so the orbit you set up or the slider you
 * dragged is still there when it comes back down, and it works on phones
 * that have no element fullscreen.
 */
export function WidgetCell({ widget }: { widget: Widget }) {
  const needsThree = useMemo(() => usesThree(widget.html), [widget.html]);
  const [bundle, setBundle] = useState<string | null | undefined>(needsThree ? undefined : null);
  const [height, setHeight] = useState(widget.height);
  const [errors, setErrors] = useState<string[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [run, setRun] = useState(0);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const growths = useRef(0);
  const heightRef = useRef(widget.height);
  const frameId = `widget-${widget.seq}-${run}`;

  useEffect(() => {
    if (!needsThree) return;
    let live = true;
    void loadThree().then((url) => { if (live) setBundle(url); });
    return () => { live = false; };
  }, [needsThree]);

  // Messages from this widget's frame only: every other frame on the page
  // can post too, and the id alone is something any of them could send.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frameRef.current?.contentWindow) return;
      const data = e.data;
      if (!data || data.autoraWidget !== frameId) return;
      if (typeof data.height === "number" && Number.isFinite(data.height)) {
        const next = Math.min(WIDGET_MAX_HEIGHT, Math.max(widget.height, Math.ceil(data.height)));
        const prev = heightRef.current;
        if (next !== prev && (next < prev || growths.current++ < MAX_GROWTHS)) {
          heightRef.current = next;
          setHeight(next);
        }
      }
      if (typeof data.error === "string" && data.error) {
        setErrors((prev) => prev.includes(data.error) || prev.length >= 3 ? prev : [...prev, data.error]);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [frameId, widget.height]);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setExpanded(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [expanded]);

  const doc = useMemo(
    () => bundle === undefined ? null : widgetDocument({
      title: widget.title,
      html: widget.html,
      palette: currentPalette(),
      threeBundle: bundle,
      frame: frameId,
    }),
    [bundle, widget.title, widget.html, frameId],
  );

  const restart = () => {
    growths.current = 0;
    heightRef.current = widget.height;
    setErrors([]);
    setHeight(widget.height);
    setRun((n) => n + 1);
  };

  return (
    <section className={`cell widget ${expanded ? "is-expanded" : ""} ${errors.length ? "is-bad" : ""}`}>
      <header className="cell-top">
        <IconSpark size={13} />
        <span className="shot-where">{widget.title}</span>
        {needsThree && <i className="cell-chip">3D</i>}
        <span className="spacer" />
        <button className="btn icon ghost" onClick={restart} title="Restart" aria-label="Restart widget">
          <IconRotateCcw size={14} />
        </button>
        <button
          className="btn icon ghost"
          onClick={() => setExpanded((v) => !v)}
          title={expanded ? "Back into the thread (Esc)" : "Expand"}
          aria-label={expanded ? "Collapse widget" : "Expand widget"}
        >
          {expanded ? <IconMinimize size={14} /> : <IconMaximize size={14} />}
        </button>
      </header>

      {errors.length > 0 && (
        <div className="widget-errors" role="status">
          <IconAlert size={13} />
          <span>{errors.join(" · ")}</span>
        </div>
      )}

      <div className="widget-body" style={expanded ? undefined : { height }}>
        {doc === null ? (
          <div className="widget-loading">Loading 3D…</div>
        ) : (
          <iframe
            key={run}
            ref={frameRef}
            title={widget.title}
            className="widget-frame"
            sandbox="allow-scripts allow-pointer-lock"
            srcDoc={doc}
          />
        )}
      </div>
    </section>
  );
}
