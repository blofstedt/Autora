import { useCallback, useEffect, useRef, useState } from "react";
import { useFullscreen } from "../lib/fullscreen";
import { onPhotoHand, onPhotoState, photoStateNow, usePhotoState, type PhotoHand } from "../lib/photodesk";
import { clearCursor, reportCursor } from "../lib/cursorPos";
import { getCursorWho, whoColors } from "../lib/cursorWho";
import { IconImage, IconMaximize, IconMinimize } from "./Icons";

/**
 * Autora Photo: the photo editing window, beside the conversation.
 *
 * The editor is PhotoCraft's (Rust, running as WebAssembly), built into /autora-photo/ and shown in a frame of this
 * origin, so the person has all of it: layers, masks, brushes, filters, type. The picture is not in the frame's hands:
 * it lives on the server (server/photodesk.ts), where the agent's photo_* tools work on it too. This component is the
 * wire between them, and the only one (the overlay in photo/overlay/autora.rs is the other end):
 *
 *   - the frame says it is up -> the picture is fetched and sent down;
 *   - the person changes it (the frame says so, after a pause in their edits) -> it is saved on the server;
 *   - the agent changes it (the server says so) -> the picture is fetched again and sent down;
 *   - the person saves or exports a file in the editor -> it is offered as a download here, since a frame cannot start one;
 *   - with Visible work on, the agent's edit (the server says so, `photodesk.hand`) is not loaded as a finished picture:
 *     it is handed to the editor, where the agent's cursor does it with the editor's own controls as a person would, and
 *     the picture it ends with goes back to the server.
 */

/** How long an edit waits for an editor that is still starting before the server does it instead. */
const EDITOR_START_MS = 45_000;

/** The cursor's colour as #rrggbb, which the editor reads: the chat's agent's own, else the theme's accent. */
function cursorColor(): string {
  const own = whoColors()?.accent;
  if (own && /^#[0-9a-f]{6}$/i.test(own)) return own;
  const rgb = getComputedStyle(document.documentElement).getPropertyValue("--accent-rgb").split(",").map((v) => Number(v.trim()));
  if (rgb.length !== 3 || rgb.some((v) => !Number.isFinite(v))) return "#6e5bff";
  return `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;
}
export function PhotoWindow({ sessionId, phone }: { sessionId: string; phone: boolean }) {
  const photo = usePhotoState();
  const frame = useRef<HTMLIFrameElement>(null);
  const ready = useRef(false);
  /** The newest revision the frame is known to have: loaded into it, or made in it. */
  const known = useRef(-1);
  const [trouble, setTrouble] = useState<string | null>(null);
  const [full, setFull] = useFullscreen();
  /* No cursor is played over a picture the server changed: that would be a recording of work already done. With Visible
     work on, the agent's edits are done here, live, by its hand in the editor (`byHand` below); what the server changes
     (Visible work off, or a file opened) simply appears. */

  const post = useCallback((msg: Record<string, unknown>, transfer: Transferable[] = []) => {
    frame.current?.contentWindow?.postMessage(msg, window.location.origin, transfer);
  }, []);

  /** The picture as the server has it, sent to the frame; nothing to send while the chat has none. */
  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/photo/${encodeURIComponent(sessionId)}/doc`, { cache: "no-store" });
      if (res.status === 404) return;
      if (!res.ok) throw new Error(`Autora answered ${res.status}`);
      const bytes = await res.arrayBuffer();
      known.current = Number(res.headers.get("X-Photo-Rev") ?? 0);
      post({ autoraPhoto: "load", name: "work.pcraft", bytes }, [bytes]);
      setTrouble(null);
    } catch (err) {
      setTrouble(`The picture could not be loaded: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [post, sessionId]);

  /* What the person changed, saved. One request at a time, always the newest: a quick run of edits is one save. */
  const saving = useRef(false);
  const waiting = useRef<ArrayBuffer | null>(null);
  const save = useCallback(async (bytes: ArrayBuffer) => {
    waiting.current = bytes;
    if (saving.current) return;
    saving.current = true;
    try {
      while (waiting.current) {
        const next = waiting.current;
        waiting.current = null;
        const res = await fetch(`/api/photo/${encodeURIComponent(sessionId)}/doc`, {
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream" },
          body: next,
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

  /** The agent's edits being done in the editor by hand, by id: answered when the editor says it is done. */
  const handing = useRef(new Map<string, (json: string, bytes: ArrayBuffer | null) => void>());

  /** One edit, done in the editor by the agent's hand, and its answer sent to the server. */
  const byHand = useCallback(async (hand: PhotoHand) => {
    const q = `/api/photo/${encodeURIComponent(sessionId)}/hand`;
    const claim = await fetch(`${q}/claim?id=${encodeURIComponent(hand.id)}`, { method: "POST" })
      .then((r) => (r.ok ? (r.json() as Promise<{ won?: boolean }>) : { won: false }))
      .catch(() => ({ won: false }));
    if (!claim.won) return;
    // The editor may still be starting (a cold start takes a while): the edit waits for it.
    for (let waited = 0; !ready.current && waited < EDITOR_START_MS; waited += 250) await new Promise((r) => setTimeout(r, 250));
    if (!ready.current) {
      await fetch(`${q}/reply?id=${encodeURIComponent(hand.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", "X-Photo-Hand": encodeURIComponent(JSON.stringify({ results: [], error: "the editor did not start" })) },
        body: new ArrayBuffer(0),
      }).catch(() => undefined);
      return;
    }
    const answer = await new Promise<{ json: string; bytes: ArrayBuffer | null }>((resolve) => {
      handing.current.set(hand.id, (json, bytes) => resolve({ json, bytes }));
      post({ autoraPhoto: "hand", json: JSON.stringify({ id: hand.id, commands: hand.commands, who: { name: getCursorWho().name, color: cursorColor() } }) });
    });
    handing.current.delete(hand.id);
    let said: { results?: unknown; error?: unknown } = {};
    try { said = JSON.parse(answer.json) as typeof said; } catch { /* nothing said */ }
    await fetch(`${q}/reply?id=${encodeURIComponent(hand.id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "X-Photo-Hand": encodeURIComponent(JSON.stringify({ results: said.results ?? [], error: said.error })) },
      body: answer.bytes ?? new ArrayBuffer(0),
    }).catch(() => undefined);
    clearCursor();
  }, [post, sessionId]);

  /* The agent's edits to do by hand. The window takes one as soon as it is on the page, even while the editor is still
     starting: someone has it open, so the edit waits for the editor and is done in front of them, never out of sight. */
  useEffect(() => onPhotoHand((hand) => {
    void byHand(hand);
  }), [byHand]);

  /** A file the person saved or exported in the editor, as a download. */
  const offer = useCallback((name: string, bytes: ArrayBuffer) => {
    const url = URL.createObjectURL(new Blob([bytes]));
    const a = document.createElement("a");
    a.href = url;
    a.download = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").slice(0, 120) || "picture";
    a.hidden = true;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }, []);

  // What the frame says.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow || e.origin !== window.location.origin) return;
      const msg = e.data as { autoraPhoto?: string; name?: unknown; bytes?: unknown; json?: unknown; x?: unknown; y?: unknown } | null;
      if (!msg || typeof msg !== "object") return;
      if (msg.autoraPhoto === "ready") {
        ready.current = true;
        void load();
      } else if (msg.autoraPhoto === "changed" && msg.bytes instanceof ArrayBuffer) {
        void save(msg.bytes);
      } else if (msg.autoraPhoto === "file" && msg.bytes instanceof ArrayBuffer && typeof msg.name === "string") {
        offer(msg.name, msg.bytes);
      } else if (msg.autoraPhoto === "handed" && typeof msg.json === "string") {
        let id = "";
        try { id = String((JSON.parse(msg.json) as { id?: unknown }).id ?? ""); } catch { /* not an answer */ }
        handing.current.get(id)?.(msg.json, msg.bytes instanceof ArrayBuffer ? msg.bytes : null);
      } else if (msg.autoraPhoto === "cursor" && typeof msg.x === "number" && typeof msg.y === "number") {
        // The agent's cursor in the editor, for the few words beside it (AgentThought).
        const r = frame.current.getBoundingClientRect();
        reportCursor(r.left + msg.x, r.top + msg.y);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [load, offer, save]);

  // What the agent did: the server says the picture moved on, and who moved it.
  useEffect(
    () =>
      onPhotoState(() => {
        const now = photoStateNow();
        if (!now.open || now.rev === undefined || !ready.current) return;
        // An edit the window made itself, by the agent's hand, is already in it.
        if (now.by === "agent" && now.rev > known.current && now.hand !== now.rev) void load();
        else known.current = Math.max(known.current, now.rev);
      }),
    [load],
  );

  const size = photo.size;
  const layers = photo.layers ?? 0;
  return (
    <div className={`pdf-window${phone ? " is-phone" : ""}${phone && full ? " is-full" : ""}`}>
      {phone && <div className="pdf-bar">
        <span className="pdf-bar-ico" aria-hidden="true"><IconImage size={14} /></span>
        <span className="pdf-bar-app">Autora Photo</span>
        <span className="pdf-bar-name">{size ? `${size.w} × ${size.h}, ${layers === 1 ? "1 layer" : `${layers} layers`}` : "No picture yet"}</span>
        <span className="pdf-bar-note">Saved as you go</span>
        <div className="spacer" />
        <button
          className="btn icon ghost pdf-full-btn"
          onClick={() => setFull(!full)}
          title={full ? "Back to the conversation" : "Full screen"}
          aria-label={full ? "Back to the conversation" : "Full screen"}
          aria-pressed={full}
        >
          {full ? <IconMinimize size={14} /> : <IconMaximize size={14} />}
        </button>
      </div>}
      {trouble && <div className="pdf-problem" role="status">{trouble}</div>}
      <iframe
        ref={frame}
        className="pdf-frame"
        src={`/autora-photo/index.html?embed=autora&session=${encodeURIComponent(sessionId)}${phone ? "&phone=1" : ""}`}
        title="Autora Photo"
        /* No sandbox attribute: this is PhotoCraft's page with Autora's overlay, served from this origin under its own
           policy (server/photodesk.ts servePhoto: scripts and WebAssembly from itself only, framed by this app only), and
           a sandbox that keeps the origin is no sandbox. It needs its origin for its saved preferences and its WebGL. Nothing
           the agent wrote runs in it: the picture is data, and the editor draws it. */
        allow="fullscreen; clipboard-read; clipboard-write"
      />
    </div>
  );
}
