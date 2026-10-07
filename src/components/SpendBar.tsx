import { memo, useState } from "react";
import { money } from "./Billing";
import { barVendor, creditTotal, spendView, vendorSpendView, type VendorSpend } from "../lib/spend";
import { SpendPeek } from "./SpendPeek";

/** What `/api/usage` answers with, as far as this bar is concerned. */
export type Usage = {
  month: { cost: number };
  lifetime: { cost: number };
  budget: { monthly_usd: number | null };
  /** What each vendor's own balance says, when it can be read at all. One entry
      per vendor; each is that account's money alone. */
  vendors?: {
    /** Which vendor's money this is. */
    provider: string;
    label: string;
    topped_up_usd: number | null;
    balance_usd: number;
    lifetime_usd: number | null;
    /** True only for the one line that is the whole truth of the ledger: a
        single vendor's money with nobody else's turns in it. Only that line may
        draw this bar. */
    headline: boolean;
    /** False when there is no paid-in figure, so there is no credit to draw. */
    spent_known: boolean;
    /** What this vendor's own turns cost this month, with nobody else's in it. */
    month_usd?: number;
    /** True for the account the console is spending right now. */
    selected?: boolean;
  }[];
};

/**
 * The money, in the three spans it is actually thought about, over the composer.
 *
 * One bar per vendor when several exist; one bar for the month otherwise. Each
 * vendor bar is that account's money alone: what was consumed of what was paid
 * in there, or what is left when there is no paid-in figure. Without readable
 * credit the bar is what it always was, the month against the ceiling set in
 * Settings, or the month alone.
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
  vendors,
  onOpen,
}: {
  spent: number;
  session: number;
  budget: number | null;
  /** Everything the ledger has ever counted, which is the credit consumed. */
  lifetime: number;
  /** Every vendor's own balance this app was able to read, one each. */
  vendors?: Usage["vendors"];
  onOpen: () => void;
}) {
  const [open, setOpen] = useState(false);

  /* Per-provider bars when several tills can be read; the old single bar
     otherwise (one vendor headline, or none). */
  const readableVendors = vendors?.filter((v) => v.spent_known || v.balance_usd > 0) ?? [];
  const multiVendor = readableVendors.length > 1;

  if (multiVendor) {
    const bars = readableVendors.map((v): VendorSpend => ({
      provider: v.provider,
      label: v.label,
      spent: v.lifetime_usd,
      paid: v.topped_up_usd,
      balance: v.balance_usd,
    }));
    const views = bars.map(vendorSpendView).filter((v) => v.show);
    if (views.length === 0) return null;

    return (
      <>
        <div className="spend-stack">
          {views.map((view) => {
            const share = (n: number) => `${Math.min(100, Math.max(0, n * 100))}%`;
            const tone = view.over ? "is-over" : view.near ? "is-near" : "";
            const said = view.remaining
              ? `${view.label}: ${money(view.drawn)} left`
              : `${view.label}: ${money(view.drawn)} of ${money(view.paid!)} credit`;

            return (
              <button
                key={view.provider}
                type="button"
                className={`spend ${tone}`.trim()}
                onClick={() => setOpen(true)}
                aria-label={`${said}. Open what this has cost.`}
                title={`${said}.`}
              >
                <span className="spend-track" aria-hidden="true">
                  <i
                    className={`spend-used ${view.used > 0 ? "is-any" : ""}`.trim()}
                    style={{ width: share(view.used) }}
                  />
                </span>
                <span className="spend-text">
                  <span className="spend-long">{said}</span>
                  <span className="spend-short">
                    {view.remaining ? money(view.drawn) : `${money(view.drawn)}/${money(view.paid!)}`}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
        {open && <SpendPeek session={session} onUsage={onOpen} onClose={() => setOpen(false)} />}
      </>
    );
  }

  /* Single bar: the till of the account this console is spending, when it can
     be read at all; the month against the ceiling otherwise. */
  const chosen = barVendor(vendors);
  const credit = creditTotal(chosen ?? null);
  /* The money this bar shows is one vendor's money, so the month beside its
     credit is that vendor's own: the ledger's whole month may be mostly another
     API's turns, and printing it here reads as this account's spend. */
  const ownMonth =
    credit !== null && chosen && typeof chosen.month_usd === "number" ? chosen.month_usd : spent;
  const view = spendView({ spent: ownMonth, session, budget, lifetime, credit });
  if (!view.show) return null;

  const share = (n: number) => `${Math.min(100, Math.max(0, n * 100))}%`;
  // The session's slice is drawn as part of the fill, so it always sits at the
  // fill's right-hand end and can never stick out past the month it is in.
  const ofFill = view.used > 0 ? share(view.slice / view.used) : "0%";
  const tone = view.over ? "is-over" : view.near ? "is-near" : "";

  /* Consumed of what was paid in, the month, then this conversation. The month
     is not named twice: when the whole of the lifetime fell inside it the two
     figures are the same money, and printing it twice reads as two facts. */
  /* Whose till it is, when the bar is not the whole ledger's money. Somebody
     reading "$27.36 of $30.00 credit" over a console that also pays another
     vendor has to be told which account that is. */
  const whose = chosen && !chosen.headline ? `${chosen.label}: ` : "";
  const monthIsAll = Math.abs(view.drawn - ownMonth) < 0.005;
  const consumed = view.onCredit
    ? `${whose}${money(view.drawn)} of ${money(view.meter)} credit` +
      (monthIsAll ? " this month" : ` · ${money(ownMonth)} this month`)
    : view.cap !== null
      ? `${money(ownMonth)} of ${money(view.cap)} this month`
      : `${money(ownMonth)} this month`;
  const mine = session > 0 ? ` · ${money(session)} this session` : "";
  const said = `${consumed}${mine}`;

  /* A phone hides .spend-words, and "15.58 30.00" without its words is not a
     sentence. Written out for that width instead: the two figures the fill
     stands for, as a division, with the session after it. */
  const short = view.onCredit || view.cap !== null
    ? `${money(view.onCredit ? view.drawn : ownMonth)}/${money(view.meter)}`
    : money(ownMonth);

  return (
    <>
      <button
      type="button"
      className={`spend ${tone}`.trim()}
      onClick={() => setOpen(true)}
      aria-label={`${said}. Open what this has cost.`}
      title={`${said}${view.over ? " — over the ceiling you set" : view.near ? " — close to the ceiling you set" : ""}. Open what this has cost.`}
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
