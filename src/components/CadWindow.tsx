import { useCallback, useEffect, useRef, useState } from "react";
import { useFullscreen } from "../lib/fullscreen";
import { cadStateNow, onCadState, useCadState } from "../lib/caddesk";
import { useAgentCursor } from "../lib/agentCursor";
import { IconCube, IconMaximize, IconMinimize, IconX } from "./Icons";

/** The colours Autora sends the frame: the custom properties its own pages are drawn from (autora-3d/src/embed.ts maps them). */
const THEME_TOKENS = ["--bg", "--s1", "--s2", "--s4", "--text", "--text-2", "--text-3", "--accent", "--accent-deep", "--accent-light"];

function themeNow(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  const out: Record<string, string> = {};
  for (const token of THEME_TOKENS) {
    const value = style.getPropertyValue(token).trim();
    if (value) out[token] = value;
  }
  return out;
}

/**
 * Autora 3D: the 3D modelling window, beside the conversation.
 *
 * The modeller (autora-3d/, built into /autora-3d/) is a page of this origin in a frame, so the person has the whole
 * app: tap a face to pull it, drag to move, press and hold to add to a selection. The model is not in the frame's
 * hands: it lives on the server (server/caddesk.ts), where the agent's cad_* tools work on it too. This component is
 * the wire between them, and the only one:
 *
 *   - the frame says it is up -> the model is fetched and sent down, with Autora's current theme;
 *   - the person changes it (the frame says so, after a pause in their edits) -> it is saved on the server;
 *   - the agent changes it (the server says so) -> the model is fetched again and sent down.
 */
export function CadWindow({ sessionId, phone }: { sessionId: string; phone: boolean }) {
  const cad = useCadState();
  const frame = useRef<HTMLIFrameElement>(null);
  const ready = useRef(false);
  /** The newest revision the frame is known to have: loaded into it, or made in it. */
  const known = useRef(-1);
  const [trouble, setTrouble] = useState<string | null>(null);
  const [full, setFull] = useFullscreen();
  /* The agent's cursor goes with its changes (the frame draws it: it knows where the toolbar and the shapes are). */
  const [cursorOn] = useAgentCursor();
  const cursorRef = useRef(cursorOn);
  cursorRef.current = cursorOn;

  const post = useCallback((msg: Record<string, unknown>) => {
    frame.current?.contentWindow?.postMessage(msg, window.location.origin);
  }, []);

  /** The model as the server has it, sent to the frame. `agent`: the agent just changed it, so its cursor shows how. */
  const load = useCallback(async (agent = false) => {
    try {
      const res = await fetch(`/api/cad/${encodeURIComponent(sessionId)}/doc`);
      const body = (await res.json().catch(() => null)) as { doc?: unknown; rev?: number; cue?: { seq: number; tool: string }; error?: string } | null;
      if (!res.ok || !body?.doc) throw new Error(body?.error ?? `Autora answered ${res.status}`);
      known.current = Number(body.rev ?? 0);
      post({ autora3d: "load", doc: body.doc, ...(agent && cursorRef.current && body.cue ? { cue: body.cue } : {}) });
      setTrouble(null);
    } catch (err) {
      setTrouble(`The model could not be loaded: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [post, sessionId]);

  /* What the person changed, saved. One request at a time, always the newest: a quick run of edits is one save. */
  const saving = useRef(false);
  const waiting = useRef<unknown>(null);
  const save = useCallback(async (doc: unknown) => {
    waiting.current = doc;
    if (saving.current) return;
    saving.current = true;
    try {
      while (waiting.current) {
        const next = waiting.current;
        waiting.current = null;
        const res = await fetch(`/api/cad/${encodeURIComponent(sessionId)}/doc`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ doc: next }),
        });
        const body = (await res.json().catch(() => null)) as { rev?: number; error?: string } | null;
        if (!res.ok) throw new Error(body?.error ?? `Autora answered ${res.status}`);
        known.current = Math.max(known.current, Number(body?.rev ?? 0));
        setTrouble(null);
      }
    } catch (err) {
      setTrouble(`Your last change was not saved: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      saving.current = false;
    }
  }, [sessionId]);

  // What the frame says.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow || e.origin !== window.location.origin) return;
      const msg = e.data as { autora3d?: string; doc?: unknown } | null;
      if (!msg || typeof msg !== "object") return;
      if (msg.autora3d === "ready") {
        ready.current = true;
        post({ autora3d: "theme", vars: themeNow() });
        void load();
      } else if (msg.autora3d === "changed" && msg.doc) {
        void save(msg.doc);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [load, post, save]);

  // What the agent did: the server says the model moved on, and who moved it.
  useEffect(
    () =>
      onCadState(() => {
        const now = cadStateNow();
        if (!now.open || now.rev === undefined || !ready.current) return;
        if (now.by === "agent" && now.rev > known.current) void load(true);
        else known.current = Math.max(known.current, now.rev);
      }),
    [load],
  );

  // Autora's theme, followed as it is changed in Settings.
  useEffect(() => {
    const watch = new MutationObserver(() => {
      if (ready.current) post({ autora3d: "theme", vars: themeNow() });
    });
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-font", "style"] });
    return () => watch.disconnect();
  }, [post]);

  const close = useCallback(() => {
    void fetch(`/api/cad/${encodeURIComponent(sessionId)}/close`, { method: "POST" }).catch(() => undefined);
  }, [sessionId]);

  const shapes = cad.shapes ?? 0;
  return (
    <div className={`pdf-window${phone ? " is-phone" : ""}${phone && full ? " is-full" : ""}`}>
      <div className="pdf-bar">
        <span className="pdf-bar-ico" aria-hidden="true"><IconCube size={14} /></span>
        <span className="pdf-bar-app">Autora 3D</span>
        <span className="pdf-bar-name">{shapes === 1 ? "1 shape" : `${shapes} shapes`}</span>
        <span className="pdf-bar-note">Saved as you go</span>
        <div className="spacer" />
        {phone && (
          <button
            className="btn icon ghost pdf-full-btn"
            onClick={() => setFull(!full)}
            title={full ? "Back to the conversation" : "Full screen"}
            aria-label={full ? "Back to the conversation" : "Full screen"}
            aria-pressed={full}
          >
            {full ? <IconMinimize size={14} /> : <IconMaximize size={14} />}
          </button>
        )}
        {!phone && (
          <button className="btn icon ghost" onClick={close} title="Put Autora 3D away" aria-label="Put Autora 3D away">
            <IconX size={14} />
          </button>
        )}
      </div>
      {trouble && <div className="pdf-problem" role="status">{trouble}</div>}
      <iframe
        ref={frame}
        className="pdf-frame"
        src={`/autora-3d/index.html?embed=autora&session=${encodeURIComponent(sessionId)}`}
        title="Autora 3D"
        /* No sandbox attribute: this is Autora's own page, served from this origin under its own policy (server/caddesk.ts
           serveCad: scripts from itself only, framed by this app only), and a sandbox that keeps the origin is no sandbox. It
           needs its origin for its saved library, its downloads (STL, GLB) and its dialogs. Nothing the agent wrote runs in it:
           the model is data, and the page draws it with React and three.js. */
        allow="fullscreen"
      />
    </div>
  );
}
