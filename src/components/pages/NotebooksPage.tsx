import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { createPortal } from "react-dom";
import { Markdown } from "../Markdown";
import { LibraryPicker } from "../LibraryPicker";
import {
  IconArrowDown, IconArrowLeft, IconArrowUp, IconBot, IconDownload, IconEdit, IconFile,
  IconFolder, IconMessage, IconNotebook, IconPlus, IconTrash, IconUpload,
} from "../Icons";
import {
  addToNotebook, countsOf, createNotebook, deleteNotebook, fetchArtifacts, fetchNotebooks,
  isPictureMime, removeEntry, sizeLabel, updateEntry, updateNotebook,
  type ArtifactInfo, type Notebook, type NotebookEntry, type NotebookRef,
} from "../../lib/notebooks";
import { every } from "../../lib/poll";
import { sure } from "../../lib/sure";

const date = (ts: number) =>
  new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/**
 * Notebooks: artifacts grouped by purpose, with notes between them. Made here
 * or by the agent; either can add to one, and a notebook can be handed to a
 * chat whole.
 */
export function NotebooksPage({
  onUseInChat, open, onOpen, topSlot,
}: {
  onUseInChat: (ref: NotebookRef) => void;
  /** The header's corner for the page's own action, as on Schedules. */
  topSlot?: HTMLElement | null;
  /** The notebook showing, when one is open. */
  open: string | null;
  onOpen: (id: string | null) => void;
}) {
  const [books, setBooks] = useState<Notebook[] | null>(null);
  const [files, setFiles] = useState<ArtifactInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  const [title, setTitle] = useState("");
  const [purpose, setPurpose] = useState("");
  const [query, setQuery] = useState("");
  /** Something is being typed: the poll leaves the page alone till it is saved. */
  const editing = useRef(false);

  const load = useCallback(() => {
    if (editing.current) return;
    fetchNotebooks().then(setBooks).catch(() => setError("Could not load notebooks."));
    fetchArtifacts().then(setFiles).catch(() => undefined);
  }, []);

  // The agent fills notebooks mid-turn; a slow poll keeps the page honest.
  useEffect(() => {
    load();
    return every(load, 8000);
  }, [load]);

  const adopt = useCallback((book: Notebook) => {
    setBooks((list) => (list ?? []).some((b) => b.id === book.id)
      ? (list ?? []).map((b) => (b.id === book.id ? book : b))
      : [book, ...(list ?? [])]);
  }, []);

  const make = async () => {
    if (!title.trim()) return;
    setError(null);
    try {
      const book = await createNotebook(title.trim(), purpose.trim());
      adopt(book);
      setMaking(false);
      setTitle("");
      setPurpose("");
      onOpen(book.id);
    } catch (err: any) {
      setError(err?.message ?? "Could not make the notebook.");
    }
  };

  const book = open ? books?.find((b) => b.id === open) ?? null : null;

  if (open && books && !book) {
    return (
      <div className="page-scroll">
        <div className="page-inner">
          <p className="jf-hint">That notebook is gone.</p>
          <button className="btn ghost" onClick={() => onOpen(null)}><IconArrowLeft size={14} /> All notebooks</button>
        </div>
      </div>
    );
  }

  if (book) {
    return (
      <NotebookView
        key={book.id}
        book={book}
        files={files}
        editing={editing}
        onBack={() => onOpen(null)}
        onChanged={adopt}
        onDeleted={() => {
          setBooks((list) => (list ?? []).filter((b) => b.id !== book.id));
          onOpen(null);
        }}
        onFilesChanged={() => { fetchArtifacts().then(setFiles).catch(() => undefined); }}
        onUseInChat={() => onUseInChat({ id: book.id, title: book.title })}
      />
    );
  }

  const needle = query.trim().toLowerCase();
  const shown = (books ?? []).filter((b) =>
    !needle || b.title.toLowerCase().includes(needle) || b.purpose.toLowerCase().includes(needle));

  return (
    <div className="page-scroll">
      <div className="page-inner">
        <p className="jf-hint art-lede">
          Files grouped by purpose, with notes between them — a case, a report, a project.
          Make one here, or ask Autora to compile one; hand a notebook to a chat with the
          notebook button beside the message box.
        </p>
        {error && <p className="set-warn">{error}</p>}

        {/* The button that makes one sits in the header's corner, where
            Schedules and Triggers keep theirs; inline only without a header. */}
        {topSlot && !making && createPortal(
          <button className="btn primary top-action" onClick={() => setMaking(true)}>
            <IconPlus size={13} /> <span className="top-action-word">New notebook</span>
          </button>,
          topSlot,
        )}
        {((books?.length ?? 0) > 3 || (!topSlot && !making)) && (
          <div className="art-toolbar">
            {(books?.length ?? 0) > 3 && (
              <input
                className="nb-search"
                type="search"
                placeholder="Search notebooks"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search notebooks"
              />
            )}
            <div className="spacer" />
            {!topSlot && !making && (
              <button className="btn primary" onClick={() => setMaking(true)}>
                <IconPlus size={14} /> New notebook
              </button>
            )}
          </div>
        )}

        {making && (
          <form className="nb-new" onSubmit={(e) => { e.preventDefault(); void make(); }}>
            <input
              autoFocus
              placeholder="Title, e.g. Dispute with Acme — evidence"
              value={title}
              maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
              aria-label="Notebook title"
            />
            <textarea
              placeholder="What it is for (optional) — Autora reads this when it works in the notebook"
              value={purpose}
              rows={2}
              maxLength={2000}
              onChange={(e) => setPurpose(e.target.value)}
              aria-label="What the notebook is for"
            />
            <div className="nb-new-acts">
              <button type="button" className="btn ghost" onClick={() => setMaking(false)}>Cancel</button>
              <button type="submit" className="btn primary" disabled={!title.trim()}>Make it</button>
            </div>
          </form>
        )}

        {books !== null && books.length === 0 && !making && (
          <div className="nb-empty">
            <IconNotebook size={28} />
            <p>No notebooks yet.</p>
            <p className="jf-hint">
              Try asking: “Compile a report in a notebook from these emails, and refute each point in the
              contract with proof.”
            </p>
          </div>
        )}

        <div className="nb-grid">
          {shown.map((b) => (
            <button key={b.id} className="nb-card" onClick={() => onOpen(b.id)}>
              <span className="nb-card-icon"><IconNotebook size={18} /></span>
              <span className="nb-card-main">
                <b>{b.title}</b>
                {b.purpose && <span className="nb-purpose">{b.purpose}</span>}
                <em>
                  {countsOf(b)} · {date(b.updated)}
                  {b.by === "agent" && <> · <IconBot size={11} /> by Autora</>}
                </em>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function NotebookView({
  book, files, editing, onBack, onChanged, onDeleted, onFilesChanged, onUseInChat,
}: {
  book: Notebook;
  files: ArtifactInfo[];
  editing: MutableRefObject<boolean>;
  onBack: () => void;
  onChanged: (book: Notebook) => void;
  onDeleted: () => void;
  onFilesChanged: () => void;
  onUseInChat: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const [editingHead, setEditingHead] = useState(false);
  const [headTitle, setHeadTitle] = useState(book.title);
  const [headPurpose, setHeadPurpose] = useState(book.purpose);
  const [edit, setEdit] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  // Typing anywhere on the page holds the poll off.
  const typing = writing || editingHead || edit !== null;
  useEffect(() => {
    editing.current = typing;
    return () => { editing.current = false; };
  }, [editing, typing]);

  const byId = new Map(files.map((f) => [f.id, f]));
  const inBook = new Set(book.entries.flatMap((e) => (e.artifact ? [e.artifact] : [])));

  const run = async (work: () => Promise<Notebook | void>) => {
    setError(null);
    try {
      const next = await work();
      if (next) onChanged(next);
    } catch (err: any) {
      setError(err?.message ?? "That did not work.");
    }
  };

  const upload = async (list: FileList) => {
    const ids: string[] = [];
    for (const file of Array.from(list)) {
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
        if (res.ok && data.artifact?.id) ids.push(data.artifact.id);
        else setError(data.error ?? `Could not upload ${file.name}.`);
      } catch {
        setError(`Could not upload ${file.name}.`);
      }
    }
    setUploading(null);
    onFilesChanged();
    if (ids.length) await run(async () => (await addToNotebook(book.id, { artifacts: ids })).notebook);
  };

  const remove = async () => {
    if (!(await sure(`Delete the notebook “${book.title}”? The files in it stay on the Artifacts page.`))) return;
    try {
      await deleteNotebook(book.id);
      onDeleted();
    } catch (err: any) {
      setError(err?.message ?? "Could not delete it.");
    }
  };

  return (
    <div className="page-scroll">
      <div className="page-inner nb-view">
        <div className="nb-top">
          <button className="btn ghost" onClick={onBack}><IconArrowLeft size={14} /> Notebooks</button>
          <div className="spacer" />
          <button className="btn primary" onClick={onUseInChat} title="Attach this notebook to the next message">
            <IconMessage size={14} /> Use in chat
          </button>
          <a className="btn ghost" href={`/api/notebooks/${book.id}/export`} title="Download as one Markdown document">
            <IconDownload size={14} /> Export
          </a>
          <button className="btn icon ghost" onClick={() => void remove()} title="Delete notebook" aria-label="Delete notebook">
            <IconTrash size={14} />
          </button>
        </div>

        {editingHead ? (
          <form
            className="nb-new"
            onSubmit={(e) => {
              e.preventDefault();
              if (!headTitle.trim()) return;
              void run(() => updateNotebook(book.id, { title: headTitle.trim(), purpose: headPurpose.trim() }))
                .then(() => setEditingHead(false));
            }}
          >
            <input autoFocus value={headTitle} maxLength={200} onChange={(e) => setHeadTitle(e.target.value)} aria-label="Title" />
            <textarea value={headPurpose} rows={3} maxLength={2000} onChange={(e) => setHeadPurpose(e.target.value)}
              placeholder="What it is for" aria-label="What the notebook is for" />
            <div className="nb-new-acts">
              <button type="button" className="btn ghost" onClick={() => setEditingHead(false)}>Cancel</button>
              <button type="submit" className="btn primary" disabled={!headTitle.trim()}>Save</button>
            </div>
          </form>
        ) : (
          <header className="nb-head">
            <h2>{book.title}</h2>
            <button
              className="btn icon ghost"
              onClick={() => { setHeadTitle(book.title); setHeadPurpose(book.purpose); setEditingHead(true); }}
              title="Rename or change its purpose"
              aria-label="Edit title and purpose"
            >
              <IconEdit size={14} />
            </button>
            {book.purpose && <p className="nb-purpose-full">{book.purpose}</p>}
            <em className="nb-meta">
              {countsOf(book)} · changed {date(book.updated)}{book.by === "agent" ? " · started by Autora" : ""}
            </em>
          </header>
        )}

        {error && <p className="set-warn">{error}</p>}

        <ol className="nb-entries">
          {book.entries.map((entry, i) => (
            <li key={entry.id} className={`nb-entry is-${entry.kind}`}>
              {edit === entry.id ? (
                <EntryEditor
                  entry={entry}
                  onCancel={() => setEdit(null)}
                  onSave={(patch) => void run(() => updateEntry(book.id, entry.id, patch)).then(() => setEdit(null))}
                />
              ) : (
                <EntryView entry={entry} byId={byId} />
              )}
              {edit !== entry.id && (
                <div className="nb-entry-acts">
                  <button className="btn icon ghost" disabled={i === 0} title="Move up" aria-label="Move up"
                    onClick={() => void run(() => updateEntry(book.id, entry.id, { position: i }))}>
                    <IconArrowUp size={13} />
                  </button>
                  <button className="btn icon ghost" disabled={i === book.entries.length - 1} title="Move down" aria-label="Move down"
                    onClick={() => void run(() => updateEntry(book.id, entry.id, { position: i + 2 }))}>
                    <IconArrowDown size={13} />
                  </button>
                  <button className="btn icon ghost" title="Edit" aria-label="Edit" onClick={() => setEdit(entry.id)}>
                    <IconEdit size={13} />
                  </button>
                  <button className="btn icon ghost" title="Remove from notebook" aria-label="Remove from notebook"
                    onClick={() => void run(() => removeEntry(book.id, entry.id))}>
                    <IconTrash size={13} />
                  </button>
                </div>
              )}
            </li>
          ))}
        </ol>

        {book.entries.length === 0 && !writing && (
          <p className="jf-hint nb-empty-book">Empty so far. Add files and notes below, or ask Autora to fill it.</p>
        )}

        {writing ? (
          <EntryEditor
            entry={null}
            onCancel={() => setWriting(false)}
            onSave={(patch) => void run(async () => (await addToNotebook(book.id, patch)).notebook).then(() => setWriting(false))}
          />
        ) : (
          <div className="nb-add">
            <button className="btn ghost" onClick={() => setPicking(true)}><IconFolder size={14} /> Add saved files</button>
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              onChange={(e) => { if (e.target.files) void upload(e.target.files); e.target.value = ""; }}
            />
            <button className="btn ghost" disabled={!!uploading} onClick={() => picker.current?.click()}>
              <IconUpload size={14} /> {uploading ? `Uploading ${uploading}…` : "Upload"}
            </button>
            <button className="btn ghost" onClick={() => setWriting(true)}><IconEdit size={14} /> Write a note</button>
          </div>
        )}

        {picking && (
          <LibraryPicker
            tabs={["files"]}
            title={`Add files to “${book.title}”`}
            action="Add"
            exclude={inBook}
            onClose={() => setPicking(false)}
            onPick={({ files: chosen }) => {
              setPicking(false);
              if (chosen.length) void run(async () => (await addToNotebook(book.id, { artifacts: chosen.map((f) => f.id) })).notebook);
            }}
          />
        )}
      </div>
    </div>
  );
}

function FileChip({ id, byId }: { id: string; byId: Map<string, ArtifactInfo> }) {
  const file = byId.get(id);
  if (!file) return <span className="nb-cite is-gone">deleted file</span>;
  return (
    <a className="nb-cite" href={`/api/artifacts/${id}`} target="_blank" rel="noreferrer" title={`Open ${file.name}`}>
      <IconFile size={11} /> {file.name}
    </a>
  );
}

function EntryView({ entry, byId }: { entry: NotebookEntry; byId: Map<string, ArtifactInfo> }) {
  const file = entry.artifact ? byId.get(entry.artifact) : undefined;
  return (
    <div className="nb-entry-body">
      {entry.kind === "artifact" && (
        file ? (
          <a className="nb-file" href={`/api/artifacts/${file.id}`} target="_blank" rel="noreferrer" title={`Open ${file.name}`}>
            {isPictureMime(file.mime)
              ? <img src={`/api/artifacts/${file.id}`} alt={entry.title || file.name} loading="lazy" />
              : <span className="nb-file-icon"><IconFile size={20} /></span>}
            <span className="nb-file-meta">
              <b>{entry.title || file.name}</b>
              <em>{entry.title ? `${file.name} · ` : ""}{sizeLabel(file.size)}</em>
            </span>
          </a>
        ) : (
          <p className="jf-hint">This file has been deleted.</p>
        )
      )}
      {entry.kind === "note" && entry.title && <h4 className="nb-note-title">{entry.title}</h4>}
      {entry.text && <div className="nb-text"><Markdown text={entry.text} /></div>}
      {entry.cites && entry.cites.length > 0 && (
        <div className="nb-cites">
          <span>Supported by</span>
          {entry.cites.map((id) => <FileChip key={id} id={id} byId={byId} />)}
        </div>
      )}
      <span className="nb-by">{entry.by === "agent" ? "Autora" : "You"} · {date(entry.updated ?? entry.added)}</span>
    </div>
  );
}

function EntryEditor({
  entry, onSave, onCancel,
}: {
  entry: NotebookEntry | null;
  onSave: (patch: { title: string; text: string }) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(entry?.title ?? "");
  const [text, setText] = useState(entry?.text ?? "");
  const isFile = entry?.kind === "artifact";
  const empty = !isFile && !title.trim() && !text.trim();
  return (
    <form className="nb-new nb-editor" onSubmit={(e) => { e.preventDefault(); if (!empty) onSave({ title: title.trim(), text: text.trim() }); }}>
      <input
        autoFocus
        placeholder={isFile ? "Caption (optional)" : "Heading (optional)"}
        value={title}
        maxLength={200}
        onChange={(e) => setTitle(e.target.value)}
        aria-label={isFile ? "Caption" : "Heading"}
      />
      <textarea
        placeholder={isFile ? "What this file shows (Markdown)" : "The note (Markdown)"}
        value={text}
        rows={6}
        onChange={(e) => setText(e.target.value)}
        aria-label={isFile ? "Annotation" : "Note"}
      />
      <div className="nb-new-acts">
        <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn primary" disabled={empty}>{entry ? "Save" : "Add note"}</button>
      </div>
    </form>
  );
}
