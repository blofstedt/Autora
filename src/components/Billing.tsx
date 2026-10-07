import { useCallback, useEffect, useState } from "react";
import { IconCoin, IconRepeat, IconTrash } from "./Icons";

type Bucket = {
  cost: number;
  input: number;
  cached: number;
  output: number;
  turns: number;
  unpriced: number;
  estimated: number;
};

type ModelRow = {
  model: string;
  cost: number;
  input: number;
  output: number;
  turns: number;
  unpriced: number;
};

type ProviderRow = {
  provider: string;
  label: string;
  cost: number;
  input: number;
  cached: number;
  output: number;
  turns: number;
  unpriced: number;
  models: ModelRow[];
};

export type Usage = {
  currency: string;
  since: number | null;
  lifetime: Bucket;
  today: Bucket;
  month: Bucket;
  providers: ProviderRow[];
  daily: { day: string; cost: number }[];
  recent: {
    ts: number;
    session: string;
    provider: string;
    label: string;
    model: string;
    input: number;
    cached: number;
    output: number;
    cost: number;
    priced: boolean;
  }[];
  split?: { fresh: number; cached: number; output: number; covered: number };
  /** What each vendor's own balance says, when it can be read: paid in, less
      left. One entry per vendor -- each is its own account's money, never a
      figure borrowed from one and spent against another. Empty while there is
      nothing to read it from. */
  vendors?: {
    /** Which vendor's money this is. */
    provider: string;
    label: string;
    balance_usd: number;
    /** Null while nobody has said what was paid in: the balance is still a fact,
        there is just no spend to take it away from. */
    topped_up_usd: number | null;
    at: number;
    lifetime_usd: number | null;
    /** This month by the vendor's own balance, and when its start was read. */
    month_real_usd?: number | null;
    month_since?: number | null;
    /** Payments the console worked out from a rising balance. */
    auto_top_ups?: { at: number; usd: number }[];
    counted_usd: number;
    unaccounted_usd: number;
    /** True only for the line standing in for the all-time total: one vendor's
        money, with nobody else's turns in the ledger. The rest are reported as
        what they are -- that vendor's own line. */
    headline: boolean;
    /** False when there is no paid-in figure, so the line is a balance rather
        than a spend. */
    spent_known: boolean;
  }[];
  tool_feed?: { tool: string; calls: number; tokens: number }[];
  budget: {
    monthly_usd: number | null;
    spent: number;
    remaining: number | null;
    over: boolean;
    near: boolean;
  };
};

/**
 * Money, at the precision the number deserves.
 *
 * A console turn on a cheap model costs a fraction of a cent, and rounding that
 * to two places prints "$0.00" against a turn that plainly cost something --
 * which reads as a broken counter, not a small bill. Small amounts therefore
 * keep four places; once there are real dollars on the clock, two is what
 * anyone actually wants to read.
 */
export function money(amount: number): string {
  if (amount === 0) return "$0.00";
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  if (amount < 1) return `$${amount.toFixed(3)}`;
  return `$${amount.toFixed(2)}`;
}

/** "1 turn", not "1 turns" -- the first turn of the month is the one most
    likely to be read, and it should not look like a placeholder. */
const turns = (n: number) => `${n} turn${n === 1 ? "" : "s"}`;
const turnsOf = (n: number) => `${n} call${n === 1 ? "" : "s"}`;

/** " (84% cached)", or nothing when none of it was. */
function cachedShare(input: number, cached: number | undefined): string {
  if (!cached || input <= 0) return "";
  return ` (${Math.round((cached / input) * 100)}% cached)`;
}

function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

const when = (ts: number) =>
  new Date(ts * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

/**
 * What the models have cost, and where it went.
 *
 * Everything here is counted locally, from the token counts each vendor
 * reports at the end of a turn, priced against the table the settings panel
 * quotes when you pick a model. That makes it an accurate running estimate and
 * emphatically not an invoice: it cannot see usage from outside this app, it
 * cannot see a vendor's own discounts, caching credits or minimums, and where
 * a vendor declined to report tokens the count is our arithmetic. The caveats
 * are printed on the card rather than buried in a doc, because a number that
 * looks authoritative and is not is the worst thing a billing page can be.
 */
export function Billing({
  budget,
  onBudget,
  topUp,
  onTopUp,
  topUpLabel,
}: {
  budget: string;
  onBudget: (value: string) => void;
  /** Total paid in at the vendor, as typed in Settings. Half of the real
      total: spend is this less the balance left. */
  topUp: string;
  onTopUp: (value: string) => void;
  /** Which vendor that figure belongs to, for the label. Null while the server
      has not said, or the selected provider publishes no balance at all. */
  topUpLabel?: string | null;
}) {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(() => {
    setError(null);
    void fetch("/api/usage")
      .then(async (r) => {
        if (!r.ok) throw new Error(`the server answered ${r.status}`);
        return r.json();
      })
      .then(setUsage)
      .catch((cause: unknown) =>
        setError(
          cause instanceof TypeError
            ? "Could not reach the server."
            : `Could not read usage: ${cause instanceof Error ? cause.message : String(cause)}.`,
        ),
      );
  }, []);

  useEffect(load, [load]);

  const undoTopUp = useCallback((provider: string, at: number) => {
    void fetch("/api/usage/undo-top-up", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, at }),
    })
      .then((r) => r.json())
      .then(setUsage)
      .catch(() => setError("Could not take that payment back."));
  }, []);

  const reset = useCallback(() => {
    void fetch("/api/usage/reset", { method: "POST" })
      .then((r) => r.json())
      .then((next) => {
        setUsage(next);
        setConfirming(false);
      })
      .catch(() => setError("Could not reset the ledger."));
  }, []);

  if (error) {
    return (
      <section className="set-card">
        <h3>Billing</h3>
        <p className="set-warn">{error}</p>
        <button className="btn ghost" onClick={load}>Try again</button>
      </section>
    );
  }

  if (!usage) {
    return (
      <section className="set-card">
        <h3>Billing</h3>
        <p className="jf-hint">Loading…</p>
      </section>
    );
  }

  const peak = Math.max(...usage.daily.map((d) => d.cost), 0);
  const busiest = usage.daily.reduce(
    (best, day) => (day.cost > best.cost ? day : best),
    { day: "", cost: 0 },
  );
  const cap = usage.budget.monthly_usd;
  const used = cap && cap > 0 ? Math.min(1, usage.month.cost / cap) : 0;

  return (
    <section className="set-card">
      <div className="bill-head">
        <h3>
          <IconCoin size={12} /> Billing
        </h3>
        <button className="btn ghost bill-refresh" onClick={load} aria-label="Refresh usage">
          <IconRepeat size={13} /> Refresh
        </button>
      </div>

      <div className="bill-tiles">
        <Tile label="This month" value={money(usage.month.cost)} sub={turns(usage.month.turns)} lead />
        <Tile label="Today" value={money(usage.today.cost)} sub={turns(usage.today.turns)} />
        <Tile
          label="All time"
          value={money(usage.lifetime.cost)}
          sub={usage.since ? `since ${new Date(usage.since * 1000).toLocaleDateString()}` : "nothing yet"}
        />
      </div>

        {/* Where the all-time number comes from, said plainly, one line per
            vendor: a balance is the only figure that cannot be wrong, so it is
            what the total is built on -- and whose money each line is, because
            one vendor's balance is never anybody else's. */}
        {usage.vendors?.map((vendor) => (
        <p className="jf-hint bill-real" key={vendor.provider}>
          {vendor.spent_known
            ? vendor.headline
              ? `All time comes from ${vendor.label}: `
              : `${vendor.label}'s own account says: `
            : `${vendor.label}'s own account has `}
          {vendor.spent_known ? (
            <>
              {money(vendor.topped_up_usd ?? 0)} paid in
              less {money(vendor.balance_usd)} left is {money(vendor.lifetime_usd ?? 0)} spent.
              {" "}
              {vendor.unaccounted_usd > 0
                ? `This ledger's rows for ${vendor.label} come to ${money(vendor.counted_usd)} of it; the other ${money(vendor.unaccounted_usd)} is money spent before those rows, or calls charged without reporting what they used.`
                : vendor.counted_usd > (vendor.lifetime_usd ?? 0) + 0.01
                  ? `The tokens counted here against that account come to ${money(vendor.counted_usd)}, which is more than its balance says has gone -- so more was paid into it than the ${money(vendor.topped_up_usd ?? 0)} recorded.`
                  : `Counting tokens here accounts for ${money(vendor.counted_usd)} of that.`}
            </>
          ) : (
            <>
              {money(vendor.balance_usd)} left in it. Nothing is recorded as paid
              in, so there is no spend to take that away from -- set it under
              Settings and this line becomes one.
            </>
          )}
          {vendor.spent_known && typeof vendor.month_real_usd === "number" && (
            <>
              {" "}This month it says {money(vendor.month_real_usd)}
              {vendor.month_since ? `, counting from ${when(vendor.month_since)}` : ""}.
            </>
          )}
          {" "}Last balance read {when(vendor.at)}.
          {vendor.auto_top_ups?.slice(-3).map((payment) => (
            <span key={payment.at}>
              {" "}Added {money(payment.usd)} paid in on {when(payment.at)}, because the balance rose.{" "}
              <button
                className="btn ghost"
                onClick={() => undoTopUp(vendor.provider, payment.at)}
                aria-label={`Take back the ${money(payment.usd)} added on ${when(payment.at)}`}
              >
                Not a payment
              </button>
            </span>
          ))}
        </p>
      ))}

      {/* The prompt cache is where an agent's cost is won or lost: every
          round resends the whole conversation, and the part the provider
          recognises is billed at a small fraction of the price. */}
      {usage.month.cached > 0 && (
        <p className="jf-hint">
          This month {Math.round((usage.month.cached / Math.max(1, usage.month.input)) * 100)}% of
          input tokens ({tokens(usage.month.cached)} of {tokens(usage.month.input)}) were served
          from the provider's cache, at its lower cached price.
        </p>
      )}

      {/* Where the month's money went, by kind of token. New input and
          output are the parts worth cutting; cached input is already cheap. */}
      {usage.split && usage.split.covered > 0 && (
        <div className="bill-split">
          <h4>Where it went this month</h4>
          <div className="bill-submodel"><span>New input</span><em>{money(usage.split.fresh)}</em></div>
          <div className="bill-submodel"><span>Cached input</span><em>{money(usage.split.cached)}</em></div>
          <div className="bill-submodel"><span>Output (what the model wrote)</span><em>{money(usage.split.output)}</em></div>
          {usage.split.covered < usage.month.cost - 0.005 && (
            <p className="jf-hint">
              Covers {money(usage.split.covered)} of {money(usage.month.cost)}; earlier turns were
              recorded before this split was kept.
            </p>
          )}
        </div>
      )}

      {usage.tool_feed && usage.tool_feed.length > 0 && (
        <details className="bill-recent">
          <summary>Tool output sent to the model this month</summary>
          {usage.tool_feed.map((row) => (
            <div key={row.tool} className="bill-turn">
              <code>{row.tool}</code>
              <span className="bill-turn-tokens">{turnsOf(row.calls)}</span>
              <em>{tokens(row.tokens)}</em>
            </div>
          ))}
        </details>
      )}

      {/* A monthly ceiling that warns rather than blocks. A console that stops
          answering mid-sentence because of a number typed here weeks ago is a
          worse surprise than the bill it was meant to prevent. */}
      <div className="bill-budget">
        {/* Half of the real total, and the half that cannot be worked out: the
            console never saw a payment made before it existed, so it is asked
            for once. A payment made later needs no hand -- the balance jumping
              up is how one is noticed.

              Shown only for a vendor that publishes a balance, since
              without one the figure could never be turned into a spend,
              and named for the vendor it belongs to: it is one account's
              money. */}
        {topUpLabel && (
          <label className="jf-row">
            <span>Paid in to {topUpLabel} (optional)</span>
            <input
              value={topUp}
              onChange={(e) => onTopUp(e.target.value)}
              placeholder="e.g. 30"
              inputMode="decimal"
              spellCheck={false}
              aria-label={`Total paid in to ${topUpLabel}, in dollars`}
            />
          </label>
        )}
        <label className="jf-row">
          <span>Monthly budget (optional)</span>
          <input
            value={budget}
            onChange={(e) => onBudget(e.target.value)}
            placeholder="e.g. 20"
            inputMode="decimal"
            spellCheck={false}
            aria-label="Monthly budget in dollars"
          />
        </label>
        {cap !== null && cap > 0 && (
          <>
            <div className="bill-meter" role="img"
                 aria-label={`${money(usage.month.cost)} of ${money(cap)} used this month`}>
              <span
                className={`bill-meter-fill ${usage.budget.over ? "is-over" : usage.budget.near ? "is-near" : ""}`}
                style={{ width: `${Math.max(2, used * 100)}%` }}
              />
            </div>
            <p className={usage.budget.over || usage.budget.near ? "set-warn" : "jf-hint"}>
              {usage.budget.over
                ? `Over budget: ${money(usage.month.cost)} spent against a ${money(cap)} cap. Nothing has been blocked.`
                : `${money(usage.budget.remaining ?? 0)} left of ${money(cap)} this month.`}
            </p>
          </>
        )}
      </div>

      {/* Thirty days, including the quiet ones -- a chart that skips the days
          you spent nothing makes a calm week look like a busy one. Below a
          first turn there is nothing to draw, and an empty plot frame reads as
          a broken chart rather than a quiet month. */}
      {peak > 0 && (
        <>
          <div className="bill-chart-head">
            <h4>Last 30 days</h4>
            <span>
              busiest {busiest.day.slice(5)} · {money(busiest.cost)}
            </span>
          </div>
          <div className="bill-chart" role="img"
               aria-label={`Daily spend for the last 30 days, peaking at ${money(peak)}`}>
            {usage.daily.map((day) => (
              <span
                key={day.day}
                className={`bill-bar ${day.cost > 0 ? "has-spend" : ""}`}
                style={{ height: `${Math.max(day.cost > 0 ? 3 : 1, (day.cost / peak) * 100)}%` }}
                title={`${day.day} — ${money(day.cost)}`}
              />
            ))}
          </div>
          <div className="bill-axis">
            <span>{usage.daily[0]?.day.slice(5)}</span>
            <span>today</span>
          </div>
        </>
      )}

      {usage.providers.length === 0 ? (
        <p className="jf-hint bill-empty">
          Nothing spent yet. Turns are priced and recorded here as they finish.
        </p>
      ) : (
        <div className="bill-rows">
          {usage.providers.map((row) => {
            const expanded = open === row.provider;
            return (
              <div key={row.provider} className="bill-row-group">
                <button
                  className="bill-row"
                  onClick={() => setOpen(expanded ? null : row.provider)}
                  aria-expanded={expanded}
                >
                  <b>{row.label}</b>
                  <span className="bill-row-meta">
                    {turns(row.turns)} · {tokens(row.input)} in{cachedShare(row.input, row.cached)} · {tokens(row.output)} out
                  </span>
                  {/* A provider whose every turn ran on an unpriced model has
                      not cost nothing -- we simply do not know. Saying $0.00
                      there would be a claim; "unpriced" is the fact. */}
                  <em>{row.unpriced === row.turns ? "unpriced" : money(row.cost)}</em>
                </button>
                {expanded &&
                  row.models.map((model) => (
                    <div key={model.model} className="bill-submodel">
                      <code>{model.model}</code>
                      <span>{turns(model.turns)}</span>
                      <em>{model.unpriced === model.turns ? "unpriced" : money(model.cost)}</em>
                    </div>
                  ))}
              </div>
            );
          })}
        </div>
      )}

      {usage.recent.length > 0 && (
        <details className="bill-recent">
          <summary>Recent turns</summary>
          {usage.recent.map((turn, i) => (
            <div key={`${turn.ts}-${i}`} className="bill-turn">
              <span className="bill-turn-when">{when(turn.ts)}</span>
              <code>{turn.model}</code>
              <span className="bill-turn-tokens">
                {tokens(turn.input)}{cachedShare(turn.input, turn.cached)} / {tokens(turn.output)}
              </span>
              <em>{turn.priced ? money(turn.cost) : "—"}</em>
            </div>
          ))}
        </details>
      )}

      <p className="bill-caveat">
        Counted here from the tokens each vendor reports, priced from the list
        prices shown when you pick a model
        {usage.vendors?.some((vendor) => vendor.headline)
          ? ` -- except the all-time total, which is ${usage.vendors.find((vendor) => vendor.headline)!.label}'s own money: paid in, less the balance left with it, so not an estimate at all`
          : usage.vendors && usage.vendors.length > 0
            ? `, including the all-time total. Each vendor's own balance is reported above, but every one of them is a single account's money and this ledger holds turns from more than one, so no one balance can be the total and it stays counted`
            : " -- including the all-time total"}
        . What counting cannot see is a call that ended before it reported its
        tokens -- an answer you stopped, or an attempt retried after a dropped
        connection -- and usage from outside this app. Both are still charged,
        and both show up in the balance. The month and today are counted, and
        can come out under the vendor's own for exactly that reason.
        {usage.lifetime.estimated > 0 &&
          ` ${turns(usage.lifetime.estimated)} had no reported token count and ${
            usage.lifetime.estimated === 1 ? "was" : "were"
          } estimated.`}
        {usage.lifetime.unpriced > 0 &&
          ` ${turns(usage.lifetime.unpriced)} used a model with no published price and ${
            usage.lifetime.unpriced === 1 ? "is" : "are"
          } counted but not billed.`}
      </p>

      {confirming ? (
        <div className="bill-confirm">
          <span>Clear the whole spend history? It cannot be undone.</span>
          <button className="btn danger" onClick={reset}>Clear</button>
          <button className="btn ghost" onClick={() => setConfirming(false)}>Cancel</button>
        </div>
      ) : (
        <button className="btn ghost bill-reset" onClick={() => setConfirming(true)}>
          <IconTrash size={13} /> Reset counter
        </button>
      )}
    </section>
  );
}

function Tile({
  label, value, sub, lead,
}: {
  label: string;
  value: string;
  sub: string;
  lead?: boolean;
}) {
  return (
    <div className={`bill-tile ${lead ? "is-lead" : ""}`}>
      <span className="bill-tile-label">{label}</span>
      <b className="bill-tile-value">{value}</b>
      <span className="bill-tile-sub">{sub}</span>
    </div>
  );
}
