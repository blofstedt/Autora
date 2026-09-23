import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { SessionRow } from "../Sessions";
import { IconDownload, IconFile, IconSpark, IconTrash, IconUpload, IconUser } from "../Icons";

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

  const remove = async (a: Artifact) => {
    if (!window.confirm(`Delete ${a.name}? This cannot be undone.`)) return;
    await fetch(`/api/artifacts/${a.id}`, { method: "DELETE" }).catch(() => undefined);
    load();
  };

  const made = (items ?? []).filter((a) => a.origin === "agent");
  const uploaded = (items ?? []).filter((a) => a.origin === "user");
  const titleOf = (id?: string) => sessions.find((s) => s.id === id)?.title?.trim() || null;

  const grid = (list: Artifact[]) => (
    <div className="art-grid">
      {list.map((a) => (
        <article key={a.id} className="art-card">
          <a className="art-thumb" href={`/api/artifacts/${a.id}`} target="_blank" rel="noreferrer" title={`Open ${a.name}`}>
            {isPicture(a)
              ? <img src={`/api/artifacts/${a.id}`} alt={a.note || a.name} loading="lazy" />
              : <span className="art-kind"><IconFile size={26} /><b>{kind(a)}</b></span>}
          </a>
          <div className="art-meta">
            <b title={a.name}>{a.name}</b>
            <em>{size(a.size)} · {date(a.ts)}</em>
            {a.note && <span className="art-note" title={a.note}>{a.note}</span>}
            {a.session && titleOf(a.session) && (
              <button className="art-session" onClick={() => onOpenSession(a.session!)}>
                in “{titleOf(a.session)}”
              </button>
            )}
          </div>
          <div className="art-acts">
            <a className="btn icon ghost" href={`/api/artifacts/${a.id}?download`} title="Download" aria-label={`Download ${a.name}`}>
              <IconDownload size={14} />
            </a>
            <button className="btn icon ghost" onClick={() => void remove(a)} title="Delete" aria-label={`Delete ${a.name}`}>
              <IconTrash size={14} />
            </button>
          </div>
        </article>
      ))}
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
