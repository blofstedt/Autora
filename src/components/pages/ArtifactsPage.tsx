import {
  useCallback, useEffect, useMemo, useRef, useState,
  type MouseEvent, type PointerEvent, type ReactNode,
} from "react";
import type { SessionRow } from "../Sessions";
import { LibraryPicker } from "../LibraryPicker";
import { addToNotebook, type Notebook } from "../../lib/notebooks";
import { ArtThumb, canPicture, kindOf, type Artifact } from "../ArtThumb";
import {
  IconCheck, IconDownload, IconMark, IconNotebook, IconSearch, IconTrash,
  IconUpload, IconUser, IconX,
} from "../Icons";

const size = (bytes: number) =>
  bytes < 1024 ? `${bytes} B`
    : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const date = (ts: number) =>
  new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

const NOTEBOOK_TAB: "notebooks"[] = ["notebooks"];

/** The sort of thing a file is, for the filter chips. */
type Kind = "all" | "image" | "pdf" | "doc" | "sheet" | "slide" | "text" | "other";
type Grouping = "session" | "date" | "kind" | "none";
type Order = "new" | "old" | "big" | "name";
type Who = "all" | "agent" | "user";

const extOf = (a: Artifact) =>
  (a.name.includes(".") ? a.name.split(".").pop()! : "").toUpperCase();

function kindOfArtifact(a: Artifact): Kind {
  const ext = extOf(a);
  if (a.mime === "application/pdf" || ext === "PDF") return "pdf";
  if (a.mime.startsWith("image/") && a.mime !== "image/svg+xml") return "image";
  if (a.mime.startsWith("image/")) return "image";
  if (["XLS", "XLSX", "XLSM", "CSV", "ODS", "NUMBERS"].includes(ext)) return "sheet";
  if (["PPT", "PPTX", "KEY", "ODP"].includes(ext)) return "slide";
  if (["DOC", "DOCX", "DOCM", "RTF", "ODT", "PAGES"].includes(ext)) return "doc";
  if (a.mime.startsWith("text/") || ["MD", "MARKDOWN", "JSON", "XML", "YAML", "YML", "LOG", "TXT", "HTML", "HTM", "JS", "TS", "TSX", "PY", "SH", "CSS", "SQL"].includes(ext)) return "text";
  return "other";
}

const CHIPS: { key: Kind; label: string }[] = [
  { key: "all", label: "Everything" },
  { key: "image", label: "Images" },
  { key: "pdf", label: "PDFs" },
  { key: "doc", label: "Documents" },
  { key: "sheet", label: "Sheets" },
  { key: "slide", label: "Slides" },
  { key: "text", label: "Text" },
  { key: "other", label: "Other" },
];

const KIND_WORD: Record<Kind, string> = {
  all: "Files", image: "Images", pdf: "PDFs", doc: "Documents",
  sheet: "Sheets", slide: "Slides", text: "Text", other: "Other files",
};

/** How many cards a group shows before it offers the rest. */
const PREVIEW = 24;
/** How long a press has to last to start selecting. */
const HOLD_MS = 450;
/** A press that moves further than this is a scroll, not a hold. */
const HOLD_SLOP = 10;

const order = (list: Artifact[], by: Order): Artifact[] => {
  const out = [...list];
  if (by === "new") out.sort((a, b) => b.ts - a.ts);
  else if (by === "old") out.sort((a, b) => a.ts - b.ts);
  else if (by === "big") out.sort((a, b) => b.size - a.size);
  else out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return out;
};

/** A day named the way a person would: today, yesterday, then the date. */
function dayLabel(ts: number): string {
  const then = new Date(ts);
  const midnight = new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime();
  const days = Math.round((Date.now() - midnight) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return then.toLocaleDateString([], { weekday: "long" });
  return then.toLocaleDateString([], { month: "long", year: then.getFullYear() === new Date().getFullYear() ? undefined : "numeric", day: "numeric" });
}

type Group = { key: string; title: string; sub?: string; icon?: ReactNode; list: Artifact[] };

/**
 * Artifacts: every file of the workspace on one page, arranged so that a
 * hundred of them can be read instead of scrolled past. Files are grouped by
 * the conversation they came out of (or by date, or by kind), searched by name,
 * note or session, filtered by what they are and by who made them, and drawn
 * as themselves -- a PDF's first page, a document's first lines, a tile whose
 * colour says what kind of file it is -- rather than as a wall of grey.
 *
 * Selection mode is what makes clearing out a pile of them bearable: pick any
 * number of cards and delete or file them in one go. It starts the way it does
 * in a phone's gallery -- press and hold a card -- so there is no Select bar
 * taking room when nobody is selecting.
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
  const [filing, setFiling] = useState(false);
  const [filed, setFiled] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<Kind>("all");
  const [who, setWho] = useState<Who>("all");
  const [grouping, setGrouping] = useState<Grouping>("session");
  const [sort, setSort] = useState<Order>("new");
  /** Group keys folded shut, and group keys showing every card. */
  const [closed, setClosed] = useState<string[]>([]);
  const [opened, setOpened] = useState<string[]>([]);
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

  const all = useMemo(() => items ?? [], [items]);
  const titleOf = useCallback(
    (id?: string) => sessions.find((s) => s.id === id)?.title?.trim() || null,
    [sessions],
  );

  const search = query.trim().toLowerCase();
  const filtersOn = kind !== "all" || who !== "all" || search.length > 0;

  const counts = useMemo(() => {
    const out: Record<string, number> = { all: all.length };
    for (const a of all) {
      const k = kindOfArtifact(a);
      out[k] = (out[k] ?? 0) + 1;
    }
    return out;
  }, [all]);

  const shown = useMemo(() => order(all.filter((a) => {
    if (who !== "all" && a.origin !== who) return false;
    if (kind !== "all" && kindOfArtifact(a) !== kind) return false;
    if (search && !`${a.name} ${a.note ?? ""} ${titleOf(a.session) ?? ""}`.toLowerCase().includes(search)) return false;
    return true;
  }), sort), [all, who, kind, search, sort, titleOf]);

  const groups = useMemo((): Group[] => {
    if (grouping === "none") return [{ key: "all", title: "", list: shown }];
    if (grouping === "kind") {
      const wanted: Kind[] = ["image", "pdf", "doc", "sheet", "slide", "text", "other"];
      return wanted
        .map((k) => ({ key: k, title: KIND_WORD[k], list: shown.filter((a) => kindOfArtifact(a) === k) }))
        .filter((g) => g.list.length > 0);
    }
    if (grouping === "date") {
      // `shown` is already in order, so each new day starts a new group.
      const out: Group[] = [];
      for (const a of shown) {
        const label = dayLabel(a.ts);
        const last = out[out.length - 1];
        if (last && last.key === label) last.list.push(a);
        else out.push({ key: label, title: label, list: [a] });
      }
      return out;
    }
    // Session: the conversation a file came out of, newest first.
    const byKey = new Map<string, Artifact[]>();
    for (const a of shown) {
      const key = a.session || "none";
      const list = byKey.get(key);
      if (list) list.push(a);
      else byKey.set(key, [a]);
    }
    return [...byKey.entries()]
      .map(([key, list]) => ({ key, list, newest: list.reduce((t, a) => Math.max(t, a.ts), 0) }))
      .sort((a, b) => b.newest - a.newest)
      .map(({ key, list, newest }): Group => ({
        key,
        // Most files came out of conversations the session list no longer
        // holds, and every one of those used to read as the same title. With
        // no title to use, the group is named by when it came out, which tells
        // two of them apart instead of printing one wrong sentence twice.
        title: key === "none" ? "Not from a conversation" : (titleOf(key) ?? date(newest)),
        sub: key !== "none" && !titleOf(key)
          ? `An earlier conversation · ${list.length} ${list.length === 1 ? "file" : "files"}`
          : `${date(newest)} · ${list.length} ${list.length === 1 ? "file" : "files"}`,
        icon: <IconMark size={14} />,
        list,
      }));
  }, [shown, grouping, titleOf]);

  const shownIds = shown.map((a) => a.id);
  const allPicked = shownIds.length > 0 && shownIds.every((id) => picked.includes(id));
  const clearFilters = () => { setQuery(""); setKind("all"); setWho("all"); };
  const fold = (key: string, list: string[], set: (v: string[]) => void) =>
    set(list.includes(key) ? list.filter((k) => k !== key) : [...list, key]);

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
              <span className="art-thumb"><ArtThumb a={a} /></span>
            ) : (
              <a
                className="art-thumb"
                href={`/api/artifacts/${a.id}`}
                target="_blank"
                rel="noreferrer"
                title={`Open ${a.name}`}
              >
                <ArtThumb a={a} />
                {/* A white page of a white PDF tells you nothing; the corner
                    label says what the file is either way. */}
                {canPicture(a) && <span className="art-badge">{kindOf(a)}</span>}
              </a>
            )}
            <div className="art-meta">
              <b title={a.name}>{a.name}</b>
              <em className="art-sub">
                <span
                  className={`art-owner is-${a.origin}`}
                  title={a.origin === "agent" ? "Made by Autora" : "Uploaded by you"}
                >
                  {a.origin === "agent" ? <IconMark size={11} /> : <IconUser size={11} />}
                </span>
                {size(a.size)} · {date(a.ts)}
              </em>
              {a.note && <span className="art-note" title={a.note}>{a.note}</span>}
              {!selecting && grouping !== "session" && a.session && titleOf(a.session) && (
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
          images, documents it writes, and the files and photos you upload. Grouped
          by the conversation they came out of, with each file drawn as itself. Press
          and hold a file to select.
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

        {selecting && all.length > 0 ? (
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
              onClick={() => setPicked(allPicked ? [] : shownIds)}
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
        ) : (
          <>
            <div className="art-tools">
              <span className="art-find">
                <IconSearch size={14} />
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search files"
                  aria-label="Search files by name or note"
                />
                {query && (
                  <button className="art-find-x" onClick={() => setQuery("")} aria-label="Clear search">
                    <IconX size={13} />
                  </button>
                )}
              </span>
              <div className="spacer" />
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
            </div>

            <div className="art-chips" role="group" aria-label="Filter by kind">
              {CHIPS.filter((c) => c.key === "all" || counts[c.key]).map((c) => (
                <button
                  key={c.key}
                  className={`art-chip${kind === c.key ? " is-on" : ""}`}
                  aria-pressed={kind === c.key}
                  onClick={() => setKind(c.key)}
                >
                  {c.label} <em>{counts[c.key] ?? 0}</em>
                </button>
              ))}
            </div>

            <div className="art-sorts">
              <label className="art-select">
                <span>Who</span>
                <select value={who} onChange={(e) => setWho(e.target.value as Who)}>
                  <option value="all">Everyone</option>
                  <option value="agent">Made by Autora</option>
                  <option value="user">Yours</option>
                </select>
              </label>
              <label className="art-select">
                <span>Grouped by</span>
                <select value={grouping} onChange={(e) => setGrouping(e.target.value as Grouping)}>
                  <option value="session">Conversation</option>
                  <option value="date">Date</option>
                  <option value="kind">Kind of file</option>
                  <option value="none">Nothing</option>
                </select>
              </label>
              <label className="art-select">
                <span>Order</span>
                <select value={sort} onChange={(e) => setSort(e.target.value as Order)}>
                  <option value="new">Newest first</option>
                  <option value="old">Oldest first</option>
                  <option value="big">Largest first</option>
                  <option value="name">By name</option>
                </select>
              </label>
              {filtersOn && (
                <button className="art-chip" onClick={clearFilters}>Clear filters</button>
              )}
              {items && filtersOn && (
                <span className="art-found">{shown.length} of {all.length} files</span>
              )}
            </div>
          </>
        )}

        {items === null ? null : all.length === 0 ? (
          <p className="jf-hint art-empty">
            Nothing yet. Images Autora generates and files it saves for you appear here — drop a
            file anywhere on this page to add one of your own.
          </p>
        ) : shown.length === 0 ? (
          <p className="jf-hint art-empty">
            No file matches that.{" "}
            <button className="art-link" onClick={clearFilters}>Clear the filters</button>.
          </p>
        ) : (
          groups.map((g) => {
            const shut = closed.includes(g.key);
            const wide = opened.includes(g.key);
            const list = wide ? g.list : g.list.slice(0, PREVIEW);
            return (
              <section className="art-section" key={g.key}>
                {g.title && (
                  <button
                    className="art-head art-toggle"
                    aria-expanded={!shut}
                    onClick={() => fold(g.key, closed, setClosed)}
                  >
                    {g.icon && <span className="tool-icon">{g.icon}</span>}
                    <h3>{g.title}</h3>
                    <span className="art-count">{g.list.length}</span>
                    <div className="spacer" />
                    {g.sub && <span className="art-when">{g.sub}</span>}
                    <span className="art-caret" aria-hidden="true">{shut ? "▸" : "▾"}</span>
                  </button>
                )}
                {!shut && grid(list)}
                {!shut && g.list.length > PREVIEW && (
                  <button className="btn ghost art-more" onClick={() => fold(g.key, opened, setOpened)}>
                    {wide ? "Show fewer" : `Show all ${g.list.length}`}
                  </button>
                )}
              </section>
            );
          })
        )}
      </div>
    </div>
  );
}
