import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BUCKETS, KIND_COLOR, announceChange, createRecord, deleteRecord, edgesFor,
  fetchKnowledge, onKnowledgeChange, patchRecord,
  type Bucket, type Knowledge, type MemoryRecord,
} from "../../lib/memory";
import type { MemoryMark } from "../../lib/derive";
import { KnowledgeWeb } from "../KnowledgeWeb";
import { IconBrain, IconPlus, IconTrash } from "../Icons";

type Draft = { title: string; body: string; tags: string; kind: Bucket };

const toDraft = (r: MemoryRecord): Draft => ({
  title: r.title, body: r.body, tags: r.tags.join(", "), kind: r.kind,
});
const splitTags = (text: string) => text.split(",").map((t) => t.trim()).filter(Boolean);
const bucketLabel = (kind: Bucket) => BUCKETS.find((b) => b.kind === kind)?.label ?? kind;

/**
 * The Mind: everything the agent keeps, sorted into four buckets you can
 * read, edit and reorganise. The graph of it lives only here, one tap away
 * behind the Map switch.
 */
export function MindPage({
  jump,
  showMap = true,
  recent = [],
}: {
  /** The bucket to show; a new object moves there even if it is the same one. */
  jump?: { kind: Bucket };
  /** Offer the graph here. It has no other home. */
  showMap?: boolean;
  recent?: MemoryMark[];
}) {
  const [data, setData] = useState<Knowledge | null>(null);
  const [bucket, setBucket] = useState<Bucket>(jump?.kind ?? "preference");
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [adding, setAdding] = useState<Draft | null>(null);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"buckets" | "map">("buckets");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetchKnowledge().then(setData).catch(() => setData(null));
  }, []);
  useEffect(load, [load]);
  useEffect(() => onKnowledgeChange(load), [load]);
  useEffect(() => {
    if (jump) { setBucket(jump.kind); setQuery(""); }
  }, [jump]);

  const records = useMemo(() => data?.records ?? [], [data]);
  const byId = useMemo(() => new Map(records.map((r) => [r.id, r])), [records]);
  const edges = useMemo(() => (data ? edgesFor(data) : []), [data]);

  /** Who each record is connected to, and why. */
  const related = useMemo(() => {
    const out = new Map<string, { id: string; rel: string }[]>();
    const add = (a: string, b: string, rel: string) => {
      const list = out.get(a) ?? [];
      if (!list.some((x) => x.id === b)) list.push({ id: b, rel });
      out.set(a, list);
    };
    for (const l of data?.links ?? []) {
      add(l.src, l.dst, l.rel.replace(/_/g, " "));
      add(l.dst, l.src, l.rel.replace(/_/g, " "));
    }
    for (const e of edges) {
      if (e.strong) continue;
      add(e.a, e.b, "shared tag");
      add(e.b, e.a, "shared tag");
    }
    return out;
  }, [data, edges]);

  const counts = useMemo(() => {
    const c = { preference: 0, procedure: 0, fact: 0, skill: 0 } as Record<Bucket, number>;
    for (const r of records) c[r.kind]++;
    return c;
  }, [records]);

  /** How many connections run between each pair of buckets. */
  const bridges = useMemo(() => {
    const tally = new Map<string, number>();
    for (const e of edges) {
      const a = byId.get(e.a)?.kind, b = byId.get(e.b)?.kind;
      if (!a || !b) continue;
      const [x, y] = BUCKETS.findIndex((k) => k.kind === a) <= BUCKETS.findIndex((k) => k.kind === b)
        ? [a, b] : [b, a];
      const key = `${x}|${y}`;
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
    return [...tally.entries()]
      .map(([key, n]) => { const [a, b] = key.split("|") as [Bucket, Bucket]; return { a, b, n }; })
      .sort((p, q) => q.n - p.n);
  }, [edges, byId]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return records
      .filter((r) => (q ? true : r.kind === bucket))
      .filter((r) => !q || `${r.title} ${r.body} ${r.tags.join(" ")}`.toLowerCase().includes(q))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated - a.updated);
  }, [records, bucket, query]);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      announceChange();
      load();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const openRecord = (id: string | null) => {
    const r = id ? byId.get(id) : null;
    setOpen(r ? r.id : null);
    setDraft(r ? toDraft(r) : null);
    if (r && !query) setBucket(r.kind);
  };

  const save = async (r: MemoryRecord) => {
    if (!draft || !draft.title.trim()) return;
    const ok = await run(() => patchRecord(r.id, {
      title: draft.title.trim(), body: draft.body, tags: splitTags(draft.tags), kind: draft.kind,
    }));
    if (ok) {
      if (draft.kind !== bucket && !query) setBucket(draft.kind);
      setOpen(null);
      setDraft(null);
    }
  };

  const add = async () => {
    if (!adding || !adding.title.trim()) return;
    const ok = await run(() => createRecord({
      kind: adding.kind, title: adding.title.trim(), body: adding.body, tags: splitTags(adding.tags),
    }));
    if (ok) setAdding(null);
  };

  const mapOn = showMap && view === "map";

  return (
    <div className="mind-page">
      {showMap && (
        <div className="mind-switch">
          <div className="seg" role="tablist" aria-label="View">
            <button role="tab" aria-selected={view === "buckets"} className={view === "buckets" ? "on" : ""}
                    onClick={() => setView("buckets")}>Buckets</button>
            <button role="tab" aria-selected={view === "map"} className={view === "map" ? "on" : ""}
                    onClick={() => setView("map")}>Map</button>
          </div>
        </div>
      )}

      {mapOn ? (
        <KnowledgeWeb embedded recent={recent} />
      ) : (
      <div className="page-scroll">
        <div className="page-inner">
          <div className="page-toolbar">
            <p className="jf-hint page-lede">
              What the agent keeps between sessions, sorted into four buckets. Edit
              anything here, or move it to the bucket it belongs in.
            </p>
            <input
              className="page-search"
              placeholder="Search the mind…"
              aria-label="Search the mind"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          {data && !data.enabled && <p className="set-warn">Memory is off on this server.</p>}
          {error && <p className="set-warn">{error}</p>}

          <div className="mind-buckets" role="tablist" aria-label="Buckets">
            {BUCKETS.map((b) => (
              <button
                key={b.kind}
                role="tab"
                aria-selected={!query && bucket === b.kind}
                className={`mind-bucket ${!query && bucket === b.kind ? "on" : ""}`}
                style={{ "--chip": KIND_COLOR[b.kind] } as React.CSSProperties}
                onClick={() => { setQuery(""); setBucket(b.kind); setAdding(null); }}
              >
                <span className="mind-bucket-top">
                  <i />
                  <b>{b.label}</b>
                </span>
                <span className="mind-bucket-count">{counts[b.kind]}</span>
                <span className="mind-bucket-blurb">{b.blurb}</span>
              </button>
            ))}
          </div>

          {bridges.length > 0 && (
            <section className="mind-bridges" aria-label="How the buckets connect">
              <span className="mind-bridges-label">Connections</span>
              {bridges.map(({ a, b, n }) => (
                <span key={`${a}|${b}`} className="mind-bridge">
                  <i style={{ background: KIND_COLOR[a] }} />
                  {a === b ? `within ${bucketLabel(a)}` : (
                    <>{bucketLabel(a)} <span aria-hidden="true">↔</span> <i style={{ background: KIND_COLOR[b] }} />{bucketLabel(b)}</>
                  )}
                  <em>{n}</em>
                </span>
              ))}
            </section>
          )}

          <div className="mind-list-head">
            <h3>{query ? `Matches for “${query.trim()}”` : bucketLabel(bucket)}</h3>
            <span className="web-count">{shown.length}</span>
            <div className="spacer" />
            {!adding && (
              <button
                className="btn primary"
                onClick={() => { setAdding({ title: "", body: "", tags: "", kind: bucket }); openRecord(null); }}
              >
                <IconPlus size={14} /> Add
              </button>
            )}
          </div>

          {adding && (
            <section className="set-card mind-edit">
              <RecordFields draft={adding} onChange={setAdding} />
              <div className="jf-actions">
                <button className="btn ghost" onClick={() => setAdding(null)}>Cancel</button>
                <button className="btn primary" disabled={busy || !adding.title.trim()} onClick={() => void add()}>
                  Add to {bucketLabel(adding.kind)}
                </button>
              </div>
            </section>
          )}

          {data && shown.length === 0 && !adding && (
            <div className="empty page-empty">
              <span className="empty-ring"><IconBrain size={22} /></span>
              <h3>{query ? "Nothing matches" : `No ${bucketLabel(bucket).toLowerCase()} yet`}</h3>
              <p>{query ? "Try another word." : "Add one, or move a record here from another bucket."}</p>
            </div>
          )}

          <div className="mind-list">
            {shown.map((r) => {
              const isOpen = open === r.id && draft;
              const links = related.get(r.id) ?? [];
              return (
                <section
                  key={r.id}
                  className={`set-card mind-item ${isOpen ? "is-open" : ""}`}
                  style={{ "--chip": KIND_COLOR[r.kind] } as React.CSSProperties}
                >
                  {isOpen ? (
                    <>
                      <RecordFields draft={draft} onChange={setDraft} />
                      <div className="jf-actions mind-edit-actions">
                        <button
                          className={`btn ${r.pinned ? "primary" : "ghost"}`}
                          onClick={() => void run(() => patchRecord(r.id, { pinned: !r.pinned }))}
                          title="A pinned record is loaded into every session"
                        >
                          {r.pinned ? "Pinned" : "Pin"}
                        </button>
                        <button
                          className="btn icon ghost"
                          title="Delete"
                          aria-label="Delete"
                          onClick={() => void run(async () => { await deleteRecord(r.id); setOpen(null); setDraft(null); })}
                        >
                          <IconTrash size={14} />
                        </button>
                        <div className="spacer" />
                        <button className="btn ghost" onClick={() => openRecord(null)}>Cancel</button>
                        <button className="btn primary" disabled={busy || !draft.title.trim()} onClick={() => void save(r)}>
                          Save
                        </button>
                      </div>
                    </>
                  ) : (
                    <button className="mind-item-main" onClick={() => openRecord(r.id)}>
                      <span className="mind-item-title">
                        <i />
                        <b>{r.title}</b>
                        {r.pinned && <span className="mind-flag">pinned</span>}
                        {r.status === "provisional" && <span className="mind-flag">provisional</span>}
                        {query && <span className="mind-flag">{bucketLabel(r.kind)}</span>}
                      </span>
                      {r.body && <span className="mind-item-body">{r.body}</span>}
                      {r.tags.length > 0 && (
                        <span className="mind-tags">{r.tags.map((t) => <em key={t}>{t}</em>)}</span>
                      )}
                    </button>
                  )}

                  {links.length > 0 && (
                    <div className="mind-related">
                      <span>Related</span>
                      {links.map(({ id, rel }) => {
                        const other = byId.get(id);
                        if (!other) return null;
                        return (
                          <button key={id} className="mind-rel" onClick={() => openRecord(id)} title={`${rel} · ${bucketLabel(other.kind)}`}>
                            <i style={{ background: KIND_COLOR[other.kind] }} />
                            {other.title}
                            <em>{rel}</em>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        </div>
      </div>
      )}
    </div>
  );
}

function RecordFields({ draft, onChange }: { draft: Draft; onChange: (d: Draft) => void }) {
  return (
    <>
      <div className="mind-kinds" role="radiogroup" aria-label="Bucket">
        {BUCKETS.map((b) => (
          <button
            key={b.kind}
            role="radio"
            aria-checked={draft.kind === b.kind}
            className={`kchip ${draft.kind === b.kind ? "on" : ""}`}
            style={{ "--chip": KIND_COLOR[b.kind] } as React.CSSProperties}
            onClick={() => onChange({ ...draft, kind: b.kind })}
          >
            <i /> {b.label}
          </button>
        ))}
      </div>
      <label className="jf-row"><span>Title</span>
        <input value={draft.title} onChange={(e) => onChange({ ...draft, title: e.target.value })} />
      </label>
      <label className="jf-row"><span>Details</span>
        <textarea rows={4} value={draft.body} onChange={(e) => onChange({ ...draft, body: e.target.value })} />
      </label>
      <label className="jf-row"><span>Tags, comma-separated</span>
        <input value={draft.tags} onChange={(e) => onChange({ ...draft, tags: e.target.value })} />
      </label>
    </>
  );
}
