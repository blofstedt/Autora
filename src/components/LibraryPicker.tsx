import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconCheck, IconFile, IconFolder, IconNotebook, IconSearch, IconX } from "./Icons";
import {
  countsOf, createNotebook, fetchArtifacts, fetchNotebooks, isPictureMime, sizeLabel,
  type ArtifactInfo, type Notebook,
} from "../lib/notebooks";

export type LibraryTab = "notebooks" | "files";

/**
 * Pick notebooks and saved files: to hand to the agent with a message, or to
 * file in a notebook. Portalled to the body so it sits over everything.
 */
export function LibraryPicker({
  tabs, title, action, exclude, allowNew = false, onPick, onClose,
}: {
  tabs: LibraryTab[];
  title: string;
  /** The confirm button's verb: "Add", "Attach"... */
  action: string;
  /** Ids already chosen elsewhere, shown ticked and not offered again. */
  exclude?: ReadonlySet<string>;
  /** Offer to make a notebook here, picked as soon as it is made. */
  allowNew?: boolean;
  onPick: (picked: { notebooks: Notebook[]; files: ArtifactInfo[] }) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<LibraryTab>(tabs[0]);
  const [books, setBooks] = useState<Notebook[] | null>(null);
  const [files, setFiles] = useState<ArtifactInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [newTitle, setNewTitle] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const wantBooks = tabs.includes("notebooks");
  const wantFiles = tabs.includes("files");

  useEffect(() => {
    if (wantBooks) fetchNotebooks().then(setBooks).catch(() => setError("Could not load notebooks."));
    if (wantFiles) fetchArtifacts().then(setFiles).catch(() => setError("Could not load files."));
    if (window.matchMedia?.("(pointer: fine)").matches) search.current?.focus();
  }, [wantBooks, wantFiles]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const needle = query.trim().toLowerCase();
  const shownBooks = useMemo(() => (books ?? []).filter((b) =>
    !needle || b.title.toLowerCase().includes(needle) || b.purpose.toLowerCase().includes(needle)), [books, needle]);
  const shownFiles = useMemo(() => (files ?? []).filter((f) =>
    !needle || f.name.toLowerCase().includes(needle) || (f.note ?? "").toLowerCase().includes(needle)), [files, needle]);

  const toggle = (id: string) => {
    if (exclude?.has(id)) return;
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  };

  const confirm = () => {
    onPick({
      notebooks: (books ?? []).filter((b) => picked.includes(b.id)),
      files: (files ?? []).filter((f) => picked.includes(f.id)),
    });
  };

  const makeNew = async () => {
    const name = newTitle.trim();
    if (!name) return;
    setError(null);
    try {
      const book = await createNotebook(name);
      setBooks((list) => [book, ...(list ?? [])]);
      setPicked((p) => [...p, book.id]);
      setNewTitle("");
    } catch (err: any) {
      setError(err?.message ?? "Could not make the notebook.");
    }
  };

  const row = (id: string, icon: JSX.Element, name: string, meta: string) => {
    const already = exclude?.has(id) ?? false;
    const on = already || picked.includes(id);
    return (
      <button
        key={id}
        type="button"
        className={`lib-row${on ? " is-on" : ""}`}
        role="checkbox"
        aria-checked={on}
        disabled={already}
        onClick={() => toggle(id)}
        title={already ? "Already added" : name}
      >
        <span className="lib-tick" aria-hidden="true">{on && <IconCheck size={12} />}</span>
        <span className="lib-icon">{icon}</span>
        <span className="lib-main">
          <b>{name}</b>
          <em>{meta}</em>
        </span>
      </button>
    );
  };

  const list = tab === "notebooks" ? books : files;
  const empty = tab === "notebooks"
    ? "No notebooks yet. Make one on the Notebooks page, or ask Autora to."
    : "No saved files yet. Upload one on the Artifacts page, or attach one with the paperclip.";

  return createPortal(
    <div className="scrim" onClick={onClose} role="presentation">
      <div
        className="modal lib-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-top">
          <b>{title}</b>
          <div className="spacer" />
          <button className="btn icon ghost" onClick={onClose} aria-label="Close">
            <IconX size={14} />
          </button>
        </div>

        {tabs.length > 1 && (
          <div className="lib-tabs" role="tablist">
            {tabs.map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                className={`lib-tab${tab === t ? " on" : ""}`}
                onClick={() => setTab(t)}
              >
                {t === "notebooks" ? <IconNotebook size={14} /> : <IconFolder size={14} />}
                {t === "notebooks" ? "Notebooks" : "Files"}
              </button>
            ))}
          </div>
        )}

        <label className="ses-search">
          <IconSearch size={14} />
          <input
            ref={search}
            type="search"
            placeholder={tab === "notebooks" ? "Search notebooks" : "Search files"}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search"
          />
        </label>

        <div className="modal-body lib-body">
          {error && <p className="set-warn">{error}</p>}
          {allowNew && tab === "notebooks" && (
            <form className="lib-new" onSubmit={(e) => { e.preventDefault(); void makeNew(); }}>
              <input
                placeholder="New notebook title"
                value={newTitle}
                maxLength={200}
                onChange={(e) => setNewTitle(e.target.value)}
                aria-label="New notebook title"
              />
              <button type="submit" className="btn ghost" disabled={!newTitle.trim()}>Make</button>
            </form>
          )}
          {list === null && !error && <p className="jf-hint">Loading…</p>}
          {list !== null && list.length === 0 && <p className="jf-hint">{empty}</p>}
          {list !== null && list.length > 0 && (tab === "notebooks" ? shownBooks : shownFiles).length === 0 && (
            <p className="jf-hint">Nothing matches “{query.trim()}”.</p>
          )}
          {tab === "notebooks" && shownBooks.map((b) =>
            row(b.id, <IconNotebook size={16} />, b.title, [countsOf(b), b.purpose.split("\n")[0]].filter(Boolean).join(" · ")))}
          {tab === "files" && shownFiles.map((f) =>
            row(
              f.id,
              isPictureMime(f.mime)
                ? <img className="lib-thumb" src={`/api/artifacts/${f.id}`} alt="" loading="lazy" />
                : <IconFile size={16} />,
              f.name,
              [sizeLabel(f.size), f.origin === "user" ? "uploaded" : "made by Autora", f.note ?? ""].filter(Boolean).join(" · "),
            ))}
        </div>

        <div className="modal-foot lib-foot">
          <span className="lib-count" aria-live="polite">
            {picked.length === 0 ? "Nothing picked" : `${picked.length} picked`}
          </span>
          <div className="spacer" />
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={picked.length === 0} onClick={confirm}>
            {action}{picked.length > 1 ? ` ${picked.length}` : ""}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
