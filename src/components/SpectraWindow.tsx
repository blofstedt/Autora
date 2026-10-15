import { useCallback, useEffect, useRef, useState } from "react";
import { useFullscreen } from "../lib/fullscreen";
import { useCollab } from "../lib/collab";
import { TakeControl } from "./TakeControl";
import { onDeskHand, useDeskState, type DeskHand } from "../lib/pdfdesk";
import { useBootWatch } from "../lib/bootWatch";
import { clearCursor, reportCursor } from "../lib/cursorPos";
import { getCursorWho, whoColors } from "../lib/cursorWho";
import { onSpectraEvent } from "../lib/spectra";
import { useFrameTheme } from "../lib/frameTheme";
import { IconDownload, IconFile, IconMaximize, IconMinimize } from "./Icons";

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
/** How long an edit waits for an editor that is still starting before the server does it instead. */
const EDITOR_START_MS = 45_000;

/** The cursor's colour as #rrggbb, which the frame draws with: the chat's agent's own, else the theme's accent. */
function cursorColor(): string {
  const own = whoColors()?.accent;
  if (own && /^#[0-9a-f]{6}$/i.test(own)) return own;
  const rgb = getComputedStyle(document.documentElement).getPropertyValue("--accent-rgb").split(",").map((v) => Number(v.trim()));
  if (rgb.length !== 3 || rgb.some((v) => !Number.isFinite(v))) return "#6e5bff";
  return `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;
}

export function SpectraWindow({ sessionId, phone }: { sessionId: string; phone: boolean }) {
  const desk = useDeskState();
  const frame = useRef<HTMLIFrameElement>(null);
  /** The event names the frame has asked to be told about. */
  const wanted = useRef(new Set<string>());
  const [trouble, setTrouble] = useState<string | null>(null);
  /** Bumped when the agent changes the document under the editor: the frame is
   *  loaded again, which is the only way it re-reads a file it already has. */
  const [generation, setGeneration] = useState(0);
  /** The frame has said it is up (it is asked again after each reload). */
  const booted = useRef(false);
  useEffect(() => { booted.current = false; }, [generation]);
  useBootWatch(() => booted.current, generation, "PDF editor", setTrouble);
  /* Whether the person has taken the PDF for themselves: the agent leaves the
     file alone until they hand it back. Autora's own surface, not the editor's
     -- the editor does not know this window exists. */
  const mine = useCollab().held.includes("pdf");
  /** On a phone the pinned view is a third of the screen: editing wants all of it. */
  const [full, setFull] = useFullscreen();

  const post = useCallback((msg: Record<string, unknown>) => {
    frame.current?.contentWindow?.postMessage(msg, "*");
  }, []);
  useFrameTheme(frame);

  /* The agent's hand (Visible work on): its pdf_edit is done in the editor, live, with the editor's own tools
     (spectra-editor/src/autora/hand.ts), and saved there. The window only carries it: the first window of the chat to
     claim it hands it to its frame -- once the editor is up, which it waits for -- and tells the server what was done.
     Nothing is played over a file the server changed: that would be a recording of work already done. */
  const handing = useRef(new Map<string, (answer: { results?: unknown; saved?: unknown; error?: unknown }) => void>());
  const byHand = useCallback(async (hand: DeskHand) => {
    const q = `/api/pdfdesk/${encodeURIComponent(sessionId)}/hand`;
    const claim = await fetch(`${q}/claim?id=${encodeURIComponent(hand.id)}`, { method: "POST" })
      .then((r) => (r.ok ? (r.json() as Promise<{ won?: boolean }>) : { won: false }))
      .catch(() => ({ won: false }));
    if (!claim.won) return;
    const reply = (body: Record<string, unknown>) => fetch(`${q}/reply?id=${encodeURIComponent(hand.id)}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }).catch(() => undefined);
    for (let waited = 0; !booted.current && waited < EDITOR_START_MS; waited += 250) await new Promise((r) => setTimeout(r, 250));
    if (!booted.current) { await reply({ results: [], saved: false, error: "the editor did not start" }); return; }
    const answer = await new Promise<{ results?: unknown; saved?: unknown; error?: unknown }>((resolve) => {
      handing.current.set(hand.id, resolve);
      post({ type: "autora:spectra:hand", id: hand.id, job: hand.job, who: { name: getCursorWho().name, color: cursorColor() } });
    });
    handing.current.delete(hand.id);
    clearCursor();
    await reply({ results: answer.results ?? [], saved: answer.saved === true, ...(typeof answer.error === "string" ? { error: answer.error } : {}) });
  }, [post, sessionId]);
  useEffect(() => onDeskHand((hand) => { void byHand(hand); }), [byHand]);

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
      } else if (msg.type === "autora:spectra:asset" && typeof msg.id === "number" && typeof msg.path === "string") {
        // pdf.js's data files for the frame, fetched here, where the request carries what a login proxy wants.
        const id = msg.id;
        const path: string = msg.path;
        const answer = (status: number, mime: string | null, body: ArrayBuffer | null) => {
          const target = frame.current?.contentWindow;
          if (!target) return;
          target.postMessage({ type: "autora:spectra:asset-result", id, status, mime, body }, "*", body ? [body] : []);
        };
        if (!/^\/spectra-editor\/pdfjs\/[\w./-]+$/.test(path) || path.includes("..")) { answer(403, null, null); return; }
        void fetch(path)
          .then(async (res) => answer(res.status, res.headers.get("content-type"), res.ok ? await res.arrayBuffer() : null))
          .catch(() => answer(502, null, null));
      } else if (msg.type === "autora:spectra:handed" && typeof msg.id === "string") {
        handing.current.get(msg.id)?.(msg);
      } else if (msg.type === "autora:spectra:cursor" && typeof msg.x === "number" && typeof msg.y === "number") {
        // The agent's cursor in the editor, for the few words beside it (AgentThought).
        const r = frame.current.getBoundingClientRect();
        reportCursor(r.left + msg.x, r.top + msg.y);
      } else if (msg.type === "autora:spectra:listen" && typeof msg.event === "string") {
        wanted.current.add(msg.event);
      } else if (msg.type === "autora:spectra:error" && typeof msg.message === "string") {
        // The editor threw on its way up or while running: shown, rather than left as a grey frame.
        setTrouble(`The PDF editor hit an error: ${msg.message.slice(0, 200)}`);
      } else if (msg.type === "autora:spectra:ready") {
        booted.current = true;
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

  return (
    <div className={`pdf-window${phone ? " is-phone" : ""}${phone && full ? " is-full" : ""}`}>
      <div className="pdf-bar">
        <span className="pdf-bar-ico" aria-hidden="true"><IconFile size={14} /></span>
        <span className="pdf-bar-app">Autora PDF</span>
        <span className="pdf-bar-name" title={desk.name ?? undefined}>{desk.name ?? "PDF"}</span>
        <span className="pdf-bar-note">Saved as you go</span>
        <div className="spacer" />
        <TakeControl sessionId={sessionId} surface="pdf" mine={mine} phone={phone} thing="PDF" />
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
      </div>
      {trouble && <div className="pdf-problem" role="status">{trouble}</div>}
      <iframe
        ref={frame}
        key={generation}
        className="pdf-frame"
        src={`/spectra-editor/index.html?session=${encodeURIComponent(sessionId)}${phone ? "&phone=1" : ""}`}
        title={`${desk.name ?? "PDF"}, in Autora PDF`}
        sandbox="allow-scripts allow-downloads allow-modals allow-popups"
      />
    </div>
  );
}
