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
import { PROVIDERS, providerSpec } from "./providers";

/** The real spend, as the vendor's own balance works it out. */
type VendorMoney = {
  /** Which vendor this is the money of. Named because it is only ever one
      vendor's, and the page has to be able to say whose. */
  provider: string;
  /** That vendor's name as it is shown. */
  label: string;
  /** What is left with the vendor, in USD. */
  balance_usd: number;
  /** Paid in so far, in USD. Null while nobody has said what went in, which is
      not the same as nothing having gone in: the balance is still a fact. */
  topped_up_usd: number | null;
  /** When the balance was last read, in seconds. */
  at: number;
  /** Paid in, less what is left. Null while there is no paid-in figure to take
      it from -- a balance on its own says what is left, not what was spent. */
  lifetime_usd: number | null;
  /** What the vendor's own till says this month has cost: spent now, less what
      it had spent when the month began. Null until a month's start is known. */
  month_real_usd: number | null;
  /** When that month's start was read, in seconds. A month that began before
      the console first saw the till is measured from here, not from the 1st. */
  month_since: number | null;
  /** Payments worked out from a rising balance, so a wrong one can be undone. */
  auto_top_ups: { at: number; usd: number }[];
};

/** How old a reading may be before another is worth making. The page asks for
    usage often; the vendor's server should not be asked on every render. */
const STALE_MS = 5 * 60 * 1000;
/** A rise smaller than this is a wobble in the arithmetic, not a payment. */
const PAYMENT_MIN = 0.01;
/** How long a reading that needs explaining waits for a second one to agree. */
const CONFIRM_SECONDS = 60;
/** How many automatic payments are kept to look back at. */
const AUTO_LOG_MAX = 20;

/** Local-time YYYY-MM, the month the person paying would call it. */
function monthOf(seconds: number): string {
  const d = new Date(seconds * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

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
 * DeepSeek:  {"balance_infos":[{"currency":"USD","total_balance":"9.24",
 *              "granted_balance":"0.00","topped_up_balance":"9.24"}]}
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
    /* The topped-up part alone, when it is given. total_balance adds granted
       (free) credit to it, and a grant arriving would read as money paid in. */
    const paid = chosen?.topped_up_balance;
    const parsed = Number(paid !== undefined && paid !== null && paid !== "" ? paid : chosen?.total_balance);
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
function topUpFor(id: string): number | null {
  const value = state.topUps[id];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** What one vendor's balance was last read as, and when. */
function balanceFor(id: string): { usd: number | null; at: number } {
  const usd = state.balances[id];
  return {
    usd: typeof usd === "number" && Number.isFinite(usd) ? usd : null,
    at: typeof state.balanceAts[id] === "number" ? state.balanceAts[id] : 0,
  };
}

/**
 * A vendor whose key has just been taken away.
 *
 * The last reading was that account's money, and with no key there is no way to
 * refresh it -- so it stops being reported at all. Kept, it would draw a line
 * for a connection nobody has any more the moment one existed again: the line
 * would come back from a balance read hours earlier, with nothing in the app to
 * say where it came from. What has been paid in stays, since that is a fact of
 * the account rather than a reading of it, and the arithmetic picks up where it
 * left off if a key is put back.
 */
export function forgetVendorMoney(id: string): void {
  if (!providerSpec(id)?.balance) return;
  delete state.balances[id];
  delete state.balanceAts[id];
  delete state.pendingReadings[id];
  save();
}

/**
 * One vendor's own line: what is left with it, and what has been paid in.
 *
 * A balance on its own is still worth reporting -- it is that account's money,
 * and it is what the page can say for certain -- so a vendor nobody has typed a
 * paid-in figure for gets a line saying what is left rather than no line at
 * all. What it does not get is a spent figure: paid in less left needs both,
 * and half of that pair is not arithmetic anybody should trust.
 *
 * Null only when nothing at all could be read from that vendor.
 */
export function vendorMoneyFor(id: string): VendorMoney | null {
  const label = providerSpec(id)?.label ?? id;
  const { usd, at } = balanceFor(id);
  if (usd === null) return null;
  const toppedUp = topUpFor(id);
  const lifetime = realSpend(usd, toppedUp);
  const base = state.monthBases[id];
  const thisMonth = base && base.month === monthOf(Math.floor(Date.now() / 1000));
  return {
    provider: id,
    label,
    balance_usd: usd,
    topped_up_usd: toppedUp,
    at,
    lifetime_usd: lifetime,
    month_real_usd: thisMonth && lifetime !== null ? Math.max(0, lifetime - base.spent) : null,
    month_since: thisMonth ? base.since : null,
    auto_top_ups: (state.autoTopUps[id] ?? []).map(({ at: when, usd: amount }) => ({ at: when, usd: amount })),
  };
}

/**
 * The paid-in total has been corrected, by hand or by undoing a payment, so
 * the vendor's spend moved by the same amount without a dollar being spent.
 * The month's starting point moves with it, or the correction would show up as
 * money gained or lost this month.
 */
export function shiftMonthBase(id: string, change: number): void {
  const base = state.monthBases[id];
  if (base && Number.isFinite(change)) base.spent += change;
}

/** Set what has been paid in at one vendor by hand. */
export function setTopUp(id: string, amount: number | null): void {
  const before = state.topUps[id];
  if (amount === null) {
    delete state.topUps[id];
    delete state.monthBases[id];
  } else {
    state.topUps[id] = amount;
    if (typeof before === "number") shiftMonthBase(id, amount - before);
  }
  /* Whatever was waiting to be confirmed was measured against the old total. */
  if (amount !== before) delete state.pendingReadings[id];
  const usd = state.balances[id];
  if (amount !== null && typeof usd === "number" && !state.monthBases[id]) {
    noteMonth(id, null, 0, Math.floor(Date.now() / 1000));
  }
}

/** Take back a payment the console worked out for itself. False when there was
    no such payment, which is not an error: it may already have been undone. */
export function undoAutoTopUp(id: string, at: number): boolean {
  const log = state.autoTopUps[id] ?? [];
  const index = log.findIndex((entry) => entry.at === at);
  if (index < 0) return false;
  const [entry] = log.splice(index, 1);
  const before = state.topUps[id] ?? 0;
  const after = Math.max(0, before - entry.usd);
  state.topUps[id] = after;
  shiftMonthBase(id, after - before);
  save();
  return true;
}

/**
 * Keep the month's starting point for one vendor.
 *
 * The month begins at the last reading made before it did, which is the
 * nearest thing to the till's figure at midnight on the 1st. With no earlier
 * reading the first one seen stands in, and `since` says so. `before` is the
 * spend at the previous reading, if there was one.
 */
function noteMonth(id: string, before: number | null, beforeAt: number, nowSec: number): void {
  const month = monthOf(nowSec);
  const base = state.monthBases[id];
  if (base && base.month === month) return;
  const usd = state.balances[id];
  const spent = typeof usd === "number" ? realSpend(usd, topUpFor(id)) : null;
  if (before !== null && beforeAt > 0 && monthOf(beforeAt) !== month) {
    state.monthBases[id] = { month, spent: before, since: beforeAt };
  } else if (spent !== null) {
    state.monthBases[id] = { month, spent, since: nowSec };
  }
}

/** The real spend for the provider the next turn will actually call.

    One vendor at a time: the balance is one account's money, and showing the
    vendor's figure against a different vendor's usage is how a wrong number
    gets believed. Null for a provider that publishes no balance at all. */
function vendorMoney(id = resolveProvider().provider): VendorMoney | null {
  if (!id || !providerSpec(id)?.balance) return null;
  return vendorMoneyFor(id);
}

/** Every vendor whose own money can be read, one entry each.

    Each line is that one vendor's own account -- what is left with it, and what
    has been spent where that can be worked out -- so several can sit side by
    side without any of them being spent against another's usage. A vendor with
    no balance endpoint, no key, or no balance read yet is left out rather than
    shown as zero: nothing here is guessed, and an absent line means "not
    known", never "nothing". */
export function vendorMoneyAll(): VendorMoney[] {
  return PROVIDERS.filter(
    (spec) => spec.balance && keyFor(spec.id) && vendorMoneyFor(spec.id) !== null,
  ).map((spec) => vendorMoneyFor(spec.id) as VendorMoney);
}

/** True when any vendor's last reading is old enough that another is worth making. */
export function vendorMoneyStale(now = Date.now()): boolean {
  const due = PROVIDERS.filter((spec) => spec.balance && keyFor(spec.id)).map(
    (spec) => balanceFor(spec.id).at,
  );
  if (due.length === 0) return false;
  return due.some((at) => !at || now - at * 1000 > STALE_MS);
}

/**
 * Read every vendor's balance, one after another.
 *
 * Each is its own account, so each is asked on its own; one that cannot be
 * reached leaves its last reading in place and does not stop the others. The
 * answer is every vendor's money, in the order they are listed.
 */
export async function refreshAllVendorMoney(): Promise<VendorMoney[]> {
  for (const spec of PROVIDERS) {
    if (spec.balance && keyFor(spec.id)) await refreshVendorMoney(spec.id);
  }
  return vendorMoneyAll();
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

  const { usd: seen, at: seenAt } = balanceFor(id);
  const nowSec = Math.floor(Date.now() / 1000);
  /* A reading that would need explaining is not believed on sight. A rise is
     either money paid in or a reading gone wrong, and a drop to nothing is
     either an empty account or the same; counting a wrong one as a payment
     inflates what was paid in, and every spend figure after it. So it waits
     for a later reading to say the same thing, and until then the last
     reading believed stays on show. */
  const rise = typeof seen === "number" && usd > seen + PAYMENT_MIN;
  const emptied = typeof seen === "number" && seen > 1 && usd <= PAYMENT_MIN;
  const waiting = state.pendingReadings[id];
  if (rise || emptied) {
    const agrees = rise ? usd > (seen as number) + PAYMENT_MIN : usd <= PAYMENT_MIN;
    if (!waiting || !agrees) {
      state.pendingReadings[id] = { balance: usd, at: nowSec };
      save();
      return vendorMoney(id);
    }
    if (nowSec - waiting.at < CONFIRM_SECONDS) return vendorMoney(id);
  }
  delete state.pendingReadings[id];

  const spentBefore = typeof seen === "number" ? realSpend(seen, topUpFor(id)) : null;
  /* A confirmed rise is money paid in between the two readings, so what has
     been paid in follows the till instead of having to be kept up by hand.
     Only from the second reading on: the first has nothing to compare with,
     and the amount entered by hand is what covers everything before it. It is
     written down, so a wrong one can be seen and taken back. */
  if (rise && typeof seen === "number") {
    const paidIn = usd - seen;
    state.topUps[id] = (state.topUps[id] ?? 0) + paidIn;
    const log = (state.autoTopUps[id] ??= []);
    log.push({ at: nowSec, usd: paidIn, balance: usd });
    if (log.length > AUTO_LOG_MAX) log.splice(0, log.length - AUTO_LOG_MAX);
  }
  state.balances[id] = usd;
  state.balanceAts[id] = nowSec;
  noteMonth(id, spentBefore, seenAt, nowSec);
  save();
  return vendorMoney(id);
}
