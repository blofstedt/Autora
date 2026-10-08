import { useCallback, useEffect, useRef, useState } from "react";
import { useFullscreen } from "../lib/fullscreen";
import { useAgentCursor } from "../lib/agentCursor";
import { holdSurface, useCollab } from "../lib/collab";
import { onOfficePush, useOfficeWindow, type OfficeCue, type OfficeKind } from "../lib/officedesk";
import { OfficeCursor, type Acted, type Located } from "./OfficeCursor";
import { OfficePages } from "./OfficePages";
import { IconDownload, IconFile, IconMaximize, IconMinimize, IconX } from "./Icons";

/**
 * The Pages, Slides or Sheets window: the document, presentation or spreadsheet the agent is
 * working on, in GenOffice's own editor for it, beside the conversation
 * (server/officedesk.ts).
 *
 * The editor is its own build (scripts/build-office.mjs), in a frame sandboxed
 * without an origin of its own -- it opens documents from anywhere -- so it
 * cannot reach this app or its API, and cannot even fetch its own files (a
 * login proxy in front of Autora turns those requests away). This component is
 * its only way out: it answers what the editor asks the host for (office/shim),
 * hands it the document, and passes on what the person changed.
 */
/** The editor each kind of document opens in (dist/office/web/<app>), and what a person calls the document. */
const APP: Record<OfficeKind, string> = { docx: "docs", pptx: "slides", xlsx: "sheets" };
const THING: Record<OfficeKind, string> = { docx: "document", pptx: "presentation", xlsx: "spreadsheet" };
/** The app each kind opens in, by its name. */
const NAME: Record<OfficeKind, string> = { docx: "Autora Pages", pptx: "Autora Slides", xlsx: "Autora Sheets" };

export function OfficeWindow({ sessionId, kind, phone }: { sessionId: string; kind: OfficeKind; phone: boolean }) {
  // The window for this app: Autora Pages, Autora Sheets and Autora Slides each have their own, all open at once.
  const word = useOfficeWindow(kind) ?? { open: false, kind };
  /** Slides and Sheets keep their document in an engine on the server, which the frame reaches through here. */
  const engine = kind !== "docx";
  const frame = useRef<HTMLIFrameElement>(null);
  /** The version of the document the editor was last given. */
  const shown = useRef(0);
  const wordRef = useRef(word);
  wordRef.current = word;
  const [trouble, setTrouble] = useState<string | null>(null);
  const [versionsOpen, setVersionsOpen] = useState(false);
  /** On a phone the pinned view is a third of the screen: editing wants all of it. */
  const [full, setFull] = useFullscreen();
  /* A phone starts with the pages as pictures (fast, kept, readable); the full editor is a tap away. */
  const [editing, setEditing] = useState(false);
  const pages = phone && !editing;
  const collab = useCollab();
  const mine = collab.held.includes("office");
  const [cursorOn, setCursorOn] = useAgentCursor();
  /** The agent's last change, being played over the editor (see OfficeCursor). */
  const [play, setPlay] = useState<{ seq: number; items: OfficeCue[]; stage: { rev: number; count: number } | null } | null>(null);
  const played = useRef<number | undefined>(undefined);
  /** The `loadRev` the editor has opened its document at: steps of a change are only shown to an editor that has one. */
  const [openedRev, setOpenedRev] = useState(-1);
  /** Questions to the editor about where things are, waiting for its answer. */
  const asking = useRef(new Map<number, { done: (found: Located | null) => void; once: boolean }>());
  /** What the agent did in the editor, waiting for the editor to say what it made of it. */
  const acting = useRef(new Map<number, (said: Acted | null) => void>());
  /** Every call says which window it is about, since each app's document is open beside the chat at the same time. */
  const api = useCallback((path: string) => {
    const at = `/api/officedesk/${encodeURIComponent(sessionId)}${path}`;
    return `${at}${at.includes("?") ? "&" : "?"}kind=${kind}`;
  }, [sessionId, kind]);

  const post = useCallback((msg: Record<string, unknown>, transfer?: Transferable[]) => {
    frame.current?.contentWindow?.postMessage(msg, "*", transfer ?? []);
  }, []);

  /** The document as the server has it now. */
  const fetchDocument = useCallback(async () => {
    const res = await fetch(api("/data"), { cache: "no-store" });
    if (!res.ok) throw new Error(`the server answered ${res.status}`);
    return await res.arrayBuffer();
  }, [api]);

  // What the editor asks of its host.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const m = e.data;
      if (!m || typeof m !== "object" || m.type !== "autora:office" || typeof m.id !== "number") return;
      const reply = (ok: boolean, value?: unknown, error?: string, transfer?: Transferable[]) =>
        post({ type: "autora:office-result", id: m.id, ok, value, error }, transfer);
      const payload = (m.payload && typeof m.payload === "object" ? m.payload : {}) as Record<string, any>;
      void (async () => {
        try {
          switch (m.op) {
            case "asset": {
              // Its fonts: only from the editor's own folder.
              const name = String(payload.name ?? "");
              if (!/^(docs|slides|sheets)\/assets\/[\w.-]+$/.test(name)) throw new Error("not one of the editor's files");
              const res = await fetch(`/office-app/${name}`);
              if (!res.ok) throw new Error(`the server answered ${res.status}`);
              const bytes = await res.arrayBuffer();
              reply(true, { bytes }, undefined, [bytes]);
              break;
            }
            case "open": {
              if (wordRef.current.kind && wordRef.current.kind !== "docx") {
                // A deck or a workbook is opened by its engine, from the file it has: this page is made known to it.
                const res = await fetch(api(`/page?rev=${wordRef.current.loadRev ?? 0}`), { method: "POST" });
                const body = (await res.json().catch(() => ({}))) as { path?: string; name?: string; error?: string };
                if (!res.ok) throw new Error(body.error ?? `the server answered ${res.status}`);
                reply(true, { path: body.path, name: body.name });
                setOpenedRev(wordRef.current.loadRev ?? 0);
                break;
              }
              // The document the person is to see; later versions are pushed.
              shown.current = wordRef.current.loadRev ?? 0;
              const bytes = await fetchDocument();
              reply(true, { bytes, name: wordRef.current.name ?? "document.docx" }, undefined, [bytes]);
              setOpenedRev(wordRef.current.loadRev ?? 0);
              break;
            }
            case "ipc":
            case "ipc-send": {
              // The editor is talking to its engine: it is up (a workbook's page never asks to open, it just starts).
              setOpenedRev((was) => (was === (wordRef.current.loadRev ?? 0) ? was : wordRef.current.loadRev ?? 0));
              // The editor's ipc, for the engine behind a deck or a workbook.
              const res = await fetch(api(`/${m.op}?rev=${wordRef.current.loadRev ?? 0}`), {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ channel: payload.channel, args: payload.args }),
              });
              const body = (await res.json().catch(() => ({}))) as { value?: unknown; error?: string };
              if (!res.ok) throw new Error(body.error ?? `the server answered ${res.status}`);
              reply(true, body.value ?? null);
              break;
            }
            case "save": {
              // Saved as they type: the server keeps the artifact current and tells the agent what changed.
              const res = await fetch(api("/save"), { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: payload.bytes as ArrayBuffer });
              if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `the server answered ${res.status}`);
              setTrouble(null);
              reply(true, { ok: true });
              break;
            }
            case "acted": {
              // What the editor did about a click or a piece of typing the agent asked for (office/shim/cursor.js).
              const heard = acting.current.get(Number(payload.id));
              if (heard) {
                acting.current.delete(Number(payload.id));
                heard(payload as unknown as Acted);
              }
              reply(true, {});
              break;
            }
            case "located": {
              // The editor's answer to where the cursor should go (office/shim/cursor.js).
              const found = asking.current.get(Number(payload.id));
              // Unless the asker takes the first answer, found or not, an answer with nothing in it is waited past:
              // the document may still be opening.
              if (found && Array.isArray(payload.rects) && (found.once || payload.rects.some(Boolean))) {
                asking.current.delete(Number(payload.id));
                found.done({ rects: payload.rects, view: payload.view ?? { w: 800, h: 600 } });
              }
              reply(true, {});
              break;
            }
            case "presence": {
              void fetch(api("/presence"), { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => undefined);
              reply(true, {});
              break;
            }
            case "ask": {
              // The editor's AI slot is Autora's chat: put the cursor there.
              document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Task"]')?.focus();
              reply(true, {});
              break;
            }
            case "export-pdf": {
              const res = await fetch(api("/pdf"), { method: "POST" });
              if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `the server answered ${res.status}`);
              reply(true, {});
              break;
            }
            default:
              reply(true, {});
          }
        } catch (err: any) {
          if (m.op === "save") setTrouble(`That change was not saved: ${err?.message ?? err}`);
          reply(false, undefined, String(err?.message ?? err));
        }
      })();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [api, fetchDocument, post]);

  // What the engine sends its editor page (webContents.send), passed on to the frame.
  useEffect(() => onOfficePush((msg) => {
    if (msg.rev !== wordRef.current.loadRev) return;
    post({ type: "autora:office-push", op: "ipc", payload: { channel: msg.channel, args: msg.args } });
  }), [post]);

  // The agent changed the document, or an earlier version came back: the editor opens it. (A deck or a
  // workbook is loaded again by the frame itself: its key follows loadRev.)
  useEffect(() => {
    if (engine || word.loadRev === undefined || shown.current === 0 || word.loadRev === shown.current) return;
    shown.current = word.loadRev;
    void fetchDocument()
      .then((bytes) => post({ type: "autora:office-push", op: "load", payload: { bytes, name: wordRef.current.name ?? "document.docx" } }, [bytes]))
      .catch((err: any) => setTrouble(`The document could not be loaded: ${err?.message ?? err}`));
  }, [engine, word.loadRev, fetchDocument, post]);

  /**
   * The next step of the agent's change: the server makes the document be that file, and the editor is given it. The
   * typing the cursor does is these steps, one after another, so the words are in the document as they are typed.
   */
  const stage = useCallback(async (rev: number, step: number) => {
    const res = await fetch(api(`/stage?rev=${rev}&step=${step}`), { method: "POST" }).catch(() => null);
    if (!res?.ok) return false;
    // A deck or a workbook is reloaded by its engine; a document is fetched and handed to the editor.
    if (!engine) {
      try {
        const bytes = await fetchDocument();
        post({ type: "autora:office-push", op: "load", payload: { bytes, name: wordRef.current.name ?? "document.docx" } }, [bytes]);
      } catch {
        return false;
      }
    }
    return true;
  }, [api, engine, fetchDocument, post]);

  // The agent changed the document: play where it worked, once, if the window is on screen now.
  useEffect(() => {
    if (!word.cues || word.cues.length === 0 || word.cueRev === undefined) return;
    const staged = word.stage && word.stage.rev === word.cueRev ? word.stage : null;
    // A change shown in steps may be waiting for a new document's editor to start: it can be played for longer.
    if (played.current === word.cueRev || (word.cueAge ?? 0) > (staged ? 30000 : 6000)) return;
    if (!cursorOn || pages) {
      // Nobody is watching it type: the document is brought to what the agent made, without the show.
      if (staged) { played.current = word.cueRev; void stage(staged.rev, staged.count - 1); }
      return;
    }
    if (staged && openedRev !== (word.loadRev ?? 0)) return;
    played.current = word.cueRev;
    setPlay({ seq: word.cueRev, items: word.cues, stage: staged });
  }, [cursorOn, pages, word.cues, word.cueRev, word.cueAge, word.stage, word.loadRev, openedRev, stage]);

  const locate = useCallback((items: OfficeCue[], once = false) => new Promise<Located | null>((resolve) => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    const targets = items.map((c) => ({ text: c.text, cell: c.cell, sheet: c.sheet, box: c.box, slide: c.slide }));
    let tries = 0;
    const finish = (found: Located | null) => { clearInterval(timer); asking.current.delete(id); resolve(found); };
    asking.current.set(id, { done: finish, once });
    // The frame may still be starting (a window just opened, a document loading): ask again until it answers.
    const send = () => {
      post({ type: "autora:office-locate", id, targets, wait: once ? 500 : 1400 });
      if (++tries > 6) finish(null);
    };
    const timer = setInterval(send, 1500);
    send();
  }), [post]);

  /**
   * What the agent really does in the editor: click where it is working, type into the editor's own field, and leave
   * the edit. The editor answers with what it did (the cell its name box shows, whether it had a field to type in),
   * and an answer of ok: false sends the window back to drawing the words itself.
   */
  const act = useCallback((what: { act: "click" | "type" | "end"; x?: number; y?: number; text?: string }) => new Promise<Acted | null>((resolve) => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    const finish = (said: Acted | null) => { clearInterval(timer); acting.current.delete(id); resolve(said); };
    let tries = 0;
    const send = () => {
      post({ type: "autora:office-act", id, ...what });
      if (++tries > 4) finish(null);
    };
    acting.current.set(id, finish);
    const timer = setInterval(send, 260);
    send();
  }), [post]);

  const restore = useCallback(async (n: number) => {
    setVersionsOpen(false);
    try {
      const res = await fetch(api("/restore"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ n }) });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `the server answered ${res.status}`);
      setTrouble(null);
    } catch (err: any) {
      setTrouble(`That version could not be restored: ${err?.message ?? err}`);
    }
  }, [api]);

  /**
   * Whether the pane has a real box on screen yet. The window beside the chat keeps every open window mounted and
   * shows the chosen one, so a window that opens behind the one already showing is made while it has no box at all.
   * An editor started then sizes itself to nothing: the frame comes up with its ribbon over an empty grey page and
   * never draws the document, however long you wait -- seen in the running app, where the same frame that had been
   * grey drew its document the moment it was loaded at full size. So the heavy part is mounted once there is room.
   * Nothing is lost by waiting: the document is the server's, and the editor reads it as it starts.
   */
  const pane = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState(false);
  useEffect(() => {
    const el = pane.current;
    if (!el) return;
    const look = () => setRoom(el.clientWidth > 40 && el.clientHeight > 40);
    look();
    const watch = new ResizeObserver(look);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  const close = useCallback(() => {
    void fetch(api("/close"), { method: "POST" });
  }, [api]);

  const versions = word.versions ?? [];
  const problem = trouble ?? word.problem ?? null;

  return (
    <div ref={pane} className={`pdf-window office-window${phone ? " is-phone" : ""}${phone && full ? " is-full" : ""}${pages ? " is-pages" : ""}`}>
      <div className="pdf-bar">
        <span className="pdf-bar-ico" aria-hidden="true"><IconFile size={14} /></span>
        <span className="pdf-bar-app">{NAME[kind]}</span>
        <span className="pdf-bar-name" title={word.name}>{word.name ?? THING[kind]}</span>
        <span className="pdf-bar-note">{problem ? "" : "Saved as you go"}</span>
        <div className="spacer" />
        {versions.length > 0 && (
          <button
            className="pdf-pill"
            onClick={() => setVersionsOpen((v) => !v)}
            aria-expanded={versionsOpen}
            title="Earlier versions of this document"
          >
            Versions · {versions.length}
          </button>
        )}
        <button
          className={`pdf-pill${mine ? " is-accept" : ""}`}
          onClick={() => void holdSurface(sessionId, "office", !mine)}
          aria-pressed={mine}
          title={mine ? "Let the agent work on the document again" : "Work on the document yourself; the agent carries on with other work"}
        >
          {mine ? "Hand back" : "Take control"}
        </button>
        {!pages && (
          <button
            className="pdf-pill pdf-cursor-pill"
            onClick={() => setCursorOn(!cursorOn)}
            aria-pressed={cursorOn}
            title={cursorOn ? "Stop showing where the agent edits" : "Show where the agent edits, as it edits"}
          >
            Agent cursor {cursorOn ? "on" : "off"}
          </button>
        )}
        {word.working && (
          <a
            className="btn icon ghost"
            href={`/api/artifacts/${word.working}?download`}
            title="Download the document as it is now"
            aria-label="Download the document as it is now"
          >
            <IconDownload size={14} />
          </a>
        )}
        {phone && editing && (
          <button className="pdf-pill" onClick={() => setEditing(false)} title="Back to the pictures of the pages">Page view</button>
        )}
        {phone && !pages && (
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
          <button className="btn icon ghost" onClick={close} title="Put the window away" aria-label="Put the window away">
            <IconX size={14} />
          </button>
        )}
      </div>
      {versionsOpen && versions.length > 0 && (
        <ul className="pdf-versions" aria-label="Versions of this document">
          {[...versions].reverse().map((v) => (
            <li key={v.n}>
              <span className="pdf-version-main">
                <b>v{v.n}</b> {v.label}
                <small>{v.by === "agent" ? "Agent" : "You"} · {new Date(v.at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</small>
              </span>
              <a className="pdf-pill" href={api(`/version/${v.n}`)} download>Download</a>
              {v.n !== versions[versions.length - 1].n && <button className="pdf-pill" onClick={() => void restore(v.n)}>Restore</button>}
            </li>
          ))}
        </ul>
      )}
      {problem && <div className="pdf-problem" role="status">{problem}</div>}
      {pages ? (
        room ? <OfficePages sessionId={sessionId} kind={kind} name={word.name ?? THING[kind]} rev={word.rev ?? 0} onEdit={() => { setEditing(true); setFull(true); }} /> : null
      ) : (
        <div className="office-stage">
          {room && (
          <iframe
            key={engine ? `${kind}-${word.loadRev ?? 0}` : kind}
            ref={frame}
            className="pdf-frame"
            src={`/office-app/${APP[kind]}/index.html`}
            title={`${word.name ?? THING[kind]}, in ${NAME[kind]}`}
            sandbox="allow-scripts allow-downloads allow-modals allow-popups"
          />
          )}
          {cursorOn && play && (
            <OfficeCursor
              cues={play.items}
              seq={play.seq}
              locate={locate}
              click={(at) => act({ act: "click", x: at.x, y: at.y })}
              type={(text) => act({ act: "type", text })}
              end={() => act({ act: "end" })}
              stage={(step) => (play.stage ? stage(play.stage.rev, step) : Promise.resolve(false))}
              stages={play.stage?.count ?? 0}
              onDone={() => setPlay(null)}
            />
          )}
        </div>
      )}
    </div>
  );
}
