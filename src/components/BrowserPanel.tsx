import { useCallback, useEffect, useRef, useState } from "react";
import { IconX } from "./Icons";

export type BrowserPanelKind = "history" | "bookmarks" | "downloads" | "find" | "extensions";

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
function ListPanel({
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

export function BrowserPanel(props: Parameters<typeof ListPanel>[0] & { onNewTab: (url: string) => void }) {
  const { onNewTab, ...rest } = props;
  if (props.kind === "extensions") return <ExtensionsPanel canUse={props.canUse} onClose={props.onClose} onNewTab={onNewTab} />;
  return <ListPanel {...rest} />;
}

type Ext = {
  id: string; name: string; version: string; enabled: boolean; source: string;
  popup: string | null; options: string | null;
};

/** Chrome extensions: add one from the Web Store or a file, switch it on and
    off, open its popup, remove it. They load when the browser restarts. */
function ExtensionsPanel({ canUse, onClose, onNewTab }: { canUse: boolean; onClose: () => void; onNewTab: (url: string) => void }) {
  const [list, setList] = useState<Ext[]>([]);
  const [source, setSource] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [changed, setChanged] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    fetch("/api/extensions").then((r) => r.json()).then((d) => setList(d.extensions ?? [])).catch(() => undefined);
  }, []);
  useEffect(load, [load]);

  const done = (r: Response) => r.json().then((d) => {
    if (!r.ok) throw new Error(d.error ?? "That did not work.");
    setNote(null);
    setChanged(true);
    load();
  }).catch((e: Error) => setNote(e.message)).finally(() => setBusy(false));

  const install = () => {
    if (!source.trim()) return;
    setBusy(true);
    void fetch("/api/extensions/install", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source }),
    }).then(done).then(() => setSource(""));
  };
  const upload = (f: File) => {
    setBusy(true);
    void fetch(`/api/extensions/upload?name=${encodeURIComponent(f.name)}`, { method: "POST", body: f }).then(done);
  };
  const patch = (id: string, body: object) =>
    void fetch(`/api/extensions/item/${id}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }).then(done);

  return (
    <div className="shot-panel">
      <div className="shot-panel-head">
        <strong>Extensions <em className="shot-exp">experimental</em></strong>
        <button className="shot-tool" onClick={onClose} aria-label="Close"><IconX size={13} /></button>
      </div>
      <div className="shot-panel-list">
        {list.length === 0 && <p className="shot-panel-empty">None yet. An extension sees every page the browser opens, so add only ones you trust.</p>}
        {list.map((x) => (
          <div key={x.id} className="shot-ext">
            <span className="shot-ext-name">{x.name} <em>{x.version}</em></span>
            {x.popup && <button className="cell-act" disabled={!canUse || !x.enabled || changed} onClick={() => onNewTab(x.popup!)}>Open</button>}
            <button className="cell-act" onClick={() => patch(x.id, { enabled: !x.enabled })}>{x.enabled ? "On" : "Off"}</button>
            <button className="cell-act" onClick={() => patch(x.id, { remove: true })}>Remove</button>
          </div>
        ))}
        <div className="shot-ext-add">
          <input
            value={source}
            placeholder="Web Store address or id"
            onChange={(e) => setSource(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") install(); }}
            aria-label="Chrome Web Store address or extension id"
          />
          <button className="cell-act" disabled={busy || !source.trim()} onClick={install}>Add</button>
          <button className="cell-act" disabled={busy} onClick={() => file.current?.click()}>From file</button>
          <input ref={file} type="file" accept=".zip,.crx" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ""; }} />
        </div>
        {note && <p className="shot-panel-empty">{note}</p>}
        {changed && (
          <p className="shot-panel-empty">
            Changes apply when the browser restarts.{" "}
            <button className="cell-act" onClick={() => void fetch("/api/extensions/restart", { method: "POST" }).then(() => setChanged(false))}>
              Restart browser
            </button>
          </p>
        )}
      </div>
    </div>
  );
}
