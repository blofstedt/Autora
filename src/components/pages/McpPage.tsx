import { useCallback, useEffect, useState } from "react";
import { IconChevron, IconPlug, IconPlus, IconRotateCcw, IconTrash } from "../Icons";

type Server = {
  id: string; name: string; transport: "stdio" | "http";
  command?: string; args?: string[]; env?: Record<string, string>;
  url?: string; headers?: Record<string, string>; enabled: boolean;
  status: "off" | "connecting" | "connected" | "error"; error: string | null;
  tools: { name: string; description: string }[]; version: string | null;
};
type CatalogEntry = { name: string; transport: "stdio"; command: string; args: string[]; note: string };

type Draft = {
  id?: string; name: string; transport: "stdio" | "http";
  command: string; args: string; env: string; url: string; headers: string;
};
const blank: Draft = { name: "", transport: "stdio", command: "", args: "", env: "", url: "", headers: "" };

/** "KEY=value" lines (or "Key: value" for headers) to a record and back. */
const toRecord = (text: string, sep: "=" | ":") => {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf(sep);
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
};
const fromRecord = (r: Record<string, string> | undefined, sep: "=" | ":") =>
  Object.entries(r ?? {}).map(([k, v]) => `${k}${sep === ":" ? ": " : "="}${v}`).join("\n");

/** Arguments one per line, so a path with spaces needs no quoting rules. */
const toDraft = (s: Server): Draft => ({
  id: s.id, name: s.name, transport: s.transport, command: s.command ?? "",
  args: (s.args ?? []).join("\n"), env: fromRecord(s.env, "="), url: s.url ?? "",
  headers: fromRecord(s.headers, ":"),
});

/**
 * MCP servers: connect other programs' tools to the agent. A server's tools
 * appear to the agent as mcp__<server>__<tool> from its next step.
 */
export function McpPage() {
  const [servers, setServers] = useState<Server[] | null>(null);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const adopt = (data: any) => { setServers(data.servers); setCatalog(data.catalog ?? []); };
  const load = useCallback(() => {
    fetch("/api/mcp").then((r) => r.json()).then(adopt).catch(() => setError("Could not load MCP servers."));
  }, []);
  useEffect(() => {
    load();
    const t = window.setInterval(load, 5000);
    return () => window.clearInterval(t);
  }, [load]);

  const call = async (key: string, url: string, method: string, body?: unknown) => {
    setBusy(key); setError(null);
    try {
      const res = await fetch(url, {
        method, headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "That did not work."); return false; }
      adopt(data);
      return true;
    } catch {
      setError("Could not reach the server."); return false;
    } finally { setBusy(null); }
  };

  const submit = async () => {
    if (!draft) return;
    const body = {
      name: draft.name, transport: draft.transport,
      command: draft.command, args: draft.args.split("\n").map((a) => a.trim()).filter(Boolean),
      env: toRecord(draft.env, "="), url: draft.url, headers: toRecord(draft.headers, ":"),
      enabled: true,
    };
    const ok = draft.id
      ? await call("form", `/api/mcp/${draft.id}`, "PATCH", body)
      : await call("form", "/api/mcp", "POST", body);
    if (ok) setDraft(null);
  };

  return (
    <div className="page-scroll">
      <div className="page-inner">
        <div className="page-toolbar">
          <p className="jf-hint page-lede">
            Model Context Protocol servers give the agent more tools. Autora starts
            a local one from a command, or connects to one at a URL; its tools are
            offered to the agent from its next step.
          </p>
          {!draft && (
            <button className="btn primary" onClick={() => setDraft({ ...blank })}>
              <IconPlus size={14} /> Add server
            </button>
          )}
        </div>
        {error && <p className="set-warn">{error}</p>}

        {draft && (
          <section className="set-card mcp-form">
            <h3>{draft.id ? `Edit ${draft.name}` : "Add a server"}</h3>
            {!draft.id && catalog.length > 0 && (
              <div className="mcp-catalog">
                {catalog.map((c) => (
                  <button key={c.name} className="mcp-preset" title={c.note}
                          onClick={() => setDraft({ ...blank, name: c.name, command: c.command, args: c.args.join("\n") })}>
                    <b>{c.name}</b><span>{c.note}</span>
                  </button>
                ))}
              </div>
            )}
            <label className="jf-row"><span>Name</span>
              <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="github" />
            </label>
            <div className="seg" role="radiogroup" aria-label="Transport">
              {(["stdio", "http"] as const).map((t) => (
                <button key={t} className={draft.transport === t ? "on" : ""} onClick={() => setDraft({ ...draft, transport: t })}>
                  {t === "stdio" ? "Command (stdio)" : "URL (HTTP)"}
                </button>
              ))}
            </div>
            {draft.transport === "stdio" ? (
              <>
                <label className="jf-row"><span>Command</span>
                  <input className="jf-cron" value={draft.command} onChange={(e) => setDraft({ ...draft, command: e.target.value })} placeholder="npx" />
                </label>
                <label className="jf-row"><span>Arguments, one per line</span>
                  <textarea className="jf-cron" rows={3} value={draft.args} onChange={(e) => setDraft({ ...draft, args: e.target.value })} placeholder={"-y\n@modelcontextprotocol/server-filesystem\n/home/me/projects"} />
                </label>
                <label className="jf-row"><span>Environment, KEY=value per line</span>
                  <textarea className="jf-cron" rows={2} value={draft.env} onChange={(e) => setDraft({ ...draft, env: e.target.value })} placeholder="GITHUB_TOKEN=..." />
                </label>
              </>
            ) : (
              <>
                <label className="jf-row"><span>URL</span>
                  <input className="jf-cron" value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} placeholder="https://example.com/mcp" />
                </label>
                <label className="jf-row"><span>Headers, Name: value per line</span>
                  <textarea className="jf-cron" rows={2} value={draft.headers} onChange={(e) => setDraft({ ...draft, headers: e.target.value })} placeholder="Authorization: Bearer ..." />
                </label>
              </>
            )}
            <p className="jf-hint">Secret values are stored in the settings file and shown masked here; leave a masked value as it is to keep it.</p>
            <div className="jf-actions">
              <button className="btn ghost" onClick={() => setDraft(null)}>Cancel</button>
              <button className="btn primary" disabled={busy === "form" || !draft.name.trim()} onClick={() => void submit()}>
                {busy === "form" ? "Connecting…" : draft.id ? "Save and reconnect" : "Add and connect"}
              </button>
            </div>
          </section>
        )}

        {servers && servers.length === 0 && !draft && (
          <div className="empty page-empty">
            <span className="empty-ring"><IconPlug size={22} /></span>
            <h3>No MCP servers</h3>
            <p>Add one to give the agent new tools — a filesystem, a database, GitHub, anything with an MCP server.</p>
          </div>
        )}

        {(servers ?? []).map((s) => (
          <section key={s.id} className={`set-card mcp-server is-${s.status}`}>
            <div className="tool-head">
              <span className="tool-icon"><IconPlug size={14} /></span>
              <b>{s.name}</b>
              <span className={`tool-state ${s.status === "connected" ? "ok" : s.status === "error" ? "warn" : ""}`}>
                {s.status === "connected" ? `${s.tools.length} tool${s.tools.length === 1 ? "" : "s"}` : s.status}
              </span>
              <div className="spacer" />
              <button className="btn icon ghost" title="Reconnect" aria-label="Reconnect" disabled={busy === s.id}
                      onClick={() => void call(s.id, `/api/mcp/${s.id}/reconnect`, "POST")}>
                <IconRotateCcw size={14} />
              </button>
              <button className="btn ghost" onClick={() => setDraft(toDraft(s))}>Edit</button>
              <button className="btn icon ghost" title="Remove" aria-label="Remove"
                      onClick={() => void call(s.id, `/api/mcp/${s.id}`, "DELETE")}>
                <IconTrash size={14} />
              </button>
              <button
                className={`job-switch ${s.enabled ? "on" : ""}`}
                role="switch" aria-checked={s.enabled} aria-label={`${s.name}: ${s.enabled ? "on" : "off"}`}
                disabled={busy === s.id}
                onClick={() => void call(s.id, `/api/mcp/${s.id}`, "PATCH", { enabled: !s.enabled })}
              >
                <span className="job-knob" />
              </button>
            </div>
            <p className="mcp-where">
              <code>{s.transport === "stdio" ? [s.command, ...(s.args ?? [])].join(" ") : s.url}</code>
              {s.version ? <span> · v{s.version}</span> : null}
            </p>
            {s.status === "error" && s.error && <p className="set-warn">{s.error}</p>}
            {s.tools.length > 0 && (
              <>
                <button className={`shot-acts-toggle ${open[s.id] ? "on" : ""}`} onClick={() => setOpen((o) => ({ ...o, [s.id]: !o[s.id] }))}>
                  <IconChevron size={11} /> {open[s.id] ? "Hide tools" : "Show tools"}
                </button>
                {open[s.id] && (
                  <ul className="mcp-tools">
                    {s.tools.map((t) => (
                      <li key={t.name}><code>{t.name}</code><span>{t.description}</span></li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
