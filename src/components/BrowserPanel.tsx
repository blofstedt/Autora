import { useCallback, useEffect, useRef, useState } from "react";
import { IconX } from "./Icons";

export type BrowserPanelKind = "history" | "bookmarks" | "downloads" | "find";

type Data = {
  history: Array<{ url: string; title: string; ts: number }>;
  bookmarks: Array<{ url: string; title: string; ts: number }>;
  downloads: Array<{ artifact: string; name: string; url: string; size: number; ts: number }>;
};

/** The bookmarks, in a hook so the star in the toolbar and the panel agree. */
export function useBrowserData(on: boolean, refreshOn: string | null) {
  const [data, setData] = useState<Data | null>(null);
  const reload = useCallback(() => {
    fetch("/api/browser/data")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) setData(d as Data); })
      .catch(() => undefined);
  }, []);
  useEffect(() => { if (on) reload(); }, [on, reload, refreshOn]);
  return { data, reload };
}

export async function setBookmark(url: string, title: string, remove: boolean) {
  await fetch("/api/browser/bookmarks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, title, remove }),
  }).catch(() => undefined);
}

const size = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/**
 * History, bookmarks, downloads and find-on-page, in a panel under the tabs.
 * Opening an entry navigates the open tab; a download is the artifact it
 * became.
 */
export function BrowserPanel({
  kind, data, canUse, onClose, onOpen, onFind, onChanged,
}: {
  kind: BrowserPanelKind;
  data: Data | null;
  canUse: boolean;
  onClose: () => void;
  onOpen: (url: string) => void;
  onFind: (text: string, backwards: boolean) => Promise<boolean>;
  onChanged: () => void;
}) {
  const [text, setText] = useState("");
  const [found, setFound] = useState<boolean | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (kind === "find") input.current?.focus(); }, [kind]);

  if (kind === "find") {
    const go = (back: boolean) => { if (text) void onFind(text, back).then(setFound); };
    return (
      <div className="shot-panel shot-find">
        <input
          ref={input}
          value={text}
          placeholder="Find on page"
          onChange={(e) => { setText(e.target.value); setFound(null); }}
          onKeyDown={(e) => { if (e.key === "Enter") go(e.shiftKey); if (e.key === "Escape") onClose(); }}
          disabled={!canUse}
          aria-label="Find on page"
        />
        <button className="cell-act" disabled={!text || !canUse} onClick={() => go(true)}>Prev</button>
        <button className="cell-act" disabled={!text || !canUse} onClick={() => go(false)}>Next</button>
        {found === false && <span className="shot-find-none">no match</span>}
        <button className="shot-tool" onClick={onClose} aria-label="Close find"><IconX size={13} /></button>
      </div>
    );
  }

  const rows = kind === "history" ? data?.history ?? [] : kind === "bookmarks" ? data?.bookmarks ?? [] : [];
  return (
    <div className="shot-panel">
      <div className="shot-panel-head">
        <strong>{kind === "history" ? "History" : kind === "bookmarks" ? "Bookmarks" : "Downloads"}</strong>
        {kind === "history" && rows.length > 0 && (
          <button
            className="cell-act"
            onClick={() => void fetch("/api/browser/history/clear", { method: "POST" }).then(onChanged)}
          >
            Clear
          </button>
        )}
        <button className="shot-tool" onClick={onClose} aria-label="Close"><IconX size={13} /></button>
      </div>
      <div className="shot-panel-list">
        {kind === "downloads"
          ? ((data?.downloads ?? []).length === 0
            ? <p className="shot-panel-empty">Nothing downloaded yet. Files the browser downloads are kept in Files.</p>
            : (data?.downloads ?? []).map((d) => (
              <a key={d.artifact + d.ts} className="shot-panel-row" href={`/api/artifacts/${d.artifact}?download`}>
                <span>{d.name}</span><em>{size(d.size)}</em>
              </a>
            )))
          : rows.length === 0
            ? <p className="shot-panel-empty">{kind === "history" ? "No pages yet." : "No bookmarks yet. Tap the star beside the address."}</p>
            : rows.map((r) => (
              <button key={r.url + r.ts} className="shot-panel-row" disabled={!canUse} onClick={() => { onOpen(r.url); onClose(); }} title={r.url}>
                <span>{r.title || r.url}</span><em>{r.url.replace(/^https?:\/\//, "")}</em>
              </button>
            ))}
      </div>
    </div>
  );
}
