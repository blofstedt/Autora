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

/** Said when something that decides what the bar shows has changed: a key saved
    or taken away, the monthly budget, a paid-in figure, the provider in use.
    Which vendors have a line at all follows their keys, so without this the bar
    over the composer can go on showing an account that has just been taken out
    of Settings until the next turn happens to end. */
export const MONEY_CHANGED = "autora-money";

export const announceMoneyChange = () => window.dispatchEvent(new Event(MONEY_CHANGED));

export type SpendInputs = {
  /** This calendar month, from the ledger. */
  spent: number;
  /** What this session's turns have cost. */
  session: number;
  /** The monthly ceiling from Settings, if one is set. */
  budget: number | null;
  /** Everything the ledger has ever counted, when it is known. */
  lifetime?: number;
  /** What has been paid in to the vendor, when their own balance can be read. */
  credit?: number | null;
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

  /* --- the credit meter, when the vendor's own balance can be read --- */
  /** The money paid in, which is then what the bar's whole width means. */
  paid: number | null;
  /** What the fill is measuring: the credit consumed, or the month. */
  drawn: number;
  /** The dollars the full width stands for. */
  meter: number;
  /** True when the bar is the credit consumed rather than the month. */
  onCredit: boolean;
};

/** Anything that is not a positive number of dollars is nothing. */
const dollars = (value: number | null | undefined): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

/**
 * The money paid in at the vendor, from whatever could be read of it: the
 * topped-up total when the page says it, and otherwise what is left plus what
 * has gone. Null when neither can be had, which is the bar's cue to stay on
 * the month and the ceiling it already draws.
 */
export function creditTotal(
  real:
    | { topped_up_usd?: number | null; balance_usd?: number | null; lifetime_usd?: number | null }
    | null
    | undefined,
): number | null {
  if (!real) return null;
  if (typeof real.topped_up_usd === "number" && real.topped_up_usd > 0) return real.topped_up_usd;
  if (
    typeof real.balance_usd === "number" &&
    typeof real.lifetime_usd === "number" &&
    real.balance_usd + real.lifetime_usd > 0
  ) {
    return real.balance_usd + real.lifetime_usd;
  }
  return null;
}

/** One vendor's own till, as the per-vendor bars need it. */
export type VendorSpend = {
  /** The vendor, as the ledger names it. */
  provider: string;
  /** What to call it on screen. */
  label: string;
  /** What the vendor's own till says was spent there -- paid in less left.
      Null when nobody has said what was paid in, so there is no spend to
      take: a balance on its own says what is left, not what has gone. */
  spent: number | null;
  /** Credit paid in at this vendor, when known. */
  paid: number | null;
  /** What is left with the vendor -- the one figure a till with no paid-in
      figure can still speak. */
  balance: number | null;
};

export type VendorView = {
  provider: string;
  label: string;
  /** The money the fill measures: credit consumed, or the balance left. */
  drawn: number;
  /** Credit paid in, or null when the fill is a balance rather than a spend. */
  paid: number | null;
  /** True when the fill is the balance left, not credit consumed: the vendor
      publishes a balance but nobody has said what was paid in. */
  remaining: boolean;
  /** The fill as a share of the bar, 0..1. */
  used: number;
  over: boolean;
  near: boolean;
  /** Whether there is anything worth drawing for this vendor. A till that can
      be read at all is worth drawing -- credit sitting unspent is exactly what
      the bar is for -- so this is false only when nothing could be read. */
  show: boolean;
};

/**
 * One vendor's bar, on its own: what was consumed of what was paid in there,
 * with nobody else's turns in either number.
 *
 * A vendor whose paid-in figure is unknown still gets a bar -- the balance it
 * does publish, drawn as what remains -- because the point of one bar per
 * provider is that none of them hides. Only a vendor with nothing readable at
 * all is left out, and an absent bar means "not known", never "nothing".
 */
export function vendorSpendView(vendor: VendorSpend): VendorView {
  const paid = dollars(vendor.paid) || null;
  const spent = vendor.spent === null ? null : dollars(vendor.spent) || null;
  if (paid !== null) {
    const drawn = spent ?? Math.max(0, paid - dollars(vendor.balance));
    return {
      provider: vendor.provider,
      label: vendor.label,
      drawn,
      paid,
      remaining: false,
      used: paid > 0 ? Math.min(1, drawn / paid) : 0,
      over: drawn > paid,
      near: drawn <= paid && drawn > paid * 0.8,
      show: true,
    };
  }
  const balance = dollars(vendor.balance);
  if (balance > 0) {
    return {
      provider: vendor.provider,
      label: vendor.label,
      drawn: balance,
      paid: null,
      remaining: true,
      used: 1,
      over: false,
      near: false,
      show: true,
    };
  }
  return {
    provider: vendor.provider,
    label: vendor.label,
    drawn: 0,
    paid: null,
    remaining: false,
    used: 0,
    over: false,
    near: false,
    show: false,
  };
}

export function spendView({ spent, session, budget, lifetime, credit }: SpendInputs): SpendView {
  const month = dollars(spent);
  const mine = dollars(session);
  const cap = dollars(budget) || null;
  const paid = dollars(credit) || null;
  const life = dollars(lifetime);

  /* What the bar measures, when the vendor's balance can be read: what has
     been consumed of what was actually paid in. It is the honest headline --
     the money is bought in credit and spent down -- and the month and this
     conversation are the two sliceings of it worth having beside it.

     Without that reading the bar is what it always was: no ceiling, the month
     so far; a ceiling, the month against it. The session's slice is a share of
     the same money either way. */
  const onCredit = paid !== null && life > 0;
  const meter = onCredit && paid !== null ? paid : cap ?? month;
  const drawn = onCredit ? life : month;

  const used = meter > 0 ? Math.min(1, drawn / meter) : 0;
  /* A session that cost more than the month it sits in means the ledger was
     reset under it; it cannot have more of the bar than the month does. */
  const slice = meter > 0 ? Math.min(used, mine / meter) : 0;

  return {
    used,
    slice,
    cap,
    over: cap !== null && month > cap,
    near: cap !== null && month <= cap && month > cap * 0.8,
    show: month > 0 || mine > 0 || cap !== null || paid !== null,

    paid,
    drawn,
    meter,
    onCredit,
  };
}
