import { useEffect, useRef, useState } from "react";
import type { LearnedItem } from "../lib/derive";
import { BUCKETS, KIND_COLOR, type Bucket } from "../lib/memory";
import { MemoryPeek } from "./MemoryCell";

type Fate = "open" | "kept" | "discarded" | "busy";

const isBucket = (kind: string): kind is Bucket => BUCKETS.some((b) => b.kind === kind);

const CHANGE_WORDS: Record<string, string> = {
  confirmed: "confirmed: it has now worked twice",
  promoted: "proven: worked often enough to be ranked first when relevant",
  dropped: "dropped: it turned out wrong",
  questioned: "turned out wrong or out of date -- worth a look in the Mind",
};

/**
 * What the agent took away from the turn that just ended.
 *
 * Each item is unconfirmed until kept here, or until it works again on its
 * own. Keep makes it known now; Discard deletes it. Where it rewrites an
 * existing memory, keeping it retires the old one. The title opens the memory
 * itself -- its whole text, what it replaces and its tags -- and the answer
 * can be given in there too.
 */
export function LearnedCell({
  items,
  changes,
  onOpen,
  showing = true,
}: {
  items: LearnedItem[];
  changes: { id: string; title: string; change: string }[];
  onOpen?: () => void;
  /** The conversation is on screen. An answer can be given somewhere else --
      the Mind page, another device -- so the rows look again when it is. */
  showing?: boolean;
}) {
  const [fate, setFate] = useState<Record<string, Fate>>({});
  const [peeking, setPeeking] = useState<LearnedItem | null>(null);
  /** The memory a rewrite would replace, fetched when one is opened. */
  const [old, setOld] = useState<{ id: string; title: string; body?: string } | null>(null);

  /* Which items are still unanswered, by id. The check below is keyed on that,
     not on the array: a thread re-renders on every event of every turn, and
     each new array used to cancel the check that was in flight -- so a row
     never learned what had become of it. Through a ref because it is only
     read when the key changes, not part of what the effect depends on. */
  const pending = useRef<string[]>([]);
  pending.current = items.filter((item) => item.status !== "confirmed").map((item) => item.id);
  const pendingKey = pending.current.join("|");

  // The event is history; what became of each item since lives on the server.
  useEffect(() => {
    if (!showing) return;
    let alive = true;
    for (const id of pending.current) {
      fetch(`/api/memory/${encodeURIComponent(id)}`)
        .then((r) => (r.status === 404 ? null : r.ok ? r.json() : undefined))
        .then((record) => {
          if (!alive || record === undefined) return;
          const now: Fate = record === null ? "discarded" : record.status === "confirmed" ? "kept" : "open";
          setFate((prev) => ({ ...prev, [id]: now }));
        })
        .catch(() => undefined);
    }
    return () => { alive = false; };
  }, [pendingKey, showing]);

  const decide = async (id: string, keep: boolean) => {
    setFate((prev) => ({ ...prev, [id]: "busy" }));
    const res = await fetch(`/api/memory/${encodeURIComponent(id)}${keep ? "/confirm" : ""}`, {
      method: keep ? "POST" : "DELETE",
    }).catch(() => null);
    const ok = !!res?.ok;
    setFate((prev) => ({ ...prev, [id]: ok ? (keep ? "kept" : "discarded") : "open" }));
    // The modal stays open on a failure; the row goes back to asking.
    if (!ok) throw new Error("Could not save it");
  };

  /** Open the memory itself, and for a rewrite the one it would replace. */
  const openItem = (item: LearnedItem) => {
    setPeeking(item);
    setOld(null);
    if (!item.revises) return;
    fetch(`/api/memory/${encodeURIComponent(item.revises)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((record) => {
        if (record) setOld({ id: item.revises!, title: record.title, body: record.body });
      })
      .catch(() => undefined);
  };

  return (
    <div className="learned">
      <button type="button" className="learned-head" onClick={onOpen} title="Open the Mind">
        <span className="mem-pulse-dot" aria-hidden="true" />
        learned from this
      </button>
      {items.map((item) => {
        const state = item.status === "confirmed" ? "kept" : fate[item.id] ?? "open";
        return (
          <div key={item.id} className={`learned-item is-${state}`}>
            <button
              type="button"
              className="learned-open"
              onClick={() => openItem(item)}
              title="Open this memory"
            >
              <span
                className="mem-chip"
                style={isBucket(item.kind) ? ({ "--chip": KIND_COLOR[item.kind] } as React.CSSProperties) : undefined}
              >
                <em>{item.kind}</em>
                {item.title}
              </span>
            </button>
            <span className="learned-note">
              {item.action === "proposed" || item.revises ? "a correction to an existing memory" :
                item.action === "reinforced" ? "already known; counted as having worked" :
                  item.action === "merged" ? "folded into a similar unconfirmed memory" : "new"}
            </span>
            {state === "discarded" ? (
              <span className="learned-fate">discarded</span>
            ) : (
              /* Remembered already; Discard is only there if it was wrong. */
              <span className="learned-actions">
                <button type="button" className="btn tiny ghost" disabled={state === "busy"} onClick={() => void decide(item.id, false).catch(() => undefined)}>Discard</button>
              </span>
            )}
          </div>
        );
      })}
      {changes.map((c) => (
        <div key={`${c.id}-${c.change}`} className="learned-item is-change">
          <span className="mem-chip">{c.title}</span>
          <span className="learned-note">{CHANGE_WORDS[c.change] ?? c.change}</span>
        </div>
      ))}

      {peeking && (
        <MemoryPeek
          item={{ id: peeking.id, title: peeking.title, kind: peeking.kind }}
          onClose={() => setPeeking(null)}
          onOpenMind={onOpen}
          onKeep={(id) => decide(id, true)}
          onDiscard={(id) => decide(id, false)}
          onAnswered={(id, answer) => setFate((prev) => ({ ...prev, [id]: answer === "kept" ? "kept" : "discarded" }))}
          replaces={old && peeking.revises === old.id ? old : null}
        />
      )}
    </div>
  );
}
