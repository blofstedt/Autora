import { useCallback, useEffect, useRef, useState } from "react";
import { SaveButton, keptAs, settle } from "./SaveButton";
import { LoadButton } from "./LoadButton";
import { useFullscreen } from "../lib/fullscreen";
import { useCollab } from "../lib/collab";
import { TakeControl } from "./TakeControl";
import { onOfficeHand, onOfficePush, useOfficeWindow, type OfficeHand, type OfficeKind } from "../lib/officedesk";
import { clearCursor, reportCursor } from "../lib/cursorPos";
import { getCursorWho, whoColors } from "../lib/cursorWho";
import { OfficePages } from "./OfficePages";
import { useFrameTheme } from "../lib/frameTheme";
import { IconEdit, IconDownload, IconFile, IconMaximize, IconMinimize } from "./Icons";

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
/** How long an edit waits for an editor that is still starting before it simply appears instead. */
const EDITOR_START_MS = 45_000;

/** The cursor's colour as #rrggbb, which the editor draws it in: the chat's agent's own, else the theme's accent. */
function cursorColor(): string {
  const own = whoColors()?.accent;
  if (own && /^#[0-9a-f]{6}$/i.test(own)) return own;
  const rgb = getComputedStyle(document.documentElement).getPropertyValue("--accent-rgb").split(",").map((v) => Number(v.trim()));
  if (rgb.length !== 3 || rgb.some((v) => !Number.isFinite(v))) return "#6e5bff";
  return `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;
}

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
  /** The `loadRev` the editor has opened its document at: the agent's hand works only in an editor that has one. */
  const [openedRev, setOpenedRev] = useState(-1);
  const openedRef = useRef(openedRev);
  openedRef.current = openedRev;
  /** The agent's edits being typed in the editor by hand, by id: answered when the editor says it is done. */
  const handing = useRef(new Map<string, (said: { results?: unknown; error?: unknown }) => void>());
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
            case "handed": {
              // The agent's hand is done in the editor (office/shim/hand.js): what each step did.
              handing.current.get(String(payload.id))?.(payload);
              reply(true, {});
              break;
            }
            case "hand-cursor": {
              // Where the hand's cursor is, for the few words beside it (AgentThought).
              const r = frame.current?.getBoundingClientRect();
              if (r && Number.isFinite(payload.x) && Number.isFinite(payload.y)) reportCursor(r.left + Number(payload.x), r.top + Number(payload.y));
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
    const rev = word.loadRev;
    void fetchDocument()
      .then((bytes) => {
        post({ type: "autora:office-push", op: "load", payload: { bytes, name: wordRef.current.name ?? "document.docx" } }, [bytes]);
        // The editor has this version now: the agent's hand may work in it.
        setOpenedRev(rev);
      })
      .catch((err: any) => setTrouble(`The document could not be loaded: ${err?.message ?? err}`));
  }, [engine, word.loadRev, fetchDocument, post]);

  /* The agent's hand (Visible work on): what its office_edit changes in the words is typed in the editor, live, by the
     hand in the frame (office/shim/hand.js), while the call waits. The window only carries it: the first window of the
     chat to claim it hands it to its editor -- once the editor has the document open, which it waits for -- and tells
     the server what was done. Nothing is played over a document the server changed: that would be a recording. */
  const byHand = useCallback(async (hand: OfficeHand) => {
    const at = (p: string) => `/api/officedesk/${encodeURIComponent(sessionId)}/hand/${p}?id=${encodeURIComponent(hand.id)}`;
    const claim = await fetch(at("claim"), { method: "POST" })
      .then((r) => (r.ok ? (r.json() as Promise<{ won?: boolean }>) : { won: false }))
      .catch(() => ({ won: false }));
    if (!claim.won) return;
    const reply = (body: Record<string, unknown>) => fetch(at("reply"), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }).catch(() => undefined);
    const ready = () => openedRef.current === (wordRef.current.loadRev ?? 0) && !!frame.current?.contentWindow;
    for (let waited = 0; !ready() && waited < EDITOR_START_MS; waited += 250) await new Promise((r) => setTimeout(r, 250));
    if (!ready()) { await reply({ results: [], error: "the editor did not start" }); return; }
    // A document just opened is laid out a moment after it is opened.
    await new Promise((r) => setTimeout(r, 1200));
    const said = await new Promise<{ results?: unknown; error?: unknown }>((resolve) => {
      handing.current.set(hand.id, resolve);
      post({ type: "autora:office-hand", id: hand.id, steps: hand.steps, who: { name: getCursorWho().name, color: cursorColor() } });
    });
    handing.current.delete(hand.id);
    clearCursor();
    await reply({ results: said.results ?? [], ...(typeof said.error === "string" ? { error: said.error } : {}) });
  }, [post, sessionId]);
  useEffect(() => onOfficeHand((hand) => {
    if (hand.kind === kind && !pages) void byHand(hand);
  }), [byHand, kind, pages]);

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
  /* The frame carries the page's theme, not Autora Violet, whichever theme is on. */
  useFrameTheme(frame);
  useEffect(() => {
    const el = pane.current;
    if (!el) return;
    const look = () => setRoom(el.clientWidth > 40 && el.clientHeight > 40);
    look();
    const watch = new ResizeObserver(look);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  const versions = word.versions ?? [];
  const problem = trouble ?? word.problem ?? null;

  /** Save: the editor's own Ctrl+S (the picture of the pages on a phone has nothing unsaved), a moment for it to land,
      then the file in Artifacts written now and kept as a version. */
  const keep = useCallback(async () => {
    if (!pages) {
      post({ type: "autora:office-save" });
      await settle(1500);
    }
    return keptAs(await fetch(`/api/officedesk/${encodeURIComponent(sessionId)}/keep?kind=${kind}`, { method: "POST" }));
  }, [kind, pages, post, sessionId]);

  return (
    <div ref={pane} className={`pdf-window office-window${phone ? " is-phone" : ""}${phone && full ? " is-full" : ""}${pages ? " is-pages" : ""}`}>
      <div className="pdf-bar">
        <span className="pdf-bar-ico" aria-hidden="true"><IconFile size={14} /></span>
        <span className="pdf-bar-app">{NAME[kind]}</span>
        <span className="pdf-bar-name" title={word.name}>{word.name ?? THING[kind]}</span>
        <span className="pdf-bar-note">{problem ? "" : "Saved as you go"}</span>
        <div className="spacer" />
        {versions.length > 0 && !phone && (
          <button
            className="pdf-pill"
            onClick={() => setVersionsOpen((v) => !v)}
            aria-expanded={versionsOpen}
            title="Earlier versions of this document"
          >
            Versions · {versions.length}
          </button>
        )}
        <LoadButton app={kind === "docx" ? "pages" : kind === "xlsx" ? "sheets" : "slides"} session={sessionId} phone={phone} />
        <SaveButton onSave={keep} phone={phone} disabled={!word.name} />
        <TakeControl sessionId={sessionId} surface="office" mine={mine} phone={phone} thing="document" />
        {/* Whether the agent's cursor shows is Visible work, the eye beside Follow: not a switch of this window's own. */}
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
        {pages && (
          <button className="btn icon ghost" onClick={() => { setEditing(true); setFull(true); }} title="Edit by hand, full screen" aria-label="Edit"><IconEdit size={15} /></button>
        )}
        {phone && editing && (
          <button className="btn icon ghost" onClick={() => setEditing(false)} title="Back to the pictures of the pages" aria-label="Page view"><IconFile size={15} /></button>
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
            src={`/office-app/${APP[kind]}/index.html${phone ? "?phone=1" : ""}`}
            title={`${word.name ?? THING[kind]}, in ${NAME[kind]}`}
            sandbox="allow-scripts allow-downloads allow-modals allow-popups"
          />
          )}
        </div>
      )}
    </div>
  );
}
