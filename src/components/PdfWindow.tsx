import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAgentCursor } from "../lib/agentCursor";
import { holdSurface, useCollab } from "../lib/collab";
import { useDeskState } from "../lib/pdfdesk";
import { IconDownload, IconFile, IconMaximize, IconMinimize, IconX } from "./Icons";

/** An ArrayBuffer as base64, in slices: a whole file at once overflows the call stack. */
function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

const PDFJS_DIRS = new Set(["cmaps", "standard_fonts"]);

/**
 * A character map or standard font pdf.js asked for, fetched here and posted
 * into the editor. The editor's frame has no origin, so its own requests go
 * without cookies, and a login proxy in front of Autora (Umbrel's) turns them
 * away: only the editor's page itself, a navigation, reaches it with them.
 */
async function pdfjsData(msg: { id?: unknown; dir?: unknown; filename?: unknown }, post: (m: Record<string, unknown>, t?: Transferable[]) => void) {
  const { id, dir, filename } = msg;
  if (typeof dir !== "string" || !PDFJS_DIRS.has(dir) || typeof filename !== "string" || !/^[\w.-]+$/.test(filename) || filename.startsWith(".")) {
    post({ type: "autora:pdfjs-data", id, error: "not one of pdf.js's files" });
    return;
  }
  try {
    const res = await fetch(`/pdf-editor/pdfjs/${dir}/${filename}`);
    if (!res.ok) throw new Error(`the server answered ${res.status}`);
    const bytes = await res.arrayBuffer();
    post({ type: "autora:pdfjs-data", id, bytes }, [bytes]);
  } catch (err: any) {
    post({ type: "autora:pdfjs-data", id, error: String(err?.message ?? err) });
  }
}

/**
 * The PDF window: the file the agent is working on, in SecurePDF's editor.
 *
 * What the agent places arrives as the editor's own objects, which the person
 * can move, resize, edit or remove, and add to; the server keeps the file up
 * to date with all of it and tells the agent what the person did
 * (server/pdfdesk.ts).
 *
 * The editor is its own build (pdf-editor/), in a frame sandboxed without an
 * origin of its own -- it renders PDFs from anywhere -- so it cannot reach
 * this app or its API. This component is its only way out: it hands the
 * editor the pages and the objects, and passes on what the person changed.
 */
export function PdfWindow({ sessionId, phone }: { sessionId: string; phone: boolean }) {
  const desk = useDeskState();
  const frame = useRef<HTMLIFrameElement>(null);
  const ready = useRef(false);
  /** The pages the editor has: a change of baseRev means fetch them again. */
  const shown = useRef<{ baseRev: number; name: string }>({ baseRev: -1, name: "" });
  /** Pages the person changed here, not yet echoed back by the server. */
  const ownPages = useRef(0);
  const pending = useRef<string[]>([]);
  const deskRef = useRef(desk);
  deskRef.current = desk;
  const [trouble, setTrouble] = useState<string | null>(null);
  /** On a phone the pinned view is a third of the screen: editing wants all of it. */
  const [full, setFull] = useState(false);

  const post = useCallback((msg: Record<string, unknown>, transfer?: Transferable[]) => {
    frame.current?.contentWindow?.postMessage(msg, "*", transfer ?? []);
  }, []);

  /* The agent's cursor: where it just worked, replayed over the page. A choice
     the person keeps, and never for someone who asked their system for less
     motion. Only ever a replay -- the file is already changed. */
  const [cursorOn, setCursorOn] = useAgentCursor();
  const collab = useCollab();
  const mine = collab.held.includes("pdf");
  const cursorRef = useRef(cursorOn);
  cursorRef.current = cursorOn;
  const played = useRef(0);
  const playCues = useCallback(() => {
    const d = deskRef.current;
    if (!d.cueSeq || d.cueSeq === played.current) return;
    played.current = d.cueSeq;
    if (!cursorRef.current || !d.cues?.length) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    post({ type: "autora:cues", seq: d.cueSeq, cues: d.cues });
  }, [post]);
  const toggleCursor = useCallback(() => setCursorOn(!cursorRef.current), [setCursorOn]);

  const load = useCallback(async () => {
    const now = deskRef.current;
    const baseRev = now.baseRev ?? 0;
    try {
      const res = await fetch(`/api/pdfdesk/${encodeURIComponent(sessionId)}/base`);
      if (!res.ok) throw new Error(`the server answered ${res.status}`);
      const bytes = await res.arrayBuffer();
      const latest = deskRef.current;
      // The same file with its pages changed keeps the page you were on.
      const keepPage = shown.current.name === latest.name;
      shown.current = { baseRev, name: latest.name ?? "" };
      // The cues go first: what the agent placed is held back by them, so it must
      // be told before the objects arrive.
      playCues();
      post({ type: "autora:load", bytes, name: latest.name, items: latest.items ?? [], baseRev, keepPage }, [bytes]);
      post({ type: "autora:pending", ids: pending.current });
      setTrouble(null);
    } catch (err: any) {
      setTrouble(`The PDF could not be loaded: ${err?.message ?? err}`);
    }
  }, [post, sessionId, playCues]);

  const send = useCallback(async (what: "changes" | "pages", body: unknown) => {
    try {
      const res = await fetch(`/api/pdfdesk/${encodeURIComponent(sessionId)}/${what}`, {
        method: "POST",
        // Not application/json: the app-wide parser stops at 5 MB, and a
        // placed photograph can be more. The route reads the body itself.
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `the server answered ${res.status}`);
      }
      setTrouble(null);
    } catch (err: any) {
      setTrouble(`That change was not saved: ${err?.message ?? err}`);
    }
  }, [sessionId]);

  // What the editor says: it is ready, the person changed objects, or the pages.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const msg = e.data;
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "autora:ready") {
        ready.current = true;
        void load();
      } else if (msg.type === "autora:ops") {
        void send("changes", { upsert: Array.isArray(msg.upsert) ? msg.upsert : [], remove: Array.isArray(msg.remove) ? msg.remove : [] });
      } else if (msg.type === "autora:base" && msg.bytes instanceof ArrayBuffer) {
        ownPages.current++;
        void send("pages", { bytes: toBase64(msg.bytes), items: Array.isArray(msg.items) ? msg.items : [] });
      } else if (msg.type === "autora:pdfjs-data") {
        void pdfjsData(msg, post);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [load, post, send]);

  // New pages from the server: load them, unless they are the ones just sent from here.
  useEffect(() => {
    if (!ready.current || desk.baseRev === undefined || desk.baseRev === shown.current.baseRev) return;
    if (ownPages.current > 0) {
      ownPages.current--;
      shown.current = { ...shown.current, baseRev: desk.baseRev };
      return;
    }
    void load();
  }, [desk.baseRev, load]);

  // Cues that arrive without new pages (the file was the same): play them now.
  useEffect(() => {
    if (ready.current && desk.baseRev === shown.current.baseRev) playCues();
  }, [desk.cueSeq, desk.baseRev, playCues]);

  // New objects on the same pages: the agent placed something, or the server echoed the person.
  useEffect(() => {
    if (!ready.current || desk.baseRev !== shown.current.baseRev) return;
    post({ type: "autora:items", items: desk.items ?? [] });
  }, [desk.rev, desk.baseRev, desk.items, post]);

  // Reviewing the agent's changes: one at a time, with next and previous.
  const marks = useMemo(() => desk.marks ?? [], [desk.marks]);
  const [cursor, setCursor] = useState(0);
  const at = Math.min(cursor, Math.max(0, marks.length - 1));
  const mark = marks[at];
  const [versionsOpen, setVersionsOpen] = useState(false);
  const versions = desk.versions ?? [];

  const focusMark = useCallback((m: { itemId?: string; page: number } | undefined) => {
    if (m) post({ type: "autora:focus", id: m.itemId ?? null, page: m.page });
  }, [post]);
  const go = useCallback((to: number) => {
    if (marks.length === 0) return;
    const next = (to + marks.length) % marks.length;
    setCursor(next);
    focusMark(marks[next]);
  }, [marks, focusMark]);

  // Which objects the editor outlines as waiting for a decision.
  const pendingIds = marks.filter((m) => m.itemId && m.kind !== "remove").map((m) => m.itemId as string);
  const pendingKey = pendingIds.join(",");
  pending.current = pendingKey ? pendingKey.split(",") : [];
  useEffect(() => {
    if (ready.current) post({ type: "autora:pending", ids: pending.current });
  }, [pendingKey, desk.baseRev, post]);

  const review = useCallback(async (action: "accept" | "deny", body: { id?: string; all?: boolean }) => {
    try {
      const res = await fetch(`/api/pdfdesk/${encodeURIComponent(sessionId)}/review`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...body }),
      });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `the server answered ${res.status}`);
      setTrouble(null);
    } catch (err: any) {
      setTrouble(`That was not saved: ${err?.message ?? err}`);
    }
  }, [sessionId]);

  const restore = useCallback(async (n: number) => {
    setVersionsOpen(false);
    try {
      const res = await fetch(`/api/pdfdesk/${encodeURIComponent(sessionId)}/restore`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ n }),
      });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `the server answered ${res.status}`);
      setTrouble(null);
    } catch (err: any) {
      setTrouble(`That version could not be restored: ${err?.message ?? err}`);
    }
  }, [sessionId]);

  const close = useCallback(() => {
    void fetch(`/api/pdfdesk/${encodeURIComponent(sessionId)}/close`, { method: "POST" });
  }, [sessionId]);

  const problem = trouble ?? desk.problem ?? null;

  return (
    <div className={`pdf-window${phone ? " is-phone" : ""}${phone && full ? " is-full" : ""}`}>
      <div className="pdf-bar">
        <span className="pdf-bar-ico" aria-hidden="true"><IconFile size={14} /></span>
        <span className="pdf-bar-name" title={desk.name}>{desk.name ?? "PDF"}</span>
        <span className="pdf-bar-note">{problem ? "" : "Saved as you go"}</span>
        <div className="spacer" />
        {versions.length > 0 && (
          <button
            className="pdf-pill"
            onClick={() => setVersionsOpen((v) => !v)}
            aria-expanded={versionsOpen}
            title="Earlier versions of this file"
          >
            Versions · {versions.length}
          </button>
        )}
        <button
          className={`pdf-pill${mine ? " is-accept" : ""}`}
          onClick={() => void holdSurface(sessionId, "pdf", !mine)}
          aria-pressed={mine}
          title={mine ? "Let the agent work on the PDF again" : "Work on the PDF yourself; the agent carries on with other work"}
        >
          {mine ? "Hand back" : "Take control"}
        </button>
        <button
          className="pdf-pill"
          onClick={toggleCursor}
          aria-pressed={cursorOn}
          title={cursorOn ? "Stop showing where the agent edits" : "Show where the agent edits, as it edits"}
        >
          Agent cursor {cursorOn ? "on" : "off"}
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
          <button className="btn icon ghost" onClick={close} title="Put the PDF window away" aria-label="Put the PDF window away">
            <IconX size={14} />
          </button>
        )}
      </div>
      {versionsOpen && versions.length > 0 && (
        <ul className="pdf-versions" aria-label="Versions of this file">
          {[...versions].reverse().map((v) => (
            <li key={v.n}>
              <span className="pdf-version-main">
                <b>v{v.n}</b> {v.label}
                <small>{v.by === "agent" ? "Agent" : "You"} · {new Date(v.at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</small>
              </span>
              <a className="pdf-pill" href={`/api/pdfdesk/${encodeURIComponent(sessionId)}/version/${v.n}`} download>Download</a>
              {v.n !== versions[versions.length - 1].n && <button className="pdf-pill" onClick={() => void restore(v.n)}>Restore</button>}
            </li>
          ))}
        </ul>
      )}
      {mark && (
        <div className="pdf-review" role="group" aria-label="The agent's changes">
          <button className="pdf-pill" onClick={() => go(at - 1)} aria-label="Previous change" disabled={marks.length < 2}>‹ Prev</button>
          <span className="pdf-review-count">{at + 1} / {marks.length}</span>
          <button className="pdf-pill" onClick={() => go(at + 1)} aria-label="Next change" disabled={marks.length < 2}>Next ›</button>
          <button className="pdf-review-label" onClick={() => focusMark(mark)} title="Show it in the document">{mark.label}</button>
          <button className="pdf-pill is-deny" onClick={() => void review("deny", { id: mark.id })}>Deny</button>
          <button className="pdf-pill is-accept" onClick={() => void review("accept", { id: mark.id })}>Accept</button>
          {marks.length > 1 && (
            <>
              <button className="pdf-pill is-deny" onClick={() => void review("deny", { all: true })}>Deny all</button>
              <button className="pdf-pill is-accept" onClick={() => void review("accept", { all: true })}>Accept all</button>
            </>
          )}
        </div>
      )}
      {problem && <div className="pdf-problem" role="status">{problem}</div>}
      <iframe
        ref={frame}
        className="pdf-frame"
        src="/pdf-editor/index.html"
        title={`${desk.name ?? "PDF"}, in the PDF editor`}
        sandbox="allow-scripts allow-downloads allow-modals allow-popups"
      />
    </div>
  );
}
