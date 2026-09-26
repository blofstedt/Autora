/**
 * The spend bar over the composer, as arithmetic.
 *
 * Two numbers matter while typing: what this month has cost against the
 * ceiling set in Settings, and how much of that is the conversation you are
 * in. The bar is the month; the right-hand end of it is this session.
 *
 * Kept out of the component because the case worth being sure about -- a
 * ceiling that has been passed, a session that outlived a ledger reset, no
 * ceiling at all -- is arithmetic, not drawing.
 */

export type SpendInputs = {
  /** This calendar month, from the ledger. */
  spent: number;
  /** What this session's turns have cost. */
  session: number;
  /** The monthly ceiling from Settings, if one is set. */
  budget: number | null;
};

export type SpendView = {
  /** The month's money as a share of the bar, 0..1. */
  used: number;
  /** This session's money as a share of the same bar, never past `used`. */
  slice: number;
  /** The ceiling the bar is measured against, or null when there is none. */
  cap: number | null;
  over: boolean;
  near: boolean;
  /** Whether there is anything worth drawing. */
  show: boolean;
};

/** Anything that is not a positive number of dollars is nothing. */
const dollars = (value: number): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

export function spendView({ spent, session, budget }: SpendInputs): SpendView {
  const month = dollars(spent);
  const mine = dollars(session);
  const cap = dollars(budget as number) || null;

  /* No ceiling: the bar is the month so far, and the session's slice of it is
     still the honest thing to show -- it is a share of the same money. */
  const scale = cap ?? month;

  const used = scale > 0 ? Math.min(1, month / scale) : 0;
  /* A session that cost more than the month it sits in means the ledger was
     reset under it; it cannot have more of the bar than the month does. */
  const slice = scale > 0 ? Math.min(used, mine / scale) : 0;

  return {
    used,
    slice,
    cap,
    over: cap !== null && month > cap,
    near: cap !== null && month <= cap && month > cap * 0.8,
    show: month > 0 || mine > 0 || cap !== null,
  };
}
