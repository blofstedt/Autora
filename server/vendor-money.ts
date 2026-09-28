/**
 * What the vendor's own till says.
 *
 * DeepSeek publishes no usage endpoint -- /user/balance is the only money its
 * API will talk about, and per-key usage exists only as a CSV export behind a
 * login. Real spend therefore cannot be read off directly: it is what has been
 * paid in, less what is left, and that difference is the one figure which
 * cannot be wrong, because it is the vendor's own arithmetic on the vendor's
 * own money.
 *
 * It matters because counting tokens here will always come out low. A call
 * that ended before it reported its tokens -- an answer stopped mid-sentence,
 * an attempt retried after a dropped connection -- is still charged and leaves
 * no row on the ledger. So the balance is used as the truth about the total,
 * and the ledger keeps doing what it is good at: saying where the money went.
 *
 * Payments are observed rather than asked about. The balance is read every so
 * often, and a reading that has gone UP since the last one is money added, so
 * the amount paid in has to be right once and keeps itself right afterwards.
 *
 * Nothing here invents a number. With no readable balance, no known amount
 * paid in, or a balance sitting above what was paid in (a stale figure, a
 * refund), every caller is told "not known" and falls back to counting.
 */

import { keyFor, save, state } from "./state";
import { providerSpec } from "./providers";

/** The real spend, as the vendor's own balance works it out. */
export type VendorMoney = {
  /** What is left with the vendor, in USD. */
  balance_usd: number;
  /** Paid in so far, in USD. */
  topped_up_usd: number;
  /** When the balance was last read, in seconds. */
  at: number;
  /** Paid in, less what is left. */
  lifetime_usd: number;
};

/** How old a reading may be before another is worth making. The page asks for
    usage often; the vendor's server should not be asked on every render. */
export const STALE_MS = 5 * 60 * 1000;
/** A rise smaller than this is a wobble in the arithmetic, not a payment. */
const PAYMENT_MIN = 0.01;

/**
 * Paid in, less what is left.
 *
 * Null rather than a guess whenever the answer is not knowable: nothing paid
 * in, no balance read, or a balance that has ended up higher than the money
 * that went in, which means one of the two figures is stale and the honest
 * answer is that this does not know.
 */
export function realSpend(balance: number | null, toppedUp: number | null): number | null {
  if (typeof balance !== "number" || typeof toppedUp !== "number") return null;
  if (!Number.isFinite(balance) || !Number.isFinite(toppedUp)) return null;
  if (toppedUp <= 0) return null;
  const spent = toppedUp - balance;
  if (spent < 0) return null;
  return spent;
}

const endpoint = () => {
  const base = providerSpec("deepseek")?.baseUrl ?? "https://api.deepseek.com/v1";
  return `${base.replace(/\/v1\/?$/, "")}/user/balance`;
};

/** The real spend as it stands in the state, or null when it cannot be known. */
export function vendorMoney(): VendorMoney | null {
  const spent = realSpend(state.balanceUsd, state.topUpUsd);
  if (spent === null) return null;
  return {
    balance_usd: state.balanceUsd as number,
    topped_up_usd: state.topUpUsd as number,
    at: state.balanceAt ?? 0,
    lifetime_usd: spent,
  };
}

/** True when the last reading is old enough that another is worth making. */
export function vendorMoneyStale(now = Date.now()): boolean {
  const at = state.balanceAt;
  if (typeof at !== "number") return true;
  return now - at * 1000 > STALE_MS;
}

/**
 * Read the balance and fold what it says into the state.
 *
 * Never throws and never blocks a caller for long: an unreachable vendor
 * leaves the last reading in place, which is the right thing to show until
 * there is a better one.
 */
export async function refreshVendorMoney(): Promise<VendorMoney | null> {
  const key = keyFor("deepseek");
  if (!key) return vendorMoney();

  let usd: number | null = null;
  try {
    const res = await fetch(endpoint(), {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return vendorMoney();
    const body: any = await res.json();
    const infos: any[] = Array.isArray(body?.balance_infos) ? body.balance_infos : [];
    /* USD where it is offered; the first balance otherwise, since a vendor
       billing in one currency has only one to give. */
    const chosen = infos.find((info) => info?.currency === "USD") ?? infos[0];
    const parsed = Number(chosen?.total_balance);
    if (Number.isFinite(parsed)) usd = parsed;
  } catch {
    return vendorMoney();
  }
  if (usd === null) return vendorMoney();

  const seen = state.balanceUsd;
  /* A reading above the last one is money paid in between the two, so what has
     been paid in follows the till instead of having to be kept up by hand.
     Only from the second reading on: the first has nothing to compare with,
     and the amount entered by hand is what covers everything before it. */
  if (typeof seen === "number" && usd > seen + PAYMENT_MIN) {
    state.topUpUsd = (state.topUpUsd ?? 0) + (usd - seen);
  }
  state.balanceUsd = usd;
  state.balanceAt = Math.floor(Date.now() / 1000);
  save();
  return vendorMoney();
}
