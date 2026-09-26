import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { MemoryItem, MemoryTouch } from "../lib/derive";
import { BUCKETS, KIND_COLOR, type Bucket } from "../lib/memory";
import { IconChevron, IconX } from "./Icons";

const isBucket = (kind: string | null | undefined): kind is Bucket =>
  !!kind && BUCKETS.some((b) => b.kind === kind);

/** The bucket's own name, for the modal: "procedures" is "Procedure". */
const bucketLabel = (kind: string | null | undefined): string | null => {
  const bucket = isBucket(kind) ? BUCKETS.find((b) => b.kind === kind) : undefined;
  if (bucket) return bucket.label.replace(/s$/, "");
  return kind ?? null;
};

const when = (ts: number | undefined): string => {
  if (!ts) return "";
  const seconds = Math.round(Date.now() / 1000 - ts);
  if (seconds < 90) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d ago`;
  return new Date(ts * 1000).toLocaleDateString();
};

/** A record, as the graph gives it back (see GET /api/memory/:id). */
type MemoryDetail = {
  title?: string;
  body?: string;
  kind?: string;
  tags?: string[];
  status?: string;
  pinned?: boolean;
  uses?: number;
  updated?: number;
};

/**
 * One memory, opened: the name, what kind of thing it is, and the text itself.
 *
 * The chips in the thread name a memory; this is the memory. It is fetched by
 * id rather than carried in the event, so it is what is stored now -- and a
 * record that has since been forgotten says so instead of showing stale text.
 */
function MemoryPeek({
  item,
  onClose,
  onOpenMind,
}: {
  item: MemoryItem;
  onClose: () => void;
  onOpenMind?: () => void;
}) {
  const [detail, setDetail] = useState<MemoryDetail | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "gone" | "error">("loading");

  useEffect(() => {
    let alive = true;
    setDetail(null);
    setState("loading");
    fetch(`/api/memory/${encodeURIComponent(item.id)}`)
      .then(async (res) => {
        if (!alive) return;
        if (res.status === 404) return setState("gone");
        if (!res.ok) return setState("error");
        setDetail((await res.json()) as MemoryDetail);
        setState("ok");
      })
      .catch(() => {
        if (alive) setState("error");
      });
    return () => {
      alive = false;
    };
  }, [item.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const kind = detail?.kind ?? item.kind;
  const known = isBucket(kind);
  const title = detail?.title ?? item.title;

  return createPortal(
    <div className="scrim" onClick={onClose} role="presentation">
      <div
        className="modal peek"
        role="dialog"
        aria-modal="true"
        aria-label="Memory"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-top">
          {known && (
            <span
              className="mem-chip"
              style={{ "--chip": KIND_COLOR[kind] } as React.CSSProperties}
            >
              <em>{bucketLabel(kind)}</em>
            </span>
          )}
          <b className="peek-title">{title}</b>
          <div className="spacer" />
          <button className="btn icon ghost" onClick={onClose} aria-label="Close memory">
            <IconX size={14} />
          </button>
        </div>

        <div className="modal-body">
          {state === "loading" && <p className="jf-hint">Opening…</p>}
          {state === "gone" && (
            <p className="jf-hint">
              This one is no longer in the graph — it was forgotten, or replaced by a
              newer memory.
            </p>
          )}
          {state === "error" && (
            <p className="jf-hint">Could not read this one from the graph.</p>
          )}
          {state === "ok" && (
            <>
              <p className="peek-body">{detail?.body?.trim() || "Stored with no text."}</p>
              {item.reason && (
                <p className="peek-why">
                  {item.action && item.action !== "added"
                    ? `${item.action} · ${item.reason}`
                    : item.reason}
                </p>
              )}
              <div className="peek-meta">
                {detail?.status === "provisional" && <span>unconfirmed</span>}
                {detail?.pinned && <span>pinned</span>}
                {detail?.uses ? <span>used {detail.uses}×</span> : null}
                {detail?.updated ? <span>updated {when(detail.updated)}</span> : null}
                {detail?.tags?.map((tag) => (
                  <span key={tag} className="peek-tag">
                    {tag}
                  </span>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="modal-foot">
          <button className="setup-more" onClick={onClose}>
            Close
          </button>
          {onOpenMind && (
            <button
              className="setup-more"
              onClick={() => {
                onClose();
                onOpenMind();
              }}
            >
              Open the Mind
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * The agent reaching into its memory, said where it happened.
 *
 * This replaced the always-on graph beside the chat: a map of everything the
 * agent knows, lighting up somewhere in the corner, told you less than one
 * line in the conversation saying which memories this turn actually used. It
 * sits with the reasoning of the reply it informed, or on its own line when
 * no reply has started yet. The
 * dot pulses a few times as it lands and then holds still, like the mark on
 * a finished reply.
 *
 * The line is the whole of it until it is asked to say more: a recall can
 * name half a dozen memories, and the titles of all of them running down the
 * thread drown the conversation they are there to explain. So it arrives
 * folded -- "recalled 4 memories" and a chevron -- and opens on a tap. Each
 * title then opens on its own, in a modal, with what the memory is and what
 * it says; closing that leaves the thread as it was. The Mind page, where the
 * whole graph lives, is one tap further on.
 */
export function MemoryCell({
  cell,
  onOpen,
  inline = false,
}: {
  cell: MemoryTouch;
  onOpen?: () => void;
  /** Inside a reply, under its reasoning, rather than a line of its own. */
  inline?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [peeking, setPeeking] = useState<MemoryItem | null>(null);
  const verb = cell.action === "written" ? "remembered" : "recalled";

  // A recall can name the same memory twice (a merged pulse re-touches it):
  // the list is the distinct ones.
  const items = cell.items.filter(
    (item, index) => cell.items.findIndex((other) => other.id === item.id) === index,
  );
  const count = items.length;

  return (
    <div className={`mem-pulse is-${cell.action} ${inline ? "is-inline" : ""} ${open ? "is-open" : ""}`.trim()}>
      <button
        type="button"
        className="mem-pulse-head"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        title={open ? "Fold the memories away" : "Show which memories this used"}
      >
        {/* Keyed on seq so a merged recall pulses again when it grows. */}
        <span className="mem-pulse-dot" key={cell.seq} aria-hidden="true" />
        <span className="mem-pulse-verb">{verb}</span>
        <span className="mem-pulse-count">
          {count} {count === 1 ? "memory" : "memories"}
        </span>
        <IconChevron size={11} className="mem-pulse-caret" />
      </button>

      {open &&
        items.map((item) => {
          const known = isBucket(item.kind);
          return (
            <button
              type="button"
              key={item.id}
              className={`mem-chip is-tap ${item.action === "forgotten" ? "is-gone" : ""}`.trim()}
              style={known ? ({ "--chip": KIND_COLOR[item.kind as Bucket] } as React.CSSProperties) : undefined}
              // Why this one: what it matched, or that it is pinned.
              title={item.reason ?? "Open this memory"}
              onClick={() => setPeeking(item)}
            >
              {known && <em>{item.kind}</em>}
              {item.title}
              {item.action && item.action !== "added" && <small>{item.action}</small>}
            </button>
          );
        })}

      {peeking && (
        <MemoryPeek item={peeking} onClose={() => setPeeking(null)} onOpenMind={onOpen} />
      )}
    </div>
  );
}
