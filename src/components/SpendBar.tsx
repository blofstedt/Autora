import { memo, useState } from "react";
import { money } from "./Billing";
import { creditTotal, spendView } from "../lib/spend";
import { SpendPeek } from "./SpendPeek";

/** What `/api/usage` answers with, as far as this bar is concerned. */
export type Usage = {
  month: { cost: number };
  lifetime: { cost: number };
  budget: { monthly_usd: number | null };
  /** What one vendor's own balance says, when it can be read at all. */
  real?: {
    /** Which vendor's money this is. */
    provider: string;
    label: string;
    topped_up_usd: number;
    balance_usd: number;
    lifetime_usd: number;
    /** False when this is one vendor's figure beside a ledger holding other
        vendors' turns -- and then the bar must not draw it as its own. */
    headline: boolean;
  } | null;
};

/**
 * The money, in the three spans it is actually thought about, over the composer.
 *
 * The fill is the money consumed of what was paid in at the vendor -- the
 * figure the account page itself shows -- and the brighter section at the
 * right-hand end is what this conversation accounts for. The words beside it
 * carry the same three numbers: consumed of credit, the month's share, and
 * this session's. Without a balance to read the bar is what it always was, the
 * month against the ceiling set in Settings, or the month alone.
 *
 * A tap opens a card of the figures over the chat -- see SpendPeek -- with
 * Usage, ceiling and all, one button further on.
 *
 * Small, and never in the way: it says a number you would otherwise leave the
 * chat to look up, and the thread above it loses 14px for that.
 */
export const SpendBar = memo(function SpendBar({
  spent,
  session,
  budget,
  lifetime,
  real,
  onOpen,
}: {
  spent: number;
  session: number;
  budget: number | null;
  /** Everything the ledger has ever counted, which is the credit consumed. */
  lifetime: number;
  /** The selected vendor's own balance, when this app was able to read it. */
  real?: Usage["real"];
  onOpen: () => void;
}) {
  const [open, setOpen] = useState(false);
  /* Only the selected vendor's own money draws this bar, and only while the
     ledger is that vendor's alone. A mix of vendors means no single balance is
     the truth of the whole, so the bar stays on the month it counted. */
  const credit = creditTotal(real?.headline ? real : null);
  const view = spendView({ spent, session, budget, lifetime, credit });
  if (!view.show) return null;

  const share = (n: number) => `${Math.min(100, Math.max(0, n * 100))}%`;
  // The session's slice is drawn as part of the fill, so it always sits at the
  // fill's right-hand end and can never stick out past the month it is in.
  const ofFill = view.used > 0 ? share(view.slice / view.used) : "0%";
  const tone = view.over ? "is-over" : view.near ? "is-near" : "";

  /* Consumed of what was paid in, the month, then this conversation. The month
     is not named twice: when the whole of the lifetime fell inside it the two
     figures are the same money, and printing it twice reads as two facts. */
  const monthIsAll = Math.abs(view.drawn - spent) < 0.005;
  const consumed = view.onCredit
    ? `${money(view.drawn)} of ${money(view.meter)} credit` +
      (monthIsAll ? " this month" : ` · ${money(spent)} this month`)
    : view.cap !== null
      ? `${money(spent)} of ${money(view.cap)} this month`
      : `${money(spent)} this month`;
  const mine = session > 0 ? ` · ${money(session)} this session` : "";
  const said = `${consumed}${mine}`;

  /* A phone hides .spend-words, and "15.58 30.00" without its words is not a
     sentence. Written out for that width instead: the two figures the fill
     stands for, as a division, with the session after it. */
  const short = view.onCredit || view.cap !== null
    ? `${money(view.onCredit ? view.drawn : spent)}/${money(view.meter)}`
    : money(spent);

  return (
    <>
    <button
      type="button"
      className={`spend ${tone}`.trim()}
      onClick={() => setOpen(true)}
      aria-label={`${said}${mine}. Open what this has cost.`}
      title={`${said}${mine}${view.over ? " — over the ceiling you set" : view.near ? " — close to the ceiling you set" : ""}. Open what this has cost.`}
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
        <span className="spend-long">{said}</span>
        <span className="spend-short">
          {short}
          {session > 0 && <> · {money(session)}</>}
        </span>
      </span>
    </button>
    {/* Beside the bar, not inside it: the card is a portal, so the DOM nesting
        is irrelevant, but React's events still follow the React tree -- a
        click on the card's backdrop would bubble up to the button that opened
        it and the card would close and reopen in the same click. */}
    {open && (
      <SpendPeek session={session} onUsage={onOpen} onClose={() => setOpen(false)} />
    )}
    </>
  );
});
