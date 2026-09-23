import { useState } from "react";
import type { JevDecision } from "../lib/derive";
import { IconChevron } from "./Icons";

/**
 * One line for a Jev Mode decision: what was decided, how fast, and how sure.
 *
 * Folded by default -- it is bookkeeping, not conversation -- and opens to
 * the confidence matrix: every field, the value it got, and a bar for how
 * sure the model was, against the threshold it had to clear.
 */
export function JevCell({ decision: d }: { decision: JevDecision }) {
  const [open, setOpen] = useState(false);
  const fast = d.mode === "jev";
  /* A model that cannot score is not Jev being slow: it is Jev not running,
     and the decision made the ordinary way. Said as such. */
  const unavailable = !fast && /cannot score|no model|paused/i.test(d.reason ?? "");
  const summary = fast
    ? `${d.fields.length} field${d.fields.length === 1 ? "" : "s"} in ${d.ms} ms · lowest ${
        (d.min ?? 0).toFixed(2)}`
    : `${unavailable ? "decided the normal way" : "not sure enough, decided the normal way"} — ${
        d.reason ?? "fell back"}`;

  return (
    <div className={`cell-line jev-line ${fast ? "is-fast" : "is-fallback"} ${open ? "is-open" : ""}`}>
      <button className="cell-line-top" onClick={() => setOpen(!open)} aria-expanded={open}>
        <IconChevron size={11} />
        <b>{fast ? "jev" : unavailable ? "jev unavailable" : "jev → normal"}</b>
        <span className="cell-line-text">{d.task} · {summary}</span>
      </button>
      {open && d.fields.length > 0 && (
        <div className="jev-matrix">
          {d.fields.map((f) => {
            const weak = f.confidence < d.threshold;
            return (
              <div className={`jev-row ${weak ? "is-weak" : ""}`} key={f.name}>
                <span className="jev-name" title={f.name}>{f.name}</span>
                <code className="jev-value">{JSON.stringify(f.value)}</code>
                <span className="jev-bar" aria-label={`confidence ${f.confidence.toFixed(2)}`}>
                  <i style={{ width: `${Math.round(f.confidence * 100)}%` }} />
                  <em style={{ left: `${Math.round(d.threshold * 100)}%` }} />
                </span>
                <span className="jev-conf">{f.confidence.toFixed(2)}</span>
              </div>
            );
          })}
          <p className="jev-foot">
            threshold {d.threshold.toFixed(2)}
            {d.model ? ` · ${d.model}` : ""}
            {d.cachedTokens ? ` · ${d.cachedTokens} prompt tokens from cache` : ""}
          </p>
        </div>
      )}
    </div>
  );
}
