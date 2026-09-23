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
import { carriedTotals, state, type UsageEntry } from "./state";

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

  const all = empty();
  const todayBucket = empty();
  const monthBucket = empty();
  const byProvider = new Map<string, Bucket & { models: Map<string, Bucket> }>();
  const byDay = new Map<string, number>();

  for (const entry of state.usage) {
    add(all, entry);
    const day = dayKey(entry.ts);
    if (day === today) add(todayBucket, entry);
    if (day.slice(0, 7) === month) add(monthBucket, entry);

    byDay.set(day, (byDay.get(day) ?? 0) + entry.cost);

    let provider = byProvider.get(entry.provider);
    if (!provider) {
      provider = Object.assign(empty(), { models: new Map<string, Bucket>() });
      byProvider.set(entry.provider, provider);
    }
    add(provider, entry);

    let model = provider.models.get(entry.model);
    if (!model) {
      model = empty();
      provider.models.set(entry.model, model);
    }
    add(model, entry);
  }

  // Turns that have aged out of the ledger still happened and were still
  // charged, so the lifetime figure carries them even though their detail is
  // gone.
  const carried = carriedTotals();
  const lifetime = {
    cost: all.cost + carried.cost,
    input: all.input + carried.input,
    cached: all.cached,
    output: all.output + carried.output,
    turns: all.turns + carried.turns,
    unpriced: all.unpriced,
    estimated: all.estimated,
  };

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
  };
}
