import { useCallback, useEffect, useRef, useState } from "react";
import { useFullscreen } from "../lib/fullscreen";
import { holdSurface, useCollab } from "../lib/collab";
import { useDeskState } from "../lib/pdfdesk";
import { onSpectraEvent } from "../lib/spectra";
import { IconDownload, IconFile, IconMaximize, IconMinimize, IconX } from "./Icons";

/**
 * The PDF window: the file the agent is working on, in Spectra-PDF's editor.
 *
 * Spectra's own renderer is a build of its own (spectra-editor/), served at
 * /spectra-editor/. It ran as a Tauri desktop app, talking to Rust over IPC;
 * here those commands go to Autora's server, which owns what each one means
 * (server/spectra.ts, server/spectra/commands.ts), and the engine that had been
 * a Rust child process runs beside it.
 *
 * The frame is sandboxed without an origin of its own -- it renders PDFs from
 * anywhere -- so it cannot reach this app or its API. This component is its
 * only way out: it answers the frame's commands over HTTP and relays the
 * events the frame asked for. That is the whole of the wire between them; the
 * editor's own state, its UI and its history are its own.
 */
export function SpectraWindow({ sessionId, phone }: { sessionId: string; phone: boolean }) {
  const desk = useDeskState();
  const frame = useRef<HTMLIFrameElement>(null);
  /** The event names the frame has asked to be told about. */
  const wanted = useRef(new Set<string>());
  const [trouble, setTrouble] = useState<string | null>(null);
  /** Bumped when the agent changes the document under the editor: the frame is
   *  loaded again, which is the only way it re-reads a file it already has. */
  const [generation, setGeneration] = useState(0);
  /* Whether the person has taken the PDF for themselves: the agent leaves the
     file alone until they hand it back. Autora's own surface, not the editor's
     -- the editor does not know this window exists. */
  const mine = useCollab().held.includes("pdf");
  /** On a phone the pinned view is a third of the screen: editing wants all of it. */
  const [full, setFull] = useFullscreen();

  const post = useCallback((msg: Record<string, unknown>) => {
    frame.current?.contentWindow?.postMessage(msg, "*");
  }, []);

  /** One command from the editor, answered by Autora's server. */
  const invoke = useCallback(
    async (msg: { id?: unknown; command?: unknown; args?: unknown }) => {
      const { id, command } = msg;
      if (typeof id !== "number" || typeof command !== "string") return;
      try {
        const res = await fetch(`/api/spectra/invoke?session=${encodeURIComponent(sessionId)}`, {
          method: "POST",
          /* Not application/json: the app's own JSON parser stops at 5 MB, and a
             command carrying a document's bytes is bigger than that. text/plain
             is read by the route's own parser, which has room for it. */
          headers: { "Content-Type": "text/plain" },
          body: JSON.stringify({ command, args: msg.args ?? {} }),
        });
        const body = (await res.json().catch(() => null)) as { result?: unknown; error?: { message?: string } } | null;
        const failure = body?.error ?? (res.ok ? null : { message: `Autora answered ${res.status}` });
        post({ type: "autora:spectra:result", id, ok: !failure, value: failure ?? body?.result });
        if (!failure) setTrouble(null);
      } catch (err: any) {
        post({ type: "autora:spectra:result", id, ok: false, value: { message: String(err?.message ?? err) } });
      }
    },
    [post, sessionId],
  );

  // What the frame says: it is up, it wants an event, or it is closing.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const msg = e.data;
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "autora:spectra:invoke") {
        void invoke(msg);
      } else if (msg.type === "autora:spectra:listen" && typeof msg.event === "string") {
        wanted.current.add(msg.event);
      } else if (msg.type === "autora:spectra:ready") {
        setTrouble(null);
        /* The editor has booted: tell it to take the document, if it did not
           get one already. The frame can be up before the desk has the file
           (the window opens with the desk's own change), and an editor that
           asked once and found nothing would sit on Home for good. */
        frame.current.contentWindow?.postMessage({ type: "autora:spectra:event", event: "app:openFile", payload: {} }, "*");
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [invoke]);

  // The server's pushes for this session, on to the frame that asked for them.
  useEffect(
    () =>
      onSpectraEvent(({ event, payload }) => {
        /* The agent edited the document: the editor's own event is no use here
           (a hand-over of a path it already has open only focuses the tab), so
           the frame is reloaded and opens the file as it is now. */
        if (event === "autora:reload") {
          setGeneration((n) => n + 1);
          return;
        }
        if (wanted.current.has(event)) post({ type: "autora:spectra:event", event, payload });
      }),
    [post],
  );

  const close = useCallback(() => {
    void fetch(`/api/spectra/close?session=${encodeURIComponent(sessionId)}`, { method: "POST" }).catch(() => undefined);
  }, [sessionId]);

  return (
    <div className={`pdf-window${phone ? " is-phone" : ""}${phone && full ? " is-full" : ""}`}>
      <div className="pdf-bar">
        <span className="pdf-bar-ico" aria-hidden="true"><IconFile size={14} /></span>
        <span className="pdf-bar-app">Autora PDF</span>
        <span className="pdf-bar-name" title={desk.name ?? undefined}>{desk.name ?? "PDF"}</span>
        <span className="pdf-bar-note">Saved as you go</span>
        <div className="spacer" />
        <button
          className={`pdf-pill${mine ? " is-accept" : ""}`}
          onClick={() => void holdSurface(sessionId, "pdf", !mine)}
          aria-pressed={mine}
          title={mine ? "Let the agent work on the PDF again" : "Work on the PDF yourself; the agent carries on with other work"}
        >
          {mine ? "Hand back" : "Take control"}
        </button>
        {desk.working && (
          <a
            className="btn icon ghost"
            href={`/api/artifacts/${desk.working}?download`}
            title="Download the file as it is now"
            aria-label="Download the file as it is now"
          >
            <IconDownload size={14} />
          </a>
        )}
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
          <button className="btn icon ghost" onClick={close} title="Put Autora PDF away" aria-label="Put Autora PDF away">
            <IconX size={14} />
          </button>
        )}
      </div>
      {trouble && <div className="pdf-problem" role="status">{trouble}</div>}
      <iframe
        ref={frame}
        key={generation}
        className="pdf-frame"
        src={`/spectra-editor/index.html?session=${encodeURIComponent(sessionId)}`}
        title={`${desk.name ?? "PDF"}, in Autora PDF`}
        sandbox="allow-scripts allow-downloads allow-modals allow-popups"
      />
    </div>
  );
}
