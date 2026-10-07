/**
 * What you have spent, folded into the few shapes the billing page asks for.
 *
 * The ledger is one row per turn; nothing here writes to it. Everything below
 * is a read: totals for the headline, a breakdown by vendor and model for the
 * "where is it going" question, a day-by-day series for the chart, and the
 * last few turns so a surprising number can be traced to the turn that caused
 * it.
 *
 * One honesty rule runs through all of it. A turn whose model was not in the
 * price table contributes nothing to the money figures and is counted
 * separately as unpriced; a turn whose token counts we estimated is counted as
 * estimated. A single number that quietly blends measured, guessed, and
 * unknown is worse than no number, because it cannot be checked against the
 * vendor's own invoice -- which is the only thing that actually charges you.
 */

import { PROVIDERS, providerSpec } from "./providers";
import { carriedDays, carriedTotals, resolveProvider, state, type UsageEntry } from "./state";
import { vendorMoneyAll } from "./vendor-money";

const DAYS_SHOWN = 30;
const RECENT_TURNS = 25;

/** Local-time YYYY-MM-DD: the day the person spending it would call it. */
export function dayKey(ts: number): string {
  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const monthKey = (ts: number) => dayKey(ts).slice(0, 7);

interface Bucket {
  cost: number;
  input: number;
  /** Of `input`, served from the provider's prompt cache. */
  cached: number;
  output: number;
  turns: number;
  unpriced: number;
  estimated: number;
}

const empty = (): Bucket => ({ cost: 0, input: 0, cached: 0, output: 0, turns: 0, unpriced: 0, estimated: 0 });

function add(bucket: Bucket, entry: UsageEntry) {
  bucket.cost += entry.cost;
  bucket.input += entry.input;
  bucket.cached += entry.cached ?? 0;
  bucket.output += entry.output;
  bucket.turns += 1;
  if (!entry.priced) bucket.unpriced += 1;
  if (entry.estimated) bucket.estimated += 1;
}

export function billingSummary() {
  const now = Math.floor(Date.now() / 1000);
  const today = dayKey(now);
  const month = monthKey(now);

  /* Where this month's money went. Entries from before the split was
     recorded have no parts, and are left out of it rather than guessed at;
     `covered` says how much of the month the split speaks for. */
  const split = { fresh: 0, cached: 0, output: 0, covered: 0 };

  const all = empty();
  const todayBucket = empty();
  const monthBucket = empty();
  const byProvider = new Map<string, Bucket & { models: Map<string, Bucket> }>();
  const byDay = new Map<string, number>();
  /* What the ledger counts for each vendor on its own. A vendor's own line has
     to be compared with the tokens that vendor billed, not with everybody's
     put together: counting every API's turns against one account makes the
     line say the vendor owes money it was never charged. */
  const countedByProvider = new Map<string, number>();
  /* This month's money per vendor. The composer's bar speaks for the account
     this console is actually spending, and the month it must not print beside
     that account's credit is everybody's month. */
  const monthByProvider = new Map<string, number>();

  for (const entry of state.usage) {
    add(all, entry);
    const day = dayKey(entry.ts);
    if (day === today) add(todayBucket, entry);
    if (day.slice(0, 7) === month) {
      add(monthBucket, entry);
      monthByProvider.set(entry.provider, (monthByProvider.get(entry.provider) ?? 0) + entry.cost);
      if (entry.parts) {
        split.fresh += entry.parts.fresh;
        split.cached += entry.parts.cached;
        split.output += entry.parts.output;
        split.covered += entry.cost;
      }
    }

    byDay.set(day, (byDay.get(day) ?? 0) + entry.cost);

    let provider = byProvider.get(entry.provider);
    if (!provider) {
      provider = Object.assign(empty(), { models: new Map<string, Bucket>() });
      byProvider.set(entry.provider, provider);
    }
    add(provider, entry);
    countedByProvider.set(entry.provider, (countedByProvider.get(entry.provider) ?? 0) + entry.cost);

    let model = provider.models.get(entry.model);
    if (!model) {
      model = empty();
      provider.models.set(entry.model, model);
    }
    add(model, entry);
  }

  /* Spend that has aged out of the ledger still happened and was still
     charged, so the lifetime figure carries it. It is also added back into
     the day it happened on -- which is the difference between a month figure
     that is right and one that quietly falls as the ledger turns over. Only
     the day and month buckets take it: the per-vendor and per-model
     breakdown stays a reading of the detail still on the ledger. */
  for (const [day, row] of Object.entries(carriedDays())) {
    byDay.set(day, (byDay.get(day) ?? 0) + row.cost);
    if (day === today) {
      todayBucket.cost += row.cost;
      todayBucket.input += row.input;
      todayBucket.output += row.output;
      todayBucket.turns += row.turns;
    }
    if (day.slice(0, 7) === month) {
      monthBucket.cost += row.cost;
      monthBucket.input += row.input;
      monthBucket.output += row.output;
      monthBucket.turns += row.turns;
    }
  }

  // The lump sums, for the lifetime total.
  const carried = carriedTotals();
  /* The vendor's own answer to "what has been spent", when its balance can be
     read: what has been paid in, less what is left with it. That beats
     anything counted from tokens here, because it also covers the calls that
     were charged without reporting what they used -- an answer stopped
     mid-sentence, an attempt retried after a dropped connection -- and those
     are exactly where counting comes out low. */
  const counted = all.cost + carried.cost;
  /* Each vendor's own answer, one line each: what has been paid in to that
     vendor, less what is left with it. None of them is anybody else's money,
     so all are reported, side by side, whoever is selected.

     One vendor's figure stands in for the lifetime total only when it is the
     only one there is and the ledger holds nobody else's turns -- and only
     when no spend has aged out of it either, since a lump that dropped off
     the ledger may well be another vendor's. Otherwise the total stays
     counted and every line is reported beside it, for whoever wants to
     compare the two. */
  const vendors = vendorMoneyAll();
  /* The account the next turn will call, if any: a bar that shows one vendor's
     till has to know which vendor's till that is. */
  const active = resolveProvider().provider;
  /* Only a line that knows what was paid in can speak for the total: a balance
     alone says what is left, not what has gone. */
  const spendable = vendors.filter((entry) => entry.lifetime_usd !== null);
  const onlyOneVendor = spendable.length === 1;
  const onlyThatVendor =
    byProvider.size === 0 ||
    (byProvider.size === 1 && byProvider.has(spendable[0]?.provider ?? ""));
  const usableReal =
    onlyOneVendor && onlyThatVendor && carried.cost === 0 ? spendable[0] ?? null : null;
  const unaccounted = usableReal ? Math.max(0, (usableReal.lifetime_usd ?? 0) - counted) : 0;
  /* What the ledger counts for one vendor alone: only that vendor's own rows.
     Nothing aged out of the ledger carries a provider, so it belongs to no
     line -- it is in the total and in the day it happened, and nowhere else. */
  const countedFor = (id: string) => countedByProvider.get(id) ?? 0;
  const lifetime = {
    cost: usableReal ? usableReal.lifetime_usd : counted,
    input: all.input + carried.input,
    cached: all.cached,
    output: all.output + carried.output,
    turns: all.turns + carried.turns,
    unpriced: all.unpriced,
    estimated: all.estimated,
  };

  /* The month, when the month is all there is.
     A console a few days old has nothing dated outside this month in it, and
     then the month and the lifetime are the same money: the vendor's own total
     is the honest figure for both, because counting leaves out the calls that
     never reported and the lump that aged out of the ledger -- which, on a
     ledger written before the days were kept, has no date to be placed by, and
     cannot be older than the oldest turn that does. A month that disagreed
     with the total about the same dollars would read as the console doubting
     itself. Only while that holds: one dated turn in another month and the
     month goes back to being counted, with the difference left out of it. */
  const oldest = state.usage.length > 0 ? state.usage[0].ts : null;
  const nothingDatedOutsideThisMonth =
    oldest !== null &&
    monthKey(oldest) === month &&
    Object.keys(carriedDays()).every((day) => day.slice(0, 7) === month);
  if (usableReal && nothingDatedOutsideThisMonth) {
    monthBucket.cost = usableReal.lifetime_usd ?? monthBucket.cost;
  }

  // A dense run of days, including the quiet ones: a chart that silently skips
  // the days you spent nothing makes a calm week look like a busy one.
  const series: { day: string; cost: number }[] = [];
  for (let i = DAYS_SHOWN - 1; i >= 0; i -= 1) {
    const day = dayKey(now - i * 86400);
    series.push({ day, cost: byDay.get(day) ?? 0 });
  }

  const providers = [...byProvider.entries()]
    .map(([id, bucket]) => ({
      provider: id,
      label: providerSpec(id)?.label ?? id,
      cost: bucket.cost,
      input: bucket.input,
      cached: bucket.cached,
      output: bucket.output,
      turns: bucket.turns,
      unpriced: bucket.unpriced,
      models: [...bucket.models.entries()]
        .map(([model, m]) => ({
          model,
          cost: m.cost,
          input: m.input,
          output: m.output,
          turns: m.turns,
          unpriced: m.unpriced,
        }))
        .sort((a, b) => b.cost - a.cost || b.turns - a.turns),
    }))
    .sort((a, b) => b.cost - a.cost || b.turns - a.turns);

  const budget = state.budgetUsd;

  return {
    currency: "USD",
    /** Oldest turn still on the ledger, so "since" is a fact and not a guess. */
    since: state.usage.length > 0 ? state.usage[0].ts : null,
    lifetime,
    today: todayBucket,
    month: monthBucket,
    providers,
    daily: series,
    recent: state.usage
      .slice(-RECENT_TURNS)
      .reverse()
      .map((entry) => ({
        ts: entry.ts,
        session: entry.session,
        provider: entry.provider,
        label: providerSpec(entry.provider)?.label ?? entry.provider,
        model: entry.model,
        input: entry.input,
        cached: entry.cached ?? 0,
        output: entry.output,
        cost: entry.cost,
        priced: entry.priced,
      })),
    /* What each vendor says, beside what was counted here, so the two can be
       compared by anyone who wants to check the arithmetic rather than trust
       the headline. One line per vendor that publishes a balance and has had
       money paid into it; empty when there is none, because nothing here is
       guessed and an absent line means "not known", never "nothing". */
    vendors: vendors.map((entry) => ({
      provider: entry.provider,
      label: entry.label,
      balance_usd: entry.balance_usd,
      topped_up_usd: entry.topped_up_usd,
      at: entry.at,
      lifetime_usd: entry.lifetime_usd,
      /* This vendor's own turns, not the whole ledger's: the comparison is
         this account against what this account billed. */
      counted_usd: countedFor(entry.provider),
      /* What this vendor's own turns cost this month, with nobody else's words
         in it: the month that belongs beside this account's credit. */
      month_usd: monthByProvider.get(entry.provider) ?? 0,
      /* Whether this is the account the console is spending right now. */
      selected: entry.provider === active,
      /* What that vendor's own till says was spent, less what its own tokens
         account for here. The rest is either calls it charged without
         reporting what they used, or money spent before this ledger began --
         which no local count can see, whichever it is. */
      unaccounted_usd:
        entry.lifetime_usd === null
          ? 0
          : usableReal !== null && usableReal.provider === entry.provider
            ? unaccounted
            : Math.max(0, entry.lifetime_usd - countedFor(entry.provider)),
      /* True only for the one line standing in for the headline: a single
         vendor's money, with nobody else's turns in the ledger. The rest are
         reported as what they are -- that vendor's own line. */
      headline: usableReal !== null && usableReal.provider === entry.provider,
      /* False when nobody has said what was paid into this one, so the page can
         report the balance as a balance rather than as spend. */
      spent_known: entry.lifetime_usd !== null,
    })),
    budget: {
      monthly_usd: budget,
      spent: monthBucket.cost,
      remaining: budget === null ? null : Math.max(0, budget - monthBucket.cost),
      over: budget !== null && monthBucket.cost > budget,
      /** Warn before it bites, not after. */
      near: budget !== null && monthBucket.cost > budget * 0.8,
    },
    /** Vendors whose prices are in the table at all, for the caveat line. */
    priced_providers: PROVIDERS.map((p) => p.id),
    split,
    /** This month's tool output as the model read it, biggest first. */
    tool_feed: state.toolFeed.month === month
      ? Object.entries(state.toolFeed.tools)
        .map(([tool, row]) => ({ tool, calls: row.calls, tokens: row.tokens }))
        .sort((a, b) => b.tokens - a.tokens)
        .slice(0, 8)
      : [],
  };
}
