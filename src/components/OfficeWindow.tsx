import { useCallback, useEffect, useRef, useState } from "react";
import { holdSurface, useCollab } from "../lib/collab";
import { onOfficePush, useWordState, type OfficeKind } from "../lib/officedesk";
import { IconDownload, IconFile, IconMaximize, IconMinimize, IconX } from "./Icons";

/**
 * The Office window: the Word, PowerPoint or Excel document the agent is working
 * on, in GenOffice's own editor for it, beside the conversation
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
const THING: Record<OfficeKind, string> = { docx: "Word document", pptx: "deck", xlsx: "workbook" };

export function OfficeWindow({ sessionId, phone }: { sessionId: string; phone: boolean }) {
  const word = useWordState();
  const kind: OfficeKind = word.kind ?? "docx";
  /** PowerPoint and Excel keep their document in an engine on the server, which the frame reaches through here. */
  const engine = kind !== "docx";
  const frame = useRef<HTMLIFrameElement>(null);
  /** The version of the document the editor was last given. */
  const shown = useRef(0);
  const wordRef = useRef(word);
  wordRef.current = word;
  const [trouble, setTrouble] = useState<string | null>(null);
  const [versionsOpen, setVersionsOpen] = useState(false);
  /** On a phone the pinned view is a third of the screen: editing wants all of it. */
  const [full, setFull] = useState(false);
  const collab = useCollab();
  const mine = collab.held.includes("office");
  const base = `/api/officedesk/${encodeURIComponent(sessionId)}`;

  const post = useCallback((msg: Record<string, unknown>, transfer?: Transferable[]) => {
    frame.current?.contentWindow?.postMessage(msg, "*", transfer ?? []);
  }, []);

  /** The document as the server has it now. */
  const fetchDocument = useCallback(async () => {
    const res = await fetch(`${base}/data`, { cache: "no-store" });
    if (!res.ok) throw new Error(`the server answered ${res.status}`);
    return await res.arrayBuffer();
  }, [base]);

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
                const res = await fetch(`${base}/page?rev=${wordRef.current.loadRev ?? 0}`, { method: "POST" });
                const body = (await res.json().catch(() => ({}))) as { path?: string; name?: string; error?: string };
                if (!res.ok) throw new Error(body.error ?? `the server answered ${res.status}`);
                reply(true, { path: body.path, name: body.name });
                break;
              }
              // The document the person is to see; later versions are pushed.
              shown.current = wordRef.current.loadRev ?? 0;
              const bytes = await fetchDocument();
              reply(true, { bytes, name: wordRef.current.name ?? "document.docx" }, undefined, [bytes]);
              break;
            }
            case "ipc":
            case "ipc-send": {
              // The editor's ipc, for the engine behind a deck or a workbook.
              const res = await fetch(`${base}/${m.op}?rev=${wordRef.current.loadRev ?? 0}`, {
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
              const res = await fetch(`${base}/save`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: payload.bytes as ArrayBuffer });
              if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `the server answered ${res.status}`);
              setTrouble(null);
              reply(true, { ok: true });
              break;
            }
            case "presence": {
              void fetch(`${base}/presence`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => undefined);
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
              const res = await fetch(`${base}/pdf`, { method: "POST" });
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
  }, [base, fetchDocument, post]);

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

  const restore = useCallback(async (n: number) => {
    setVersionsOpen(false);
    try {
      const res = await fetch(`${base}/restore`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ n }) });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `the server answered ${res.status}`);
      setTrouble(null);
    } catch (err: any) {
      setTrouble(`That version could not be restored: ${err?.message ?? err}`);
    }
  }, [base]);

  const close = useCallback(() => {
    void fetch(`${base}/close`, { method: "POST" });
  }, [base]);

  const versions = word.versions ?? [];
  const problem = trouble ?? word.problem ?? null;

  return (
    <div className={`pdf-window office-window${phone ? " is-phone" : ""}${phone && full ? " is-full" : ""}`}>
      <div className="pdf-bar">
        <span className="pdf-bar-ico" aria-hidden="true"><IconFile size={14} /></span>
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
        {phone && (
          <button
            className="btn icon ghost"
            onClick={() => setFull((v) => !v)}
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
              <a className="pdf-pill" href={`${base}/version/${v.n}`} download>Download</a>
              {v.n !== versions[versions.length - 1].n && <button className="pdf-pill" onClick={() => void restore(v.n)}>Restore</button>}
            </li>
          ))}
        </ul>
      )}
      {problem && <div className="pdf-problem" role="status">{problem}</div>}
      <iframe
        key={engine ? `${kind}-${word.loadRev ?? 0}` : kind}
        ref={frame}
        className="pdf-frame"
        src={`/office-app/${APP[kind]}/index.html`}
        title={`${word.name ?? THING[kind]}, in its editor`}
        sandbox="allow-scripts allow-downloads allow-modals allow-popups"
      />
    </div>
  );
}
