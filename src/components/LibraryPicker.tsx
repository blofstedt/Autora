import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconCheck, IconFile, IconFolder, IconNotebook, IconSearch, IconX } from "./Icons";
import {
  countsOf, createNotebook, fetchLibrary, fetchNotebooks, folderOfFile, isPictureMime, sizeLabel,
  type ArtifactFolder, type ArtifactInfo, type ArtifactLibrary, type Notebook,
} from "../lib/notebooks";

export type LibraryTab = "notebooks" | "files" | "folders";

const TAB_LABEL: Record<LibraryTab, string> = { notebooks: "Notebooks", files: "Files", folders: "Folders" };

/**
 * Pick notebooks and saved files: to hand to the agent with a message, or to
 * file in a notebook. Portalled to the body so it sits over everything.
 */
export function LibraryPicker({
  tabs, title, action, exclude, allowNew = false, filter, single = false, onPick, onClose,
}: {
  tabs: LibraryTab[];
  title: string;
  /** The confirm button's verb: "Add", "Attach"... */
  action: string;
  /** Ids already chosen elsewhere, shown ticked and not offered again. */
  exclude?: ReadonlySet<string>;
  /** Offer to make a notebook here, picked as soon as it is made. */
  allowNew?: boolean;
  /** Only the files this says yes to are offered (what an app's Load can open). */
  filter?: (file: ArtifactInfo) => boolean;
  /** One thing at a time: choosing another replaces the choice. */
  single?: boolean;
  onPick: (picked: { notebooks: Notebook[]; files: ArtifactInfo[]; folders: ArtifactFolder[] }) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<LibraryTab>(tabs[0]);
  const [books, setBooks] = useState<Notebook[] | null>(null);
  const [lib, setLib] = useState<ArtifactLibrary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [newTitle, setNewTitle] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const wantBooks = tabs.includes("notebooks");
  const wantFiles = tabs.includes("files") || tabs.includes("folders");

  useEffect(() => {
    if (wantBooks) fetchNotebooks().then(setBooks).catch(() => setError("Could not load notebooks."));
    if (wantFiles) fetchLibrary().then(setLib).catch(() => setError("Could not load files."));
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
  const folderName = useMemo(() => new Map((lib?.folders ?? []).map((f) => [f.id, f.name])), [lib]);
  const files = lib ? lib.artifacts.filter((f) => !filter || filter(f)) : null;
  const shownFiles = useMemo(() => (files ?? []).filter((f) =>
    !needle || f.name.toLowerCase().includes(needle) || (f.note ?? "").toLowerCase().includes(needle) ||
    (lib ? (folderName.get(folderOfFile(f, lib) ?? "") ?? "").toLowerCase().includes(needle) : false)),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [lib, needle, filter]);
  /** What is in each folder, to say how much choosing it takes. */
  const inFolder = useMemo(() => {
    const counts = new Map<string, number>();
    for (const f of lib?.artifacts ?? []) {
      const at = folderOfFile(f, lib!);
      if (at) counts.set(at, (counts.get(at) ?? 0) + 1);
    }
    return counts;
  }, [lib]);
  const shownFolders = useMemo(() => (lib?.folders ?? []).filter((f) =>
    (inFolder.get(f.id) ?? 0) > 0 && (!needle || f.name.toLowerCase().includes(needle))), [lib, inFolder, needle]);

  const toggle = (id: string) => {
    if (exclude?.has(id)) return;
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : single ? [id] : [...p, id]));
  };

  const confirm = () => {
    onPick({
      notebooks: (books ?? []).filter((b) => picked.includes(b.id)),
      files: (files ?? []).filter((f) => picked.includes(f.id)),
      folders: (lib?.folders ?? []).filter((f) => picked.includes(f.id)),
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

  const list = tab === "notebooks" ? books : tab === "folders" ? (lib ? lib.folders : null) : files;
  const empty = tab === "notebooks"
    ? "No notebooks yet. Make one on the Notebooks page, or ask Autora to."
    : tab === "folders"
      ? "No folders yet. Move files into a folder on the Artifacts page, and they are here as a project."
      : filter
        ? "Nothing saved here fits. Save something from an app, or upload a file on the Artifacts page."
        : "No saved files yet. Upload one on the Artifacts page, or attach one with the paperclip.";
  const shown = tab === "notebooks" ? shownBooks : tab === "folders" ? shownFolders : shownFiles;

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
                {t === "notebooks" ? <IconNotebook size={14} /> : t === "folders" ? <IconFolder size={14} /> : <IconFile size={14} />}
                {TAB_LABEL[t]}
              </button>
            ))}
          </div>
        )}

        <label className="ses-search">
          <IconSearch size={14} />
          <input
            ref={search}
            type="search"
            placeholder={`Search ${TAB_LABEL[tab].toLowerCase()}`}
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
          {list !== null && list.length > 0 && shown.length === 0 && (
            <p className="jf-hint">Nothing matches “{query.trim()}”.</p>
          )}
          {tab === "notebooks" && shownBooks.map((b) =>
            row(b.id, <IconNotebook size={16} />, b.title, [countsOf(b), b.purpose.split("\n")[0]].filter(Boolean).join(" · ")))}
          {tab === "folders" && shownFolders.map((f) =>
            row(f.id, <IconFolder size={16} />, f.name, `${inFolder.get(f.id) ?? 0} file${inFolder.get(f.id) === 1 ? "" : "s"} · the whole project`))}
          {tab === "files" && shownFiles.map((f) =>
            row(
              f.id,
              isPictureMime(f.mime)
                ? <img className="lib-thumb" src={`/api/artifacts/${f.id}`} alt="" loading="lazy" />
                : <IconFile size={16} />,
              f.name,
              [
                lib ? folderName.get(folderOfFile(f, lib) ?? "") : undefined,
                sizeLabel(f.size), f.origin === "user" ? "uploaded" : "made by Autora", f.note ?? "",
              ].filter(Boolean).join(" · "),
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
