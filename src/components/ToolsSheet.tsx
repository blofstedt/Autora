/**
 * The toolbox: the apps the person can open themselves, without a turn.
 *
 * Tapping the wrench in the composer opens this. Every row is a window that
 * works with nothing in it -- a blank PDF, document, workbook or deck -- so a
 * tap makes a real, empty file and puts it in the window beside the chat. The
 * browser, the app window and a widget are not here: they have nothing to show
 * until the agent puts something in them.
 *
 * The apps switched off on the Tools page are shown greyed rather than hidden,
 * so a missing app reads as switched off instead of missing.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { IconCube, IconFile, IconScroll, IconSlides, IconStar, IconTable, IconVideo, IconWrench, IconX } from "./Icons";

type Kind = "pdf" | "docx" | "xlsx" | "pptx" | "video" | "cad";

type Tool = {
  kind: Kind;
  app: string;
  /** The setting on the Tools page that decides whether this app is on. */
  setting: "pdf" | "video" | "pages" | "sheets" | "slides" | "cad";
  what: string;
  icon: (size: number) => JSX.Element;
};

const TOOLS: Tool[] = [
  { kind: "pdf", app: "Autora PDF", setting: "pdf", what: "A blank page", icon: (s) => <IconFile size={s} /> },
  { kind: "video", app: "Autora Video", setting: "video", what: "A new video project", icon: (s) => <IconVideo size={s} /> },
  { kind: "docx", app: "Autora Pages", setting: "pages", what: "A blank document", icon: (s) => <IconScroll size={s} /> },
  { kind: "xlsx", app: "Autora Sheets", setting: "sheets", what: "A blank spreadsheet", icon: (s) => <IconTable size={s} /> },
  { kind: "pptx", app: "Autora Slides", setting: "slides", what: "A blank slide", icon: (s) => <IconSlides size={s} /> },
  { kind: "cad", app: "Autora 3D", setting: "cad", what: "A block to shape", icon: (s) => <IconCube size={s} /> },
];

export function ToolsSheet({ session, onClose, onTrouble, onOpened }: {
  session: string;
  onClose: () => void;
  onTrouble: (message: string) => void;
  /** What was opened, so the chat can say so and the window is already up. */
  onOpened: (name: string, app: string) => void;
}) {
  /* Which apps are on, from the same settings the Tools page writes. Held as
     null while it loads: unknown is not the same as off, and a row that said
     "switched off" for half a second would be wrong. */
  const [on, setOn] = useState<Record<string, boolean> | null>(null);
  const [busy, setBusy] = useState<Kind | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/settings")
      .then((r) => r.json())
      .then((s) => { if (live) setOn(s?.tools?.config ?? {}); })
      .catch(() => { if (live) setOn({}); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const open = async (tool: Tool) => {
    if (busy) return;
    setBusy(tool.kind);
    setError(null);
    try {
      // The video editor opens on its own project; it makes a blank one itself when there is none.
      if (tool.kind === "video") {
        const res = await fetch(`/api/opencut/open?session=${encodeURIComponent(session)}`, { method: "POST" });
        if (!res.ok) {
          setError(`Autora Video was not opened (${res.status}).`);
          setBusy(null);
          return;
        }
        onOpened("a video project", tool.app);
        onClose();
        return;
      }
      /* Autora 3D has no file to make: the model is the chat's own (server/caddesk.ts), so opening it is its own route. */
      const res = tool.kind === "cad"
        ? await fetch(`/api/cad/${encodeURIComponent(session)}/open`, { method: "POST" })
        : await fetch(`/api/sessions/${session}/new`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ kind: tool.kind }),
          });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(String(body?.error ?? `A new file was not opened (${res.status}).`));
        setBusy(null);
        return;
      }
      onOpened(String(body?.name ?? "Untitled"), tool.app);
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(`A new file was not opened: ${message}`);
      onTrouble(message);
      setBusy(null);
    }
  };

  return createPortal(
    <div className="scrim tools-scrim" onClick={onClose} role="presentation">
      <div
        className="modal tools-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Tools"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-top">
          <IconWrench size={14} />
          <b>Tools</b>
          <div className="spacer" />
          <button className="btn icon ghost" onClick={onClose} aria-label="Close">
            <IconX size={14} />
          </button>
        </div>
        <div className="modal-body tools-body">
          <p className="jf-hint">Opens the app on its own, with a new blank file in it. No message, no waiting.</p>
          <div className="tool-tiles">
            {TOOLS.map((tool) => {
              const off = on !== null && !on[tool.setting];
              return (
                <button
                  key={tool.kind}
                  type="button"
                  className={`tool-tile${off ? " is-off" : ""}${busy === tool.kind ? " is-busy" : ""}`}
                  disabled={off || busy !== null}
                  title={off ? `${tool.app} is switched off on the Tools page` : `Open ${tool.app}`}
                  onClick={() => void open(tool)}
                >
                  <span className="tool-tile-icon">{tool.icon(20)}</span>
                  <span className="tool-tile-main">
                    <b>{tool.app}</b>
                    <em>{off ? "switched off on the Tools page" : tool.what}</em>
                  </span>
                  {busy === tool.kind && <span className="attach-spin" aria-hidden="true" />}
                </button>
              );
            })}
          </div>
          {error && <p className="set-warn">{error}</p>}
          <p className="jf-hint tools-more">
            <IconStar size={12} /> Anything else -- the browser, the app window, a notebook, a PDF made from a
            document -- is opened by asking, since it needs something to show.
          </p>
        </div>
      </div>
    </div>,
    document.body,
  );
}
