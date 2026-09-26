import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Usage } from "./Billing";
import { money } from "./Billing";
import { spendView } from "../lib/spend";
import { IconX } from "./Icons";

/**
 * What the bar over the composer has to say, without leaving the chat.
 *
 * A tap on the spend bar used to navigate to Usage, which is a page of
 * charts, providers, recent turns and a ceiling to set -- and it took the
 * conversation off the screen to answer a question that is nearly always the
 * same one: how much of what I allowed has gone. So the bar now opens this:
 * the month against the ceiling, today, all time, and this session, over the
 * chat and closed again with a tap or Escape. Usage itself is one button
 * further on, for the reader who does want the breakdown.
 *
 * The numbers are re-read when it opens rather than taken from the bar, which
 * is a snapshot from the last turn: a modal that quotes a stale total while
 * claiming to be the detail view is worse than the bar it replaced.
 */
type Spend = Pick<Usage, "currency" | "since" | "lifetime" | "today" | "month" | "budget">;

export function SpendPeek({
  session,
  onUsage,
  onClose,
}: {
  /** This conversation's share, which the bar already knows. */
  session: number;
  onUsage: () => void;
  onClose: () => void;
}) {
  const [usage, setUsage] = useState<Spend | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/usage")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: Spend) => {
        if (alive) setUsage(d);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const cap = usage?.budget.monthly_usd ?? null;
  const spent = usage?.month.cost ?? 0;
  const view = spendView({ spent, session, budget: cap });
  const left = cap === null ? null : Math.max(0, cap - spent);

  const row = (label: string, value: string, sub?: string) => (
    <div className="peek-row">
      <span className="peek-row-label">{label}</span>
      <b className="peek-row-value">{value}</b>
      {sub && <span className="peek-row-sub">{sub}</span>}
    </div>
  );

  return createPortal(
    <div
      className="scrim"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
      role="presentation"
    >
      <div
        className="modal peek spend-peek"
        role="dialog"
        aria-modal="true"
        aria-label="What this has cost"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-top">
          <b className="peek-title">What this has cost</b>
          <div className="spacer" />
          <button className="btn icon ghost" onClick={onClose} aria-label="Close">
            <IconX size={14} />
          </button>
        </div>

        <div className="modal-body">
          {failed && <p className="jf-hint">Could not read the ledger just now.</p>}
          {!failed && !usage && <p className="jf-hint">Adding it up…</p>}
          {usage && (
            <>
              <div className="spend-peek-bar">
                <span className="spend-track" aria-hidden="true">
                  <i
                    className={`spend-used ${view.used > 0 ? "is-any" : ""}`.trim()}
                    style={{ width: `${Math.min(100, Math.max(0, view.used * 100))}%` }}
                  >
                    <i
                      className={`spend-mine ${view.slice > 0 ? "is-any" : ""}`.trim()}
                      style={{
                        width: view.used > 0 ? `${Math.min(100, Math.max(0, (view.slice / view.used) * 100))}%` : "0%",
                      }}
                    />
                  </i>
                </span>
                <p className="spend-peek-said">
                  {cap === null
                    ? `${money(spent)} this month, with no ceiling set.`
                    : view.over
                      ? `${money(spent)} this month — ${money(spent - cap)} past the ${money(cap)} ceiling you set.`
                      : `${money(spent)} of the ${money(cap)} ceiling you set — ${money(left ?? 0)} left.`}
                </p>
              </div>

              {row("This month", money(usage.month.cost), `${usage.month.turns} turns`)}
              {row("Today", money(usage.today.cost), `${usage.today.turns} turns`)}
              {row(
                "All time",
                money(usage.lifetime.cost),
                usage.since ? `since ${new Date(usage.since * 1000).toLocaleDateString()}` : undefined,
              )}
              {session > 0 && row("This session", money(session))}
            </>
          )}
        </div>

        <div className="modal-foot">
          <button
            className="setup-more"
            onClick={() => {
              onClose();
              onUsage();
            }}
          >
            Usage, ceiling and all
          </button>
          <button className="setup-more" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
