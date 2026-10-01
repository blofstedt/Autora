import {
  useCallback, useEffect, useRef, useState, type MouseEvent, type PointerEvent, type ReactNode,
} from "react";
import type { SessionRow } from "../Sessions";
import { LibraryPicker } from "../LibraryPicker";
import { addToNotebook, type Notebook } from "../../lib/notebooks";
import {
  IconCheck, IconDownload, IconFile, IconMark, IconNotebook, IconTrash, IconUpload, IconUser, IconX,
} from "../Icons";

type Artifact = {
  id: string;
  origin: "agent" | "user";
  name: string;
  mime: string;
  size: number;
  ts: number;
  session?: string;
  note?: string;
};

const size = (bytes: number) =>
  bytes < 1024 ? `${bytes} B`
    : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const date = (ts: number) =>
  new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** A short word for the file's kind, for the badge on a card with no picture. */
function kind(a: Artifact): string {
  const ext = a.name.includes(".") ? a.name.split(".").pop()!.toUpperCase() : "";
  if (ext && ext.length <= 5) return ext;
  return a.mime.split("/")[1]?.toUpperCase().slice(0, 5) || "FILE";
}

const isPicture = (a: Artifact) => a.mime.startsWith("image/") && a.mime !== "image/svg+xml";

const NOTEBOOK_TAB: "notebooks"[] = ["notebooks"];

/**
 * Artifacts: the files of the workspace, in two piles. What Autora made --
 * generated images, documents it wrote, files it built and handed over -- and
 * what you uploaded for it to work with. The agent can list and read both.
 *
 * Selection mode is what makes clearing out a pile of them bearable: pick any
 * number of cards, across both piles, and delete them in one go. It starts the
 * way it does in a phone's gallery -- press and hold a card -- so there is no
 * Select bar taking room when nobody is selecting. Everything else on the page
 * stays exactly as it was when it is off, which is why the per-card buttons
 * are only hidden while it is on rather than removed.
 */

/** How long a press has to last to start selecting. */
const HOLD_MS = 450;
/** A press that moves further than this is a scroll, not a hold. */
const HOLD_SLOP = 10;
export function ArtifactsPage({
  sessions, onOpenSession,
}: {
  sessions: SessionRow[];
  onOpenSession: (id: string) => void;
}) {
  const [items, setItems] = useState<Artifact[] | null>(null);
  const [max, setMax] = useState(50 * 1024 * 1024);
  const [uploading, setUploading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [removing, setRemoving] = useState(false);
  const [filing, setFiling] = useState(false);
  const [filed, setFiled] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  /** The press being timed, and whether the last one became a hold (so the
      click that ends it does not also open the file). */
  const hold = useRef<{ timer: number; x: number; y: number } | null>(null);
  const held = useRef(false);

  const load = useCallback(() => {
    fetch("/api/artifacts").then((r) => r.json()).then((d) => {
      setItems(d.artifacts ?? []);
      if (d.max) setMax(d.max);
    }).catch(() => setError("Could not load artifacts."));
  }, []);
  // The agent can save one mid-turn; a slow poll keeps the page honest.
  useEffect(() => {
    load();
    const t = window.setInterval(load, 8000);
    return () => window.clearInterval(t);
  }, [load]);

  // One the agent deleted, or a page left open while another tab cleared the
  // pile, should not stay counted as picked.
  useEffect(() => {
    if (!items) return;
    const live = new Set(items.map((a) => a.id));
    setPicked((p) => (p.every((id) => live.has(id)) ? p : p.filter((id) => live.has(id))));
  }, [items]);

  const leaveSelect = useCallback(() => {
    setSelecting(false);
    setPicked([]);
  }, []);

  // Escape gets you out, the way it does out of most things here.
  useEffect(() => {
    if (!selecting) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") leaveSelect(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selecting, leaveSelect]);

  const upload = async (files: FileList | File[]) => {
    setError(null);
    for (const file of Array.from(files)) {
      if (file.size > max) {
        setError(`${file.name} is ${size(file.size)}; the limit is ${size(max)}.`);
        continue;
      }
      setUploading(file.name);
      try {
        const res = await fetch("/api/artifacts", {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            "X-File-Name": encodeURIComponent(file.name),
            "X-File-Type": file.type || "",
          },
          body: file,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) setError(data.error ?? `Could not upload ${file.name}.`);
      } catch {
        setError(`Could not upload ${file.name}.`);
      }
    }
    setUploading(null);
    load();
  };

  /** One confirm and one pass, whether it is one file or forty. */
  const remove = async (list: Artifact[]) => {
    if (!list.length || removing) return;
    const what = list.length === 1 ? list[0].name : `${list.length} files`;
    if (!window.confirm(`Delete ${what}? This cannot be undone.`)) return;
    setRemoving(true);
    setError(null);
    const gone: string[] = [];
    const results = await Promise.all(list.map((a) =>
      fetch(`/api/artifacts/${a.id}`, { method: "DELETE" })
        .then((r) => { if (r.ok) gone.push(a.id); return r.ok; })
        .catch(() => false)));
    const failed = results.filter((ok) => !ok).length;
    if (failed) {
      setError(failed === 1
        ? "One file could not be deleted."
        : `${failed} of ${list.length} files could not be deleted.`);
    }
    if (gone.length) setPicked((p) => p.filter((id) => !gone.includes(id)));
    setRemoving(false);
    load();
  };

  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const cancelHold = () => {
    if (hold.current) window.clearTimeout(hold.current.timer);
    hold.current = null;
  };
  useEffect(() => cancelHold, []);

  /** Press and hold a card: selecting starts, with that card picked. */
  const holdProps = (id: string) => ({
    onPointerDown: (e: PointerEvent) => {
      // A new press starts clean: after a hold a phone often sends no click
      // at all, and the flag left set would swallow the next tap.
      held.current = false;
      if (selecting || e.button !== 0) return;
      cancelHold();
      hold.current = {
        x: e.clientX, y: e.clientY,
        timer: window.setTimeout(() => {
          hold.current = null;
          held.current = true;
          setSelecting(true);
          setPicked([id]);
          navigator.vibrate?.(10);
        }, HOLD_MS),
      };
    },
    onPointerMove: (e: PointerEvent) => {
      const h = hold.current;
      if (h && Math.hypot(e.clientX - h.x, e.clientY - h.y) > HOLD_SLOP) cancelHold();
    },
    onPointerUp: cancelHold,
    onPointerCancel: cancelHold,
    onPointerLeave: cancelHold,
    // The click that ends a hold must not open the file or press a button.
    onClickCapture: (e: MouseEvent) => {
      if (held.current) { held.current = false; e.preventDefault(); e.stopPropagation(); }
    },
    // A long press on a phone also asks for the browser's own menu.
    onContextMenu: (e: MouseEvent) => { if (hold.current || held.current || selecting) e.preventDefault(); },
  });

  const file = async (books: Notebook[]) => {
    setFiling(false);
    setError(null);
    setFiled(null);
    try {
      for (const book of books) await addToNotebook(book.id, { artifacts: picked });
      const what = picked.length === 1 ? "1 file" : `${picked.length} files`;
      setFiled(books.length === 1 ? `Added ${what} to “${books[0].title}”.` : `Added ${what} to ${books.length} notebooks.`);
      leaveSelect();
    } catch (err: any) {
      setError(err?.message ?? "Could not add them to the notebook.");
    }
  };

  const all = items ?? [];
  const made = all.filter((a) => a.origin === "agent");
  const uploaded = all.filter((a) => a.origin === "user");
  const titleOf = (id?: string) => sessions.find((s) => s.id === id)?.title?.trim() || null;
  const allPicked = all.length > 0 && picked.length === all.length;

  const thumb = (a: Artifact) => (
    isPicture(a)
      ? <img src={`/api/artifacts/${a.id}`} alt={a.note || a.name} loading="lazy" />
      : <span className="art-kind"><IconFile size={26} /><b>{kind(a)}</b></span>
  );

  const grid = (list: Artifact[]) => (
    <div className="art-grid">
      {list.map((a) => {
        const on = picked.includes(a.id);
        return (
          <article
            key={a.id}
            {...holdProps(a.id)}
            className={`art-card${selecting ? " art-pickable" : ""}${on ? " is-picked" : ""}`}
            role={selecting ? "checkbox" : undefined}
            aria-checked={selecting ? on : undefined}
            aria-label={selecting ? a.name : undefined}
            tabIndex={selecting ? 0 : undefined}
            onClick={selecting ? () => toggle(a.id) : undefined}
            onKeyDown={selecting ? (e) => {
              if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggle(a.id); }
            } : undefined}
          >
            {selecting && (
              <span className="art-pick" aria-hidden="true">{on && <IconCheck size={13} />}</span>
            )}
            {selecting ? (
              <span className="art-thumb">{thumb(a)}</span>
            ) : (
              <a
                className="art-thumb"
                href={`/api/artifacts/${a.id}`}
                target="_blank"
                rel="noreferrer"
                title={`Open ${a.name}`}
              >
                {thumb(a)}
              </a>
            )}
            <div className="art-meta">
              <b title={a.name}>{a.name}</b>
              <em>{size(a.size)} · {date(a.ts)}</em>
              {a.note && <span className="art-note" title={a.note}>{a.note}</span>}
              {!selecting && a.session && titleOf(a.session) && (
                <button className="art-session" onClick={() => onOpenSession(a.session!)}>
                  in “{titleOf(a.session)}”
                </button>
              )}
            </div>
            {!selecting && (
              <div className="art-acts">
                <a
                  className="btn icon ghost"
                  href={`/api/artifacts/${a.id}?download`}
                  title="Download"
                  aria-label={`Download ${a.name}`}
                >
                  <IconDownload size={14} />
                </a>
                <button
                  className="btn icon ghost"
                  onClick={() => void remove([a])}
                  title="Delete"
                  aria-label={`Delete ${a.name}`}
                >
                  <IconTrash size={14} />
                </button>
              </div>
            )}
          </article>
        );
      })}
    </div>
  );

  const section = (
    title: string, icon: ReactNode, list: Artifact[], empty: ReactNode, action?: ReactNode,
  ) => (
    <section className="art-section">
      <div className="art-head">
        <span className="tool-icon">{icon}</span>
        <h3>{title}</h3>
        <span className="art-count">{list.length}</span>
        <div className="spacer" />
        {action}
      </div>
      {items === null ? null : list.length === 0 ? <p className="jf-hint art-empty">{empty}</p> : grid(list)}
    </section>
  );

  return (
    <div
      className={`page-scroll ${dragging ? "art-dragging" : ""}`}
      onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragging(false);
        void upload(e.dataTransfer.files);
      }}
    >
      <div className="page-inner">
        <p className="jf-hint art-lede">
          Everything Autora makes for you and everything you give it: generated
          images, documents it writes, and the files and photos you upload. The
          agent can find and read all of them. Press and hold a file to select.
        </p>
        {error && <p className="set-warn">{error}</p>}
        {filed && <p className="jf-hint art-filed" role="status">{filed}</p>}
        {filing && (
          <LibraryPicker
            tabs={NOTEBOOK_TAB}
            title={picked.length === 1 ? "Add 1 file to…" : `Add ${picked.length} files to…`}
            action="Add"
            allowNew
            onClose={() => setFiling(false)}
            onPick={({ notebooks }) => void file(notebooks)}
          />
        )}

        {selecting && all.length > 0 && (
          /* One row, one style: leave and the count on the left, the two
             things to do with the picked files on the right. */
          <div className="art-toolbar" role="toolbar" aria-label="Selected files">
            <button
              className="btn icon ghost"
              onClick={leaveSelect}
              disabled={removing}
              title="Stop selecting"
              aria-label="Stop selecting"
            >
              <IconX size={15} />
            </button>
            {/* No count on screen, the ticks say it; only a screen reader is told. */}
            <span className="sr-only" aria-live="polite">{picked.length} selected</span>
            <button
              className="art-selall"
              onClick={() => setPicked(allPicked ? [] : all.map((a) => a.id))}
              disabled={removing}
            >
              {allPicked ? "Clear" : "Select all"}
            </button>
            <div className="spacer" />
            <button
              className="btn ghost art-act"
              disabled={picked.length === 0 || removing}
              onClick={() => setFiling(true)}
              aria-label="Add to notebook"
              title="Add to notebook"
            >
              <IconNotebook size={15} /> <span className="art-act-word">Add to notebook</span>
            </button>
            <button
              className="btn ghost art-act is-danger"
              disabled={picked.length === 0 || removing}
              onClick={() => void remove(all.filter((a) => picked.includes(a.id)))}
              aria-label={picked.length > 1 ? `Delete ${picked.length} files` : "Delete"}
              title="Delete"
            >
              <IconTrash size={15} /> <span className="art-act-word">Delete</span>
            </button>
          </div>
        )}

        {section(
          "Made by Autora", <IconMark size={14} />, made,
          "Nothing yet. Images Autora generates and files it saves for you appear here.",
        )}

        {section(
          "Uploaded by you", <IconUser size={14} />, uploaded,
          <>Upload documents, photos or anything else for Autora to work with — or drop files anywhere on this page.</>,
          <>
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              onChange={(e) => { if (e.target.files) void upload(e.target.files); e.target.value = ""; }}
            />
            <button className="btn primary" disabled={!!uploading} onClick={() => picker.current?.click()}>
              <IconUpload size={14} /> {uploading ? `Uploading ${uploading}…` : "Upload"}
            </button>
          </>,
        )}
      </div>
    </div>
  );
}
