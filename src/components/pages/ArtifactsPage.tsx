import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { SessionRow } from "../Sessions";
import {
  IconCheck, IconDownload, IconFile, IconSpark, IconTrash, IconUpload, IconUser,
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

/**
 * Artifacts: the files of the workspace, in two piles. What Autora made --
 * generated images, documents it wrote, files it built and handed over -- and
 * what you uploaded for it to work with. The agent can list and read both.
 *
 * Selection mode is what makes clearing out a pile of them bearable: pick any
 * number of cards, across both piles, and delete them in one go. Everything
 * else on the page stays exactly as it was when it is off, which is why the
 * per-card buttons are only hidden while it is on rather than removed.
 */
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
  const picker = useRef<HTMLInputElement>(null);

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
          agent can find and read all of them.
        </p>
        {error && <p className="set-warn">{error}</p>}

        {all.length > 0 && (
          <div className="art-toolbar">
            {selecting ? (
              <>
                <button
                  className="btn ghost"
                  onClick={() => setPicked(allPicked ? [] : all.map((a) => a.id))}
                >
                  {allPicked ? "Clear all" : "Select all"}
                </button>
                <span className="art-selcount" aria-live="polite">
                  {picked.length === 0
                    ? "Tap files to pick them"
                    : `${picked.length} of ${all.length} selected`}
                </span>
                <div className="spacer" />
                <button
                  className="btn danger"
                  disabled={picked.length === 0 || removing}
                  onClick={() => void remove(all.filter((a) => picked.includes(a.id)))}
                >
                  <IconTrash size={14} />
                  {removing ? "Deleting…"
                    : picked.length > 1 ? `Delete ${picked.length}` : "Delete"}
                </button>
                <button className="btn ghost" onClick={leaveSelect} disabled={removing}>Done</button>
              </>
            ) : (
              <>
                <div className="spacer" />
                <button className="btn ghost" onClick={() => setSelecting(true)}>
                  <IconCheck size={14} /> Select
                </button>
              </>
            )}
          </div>
        )}

        {section(
          "Made by Autora", <IconSpark size={14} />, made,
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
