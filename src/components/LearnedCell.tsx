import { useEffect, useState } from "react";
import type { LearnedItem } from "../lib/derive";
import { BUCKETS, KIND_COLOR, type Bucket } from "../lib/memory";

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
 * existing memory, keeping it retires the old one.
 */
export function LearnedCell({
  items,
  changes,
  onOpen,
}: {
  items: LearnedItem[];
  changes: { id: string; title: string; change: string }[];
  onOpen?: () => void;
}) {
  const [fate, setFate] = useState<Record<string, Fate>>({});

  // The event is history; what became of each item since lives on the server.
  useEffect(() => {
    let alive = true;
    for (const item of items) {
      if (item.status === "confirmed") continue;
      fetch(`/api/memory/${encodeURIComponent(item.id)}`)
        .then((r) => (r.status === 404 ? null : r.ok ? r.json() : undefined))
        .then((record) => {
          if (!alive || record === undefined) return;
          const now: Fate = record === null ? "discarded" : record.status === "confirmed" ? "kept" : "open";
          setFate((prev) => ({ ...prev, [item.id]: now }));
        })
        .catch(() => undefined);
    }
    return () => { alive = false; };
  }, [items]);

  const decide = async (id: string, keep: boolean) => {
    setFate((prev) => ({ ...prev, [id]: "busy" }));
    const res = await fetch(`/api/memory/${encodeURIComponent(id)}${keep ? "/confirm" : ""}`, {
      method: keep ? "POST" : "DELETE",
    }).catch(() => null);
    setFate((prev) => ({ ...prev, [id]: res?.ok ? (keep ? "kept" : "discarded") : "open" }));
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
            <span
              className="mem-chip"
              style={isBucket(item.kind) ? ({ "--chip": KIND_COLOR[item.kind] } as React.CSSProperties) : undefined}
            >
              <em>{item.kind}</em>
              {item.title}
            </span>
            <span className="learned-note">
              {item.action === "proposed" || item.revises ? "a correction to an existing memory" :
                item.action === "reinforced" ? "already known; counted as having worked" :
                  item.action === "merged" ? "folded into a similar unconfirmed memory" : "new"}
            </span>
            {state === "open" || state === "busy" ? (
              <span className="learned-actions">
                <button type="button" className="btn tiny" disabled={state === "busy"} onClick={() => void decide(item.id, true)}>Keep</button>
                <button type="button" className="btn tiny ghost" disabled={state === "busy"} onClick={() => void decide(item.id, false)}>Discard</button>
              </span>
            ) : (
              <span className="learned-fate">{state === "kept" ? "kept" : "discarded"}</span>
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
    </div>
  );
}
