import { useCallback, useState } from "react";
import type { Derived } from "../lib/derive";
import { Frame } from "./Frame";
import { IconGlobe, IconX } from "./Icons";

/** The viewport the harness captures. Frame pixels map to page pixels 1:1. */
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
 * The live browser feed, and a way to point at things in it.
 *
 * Select mode turns the video into a surface you can ask about: click an
 * element and the harness resolves what it is, how it is styled, and where it
 * came from in the source. Describing an element in prose and hoping the agent
 * finds the same one is the slow, imprecise way to ask for a change; pointing
 * at it is not.
 */
export function BrowserView({
  sessionId, frame, url, lastAction,
}: {
  sessionId: string;
  frame: Derived["frame"];
  url: string | null;
  lastAction: Derived["lastAction"];
}) {
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Pick | null>(null);
  const [busy, setBusy] = useState(false);

  const onPick = useCallback(async (e: React.MouseEvent<HTMLDivElement>) => {
    if (!selecting || busy) return;
    const img = (e.currentTarget.querySelector("img.frame-over")
      ?? e.currentTarget.querySelector("img")) as HTMLImageElement | null;
    if (!img) return;
    const box = img.getBoundingClientRect();
    // The frame is letterboxed to fit, so scale from displayed pixels back to
    // the viewport the page actually renders at.
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

  if (!frame) {
    return (
      <div className="empty">
        <span className="empty-ring"><IconGlobe size={20} /></span>
        <h3>No browser activity</h3>
        <p>When the agent opens a page, its live screencast appears here.</p>
      </div>
    );
  }

  // Show the marker only while it is fresh. It is also painted into the page
  // itself so it survives into the recording; this is the crisper version for
  // whoever is watching live.
  const showMarker =
    lastAction?.x != null &&
    lastAction?.y != null &&
    frame.seq - lastAction.seq < 12 &&
    frame.seq >= lastAction.seq;

  const box = picked?.pick?.box;

  return (
    <div className="browser">
      <div className="browser-bar">
        <span className="lights"><i /><i /><i /></span>
        <span className="omnibox" title={url ?? undefined}>{url ?? "about:blank"}</span>
        <button
          className={`btn ghost pickmode ${selecting ? "on" : ""}`}
          aria-pressed={selecting}
          onClick={() => { setSelecting((v) => !v); setPicked(null); }}
          title="Click an element on the page to ask about it"
        >
          {selecting ? "Selecting…" : "Select"}
        </button>
      </div>
      <div
        className={`browser-stage ${selecting ? "is-selecting" : ""}`}
        onClick={onPick}
      >
        <Frame src={`/api/sessions/${sessionId}/blobs/${frame.blob}`} alt="agent browser view">
          {showMarker && (
            <span
              className="marker"
              style={{
                // Coordinates are percentages of the 1280x800 viewport the
                // harness captures, so they survive the image being scaled.
                left: `${((lastAction!.x as number) / VIEWPORT.w) * 100}%`,
                top: `${((lastAction!.y as number) / VIEWPORT.h) * 100}%`,
              }}
            />
          )}
          {box && (
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
    </div>
  );
}

function describe(p: Pick): string {
  const f = p.pick?.fingerprint;
  if (!f) return "Selected";
  const name = f.text ? `“${f.text.slice(0, 40)}”` : `<${f.tag}>`;
  return p.pick?.ref != null ? `[${p.pick.ref}] ${name}` : name;
}
