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
 *
 * Whose money it is, is the whole point. A balance belongs to one vendor, and
 * only three of them publish one at all; for years this read DeepSeek's
 * whatever provider was selected, so the headline spend was DeepSeek's money
 * against somebody else's usage. Everything here is therefore per provider, and
 * a provider with no balance endpoint gets no figure rather than a borrowed one.
 */

import { keyFor, resolveProvider, save, state } from "./state";
import { providerSpec } from "./providers";

/** The real spend, as the vendor's own balance works it out. */
export type VendorMoney = {
  /** Which vendor this is the money of. Named because it is only ever one
      vendor's, and the page has to be able to say whose. */
  provider: string;
  /** That vendor's name as it is shown. */
  label: string;
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

/**
 * Where to ask, for a vendor that publishes a balance at all.
 *
 * The path is joined to the provider's own base URL rather than to a root with
 * the /v1 stripped off, because the two are not the same place: DeepSeek's
 * balance hangs off the host (/user/balance) while Orca Router's hangs under
 * the versioned prefix (/v1/balance). Each says its own path and each keeps its
 * own base, so neither has to be guessed from the other.
 */
function endpointFor(id: string): string | null {
  const spec = providerSpec(id);
  if (!spec?.balance) return null;
  const base = spec.baseUrl.replace(/\/+$/, "");
  /* Almost every vendor keeps its money endpoint under the versioned prefix
     alongside the chat routes. DeepSeek does not: /user/balance hangs off the
     host, so for that one the prefix comes off before the path goes on. */
  const root = spec.balance.root === "host" ? base.replace(/\/v1$/, "") : base;
  return `${root}${spec.balance.path}`;
}

/**
 * The dollars in a vendor's reply, which every one of them words differently.
 *
 * DeepSeek:  {"balance_infos":[{"currency":"USD","total_balance":"9.24"}]}
 * Orca:      {"unit":"USD","paid_balance":19.99,"promo_credits":[...]}
 * OpenRouter: {"data":{"total_credits":10,"total_usage":3.5}}
 *
 * Promotional credit is deliberately left out wherever the vendor separates it:
 * it is scoped to a model and expires, so spending it does not draw down what
 * was paid in, and counting it as paid in would make the spend read low.
 */
export function readBalance(field: "deepseek" | "orcarouter" | "openrouter", body: any): number | null {
  if (field === "deepseek") {
    const infos: any[] = Array.isArray(body?.balance_infos) ? body.balance_infos : [];
    /* USD where it is offered; the first balance otherwise, since a vendor
       billing in one currency has only one to give. */
    const chosen = infos.find((info) => info?.currency === "USD") ?? infos[0];
    const parsed = Number(chosen?.total_balance);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (field === "orcarouter") {
    const parsed = Number(body?.paid_balance);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const parsed = Number(body?.data?.total_credits);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Money paid in to one vendor, as last recorded. */
export function topUpFor(id: string): number | null {
  const value = state.topUps[id];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** What one vendor's balance was last read as, and when. */
export function balanceFor(id: string): { usd: number | null; at: number } {
  const usd = state.balances[id];
  return {
    usd: typeof usd === "number" && Number.isFinite(usd) ? usd : null,
    at: typeof state.balanceAts[id] === "number" ? state.balanceAts[id] : 0,
  };
}

/** The real spend for one vendor, or null when it cannot be known. */
export function vendorMoneyFor(id: string): VendorMoney | null {
  const label = providerSpec(id)?.label ?? id;
  const { usd, at } = balanceFor(id);
  const toppedUp = topUpFor(id);
  const spent = realSpend(usd, toppedUp);
  if (spent === null || usd === null || toppedUp === null) return null;
  return { provider: id, label, balance_usd: usd, topped_up_usd: toppedUp, at, lifetime_usd: spent };
}

/** The real spend for the provider the next turn will actually call.

    One vendor at a time: the balance is one account's money, and showing the
    vendor's figure against a different vendor's usage is how a wrong number
    gets believed. Null for a provider that publishes no balance at all. */
export function vendorMoney(id = resolveProvider().provider): VendorMoney | null {
  if (!id || !providerSpec(id)?.balance) return null;
  return vendorMoneyFor(id);
}

/** True when the last reading is old enough that another is worth making. */
export function vendorMoneyStale(now = Date.now()): boolean {
  const { at } = balanceFor(resolveProvider().provider);
  if (!at) return true;
  return now - at * 1000 > STALE_MS;
}

/**
 * Read the balance and fold what it says into the state.
 *
 * Never throws and never blocks a caller for long: an unreachable vendor
 * leaves the last reading in place, which is the right thing to show until
 * there is a better one.
 */
export async function refreshVendorMoney(id = resolveProvider().provider): Promise<VendorMoney | null> {
  const spec = id ? providerSpec(id) : undefined;
  const url = id ? endpointFor(id) : null;
  const key = id ? keyFor(id) : "";
  if (!id || !spec?.balance || !url || !key) return vendorMoney(id);

  let usd: number | null = null;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return vendorMoney(id);
    const body: any = await res.json();
    usd = readBalance(spec.balance.field, body);
  } catch {
    return vendorMoney(id);
  }
  if (usd === null) return vendorMoney(id);

  const seen = balanceFor(id).usd;
  /* A reading above the last one is money paid in between the two, so what has
     been paid in follows the till instead of having to be kept up by hand.
     Only from the second reading on: the first has nothing to compare with,
     and the amount entered by hand is what covers everything before it. */
  if (typeof seen === "number" && usd > seen + PAYMENT_MIN) {
    state.topUps[id] = (state.topUps[id] ?? 0) + (usd - seen);
  }
  state.balances[id] = usd;
  state.balanceAts[id] = Math.floor(Date.now() / 1000);
  save();
  return vendorMoney(id);
}
