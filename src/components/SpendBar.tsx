import { memo } from "react";
import { money } from "./Billing";
import { spendView } from "../lib/spend";

/** What `/api/usage` answers with, as far as this bar is concerned. */
export type Usage = {
  month: { cost: number };
  budget: { monthly_usd: number | null };
};

/**
 * The month's money, and this session's share of it, over the composer.
 *
 * The bar is the ceiling set in Settings and the fill is what the month has
 * cost against it; the brighter section at the right-hand end is what this
 * conversation accounts for. Without a ceiling the bar is the month so far,
 * which still answers the useful half of the question -- how much of this is
 * the chat I am in. A tap opens Usage, where the ceiling is set.
 *
 * Small, and never in the way: it says a number you would otherwise leave the
 * chat to look up, and the thread above it loses 14px for that.
 */
export const SpendBar = memo(function SpendBar({
  spent,
  session,
  budget,
  onOpen,
}: {
  spent: number;
  session: number;
  budget: number | null;
  onOpen: () => void;
}) {
  const view = spendView({ spent, session, budget });
  if (!view.show) return null;

  const share = (n: number) => `${Math.min(100, Math.max(0, n * 100))}%`;
  // The session's slice is drawn as part of the fill, so it always sits at the
  // fill's right-hand end and can never stick out past the month it is in.
  const ofFill = view.used > 0 ? share(view.slice / view.used) : "0%";
  const tone = view.over ? "is-over" : view.near ? "is-near" : "";

  const said = view.cap !== null
    ? `${money(spent)} of ${money(view.cap)} this month`
    : `${money(spent)} this month`;
  const mine = session > 0 ? ` · ${money(session)} this session` : "";

  return (
    <button
      type="button"
      className={`spend ${tone}`.trim()}
      onClick={onOpen}
      aria-label={`${said}${mine}. Open Usage.`}
      title={`${said}${mine}${view.over ? " — over the ceiling you set" : view.near ? " — close to the ceiling you set" : ""}. Open Usage.`}
    >
      <span className="spend-track" aria-hidden="true">
        <i
          className={`spend-used ${view.used > 0 ? "is-any" : ""}`.trim()}
          style={{ width: share(view.used) }}
        >
          <i
            className={`spend-mine ${view.slice > 0 ? "is-any" : ""}`.trim()}
            style={{ width: ofFill }}
          />
        </i>
      </span>
      <span className="spend-text">
        {said}
        {session > 0 && <> · {money(session)} <span className="spend-words">this session</span></>}
      </span>
    </button>
  );
});
