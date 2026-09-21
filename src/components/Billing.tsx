import { useCallback, useEffect, useState } from "react";
import { IconCoin, IconRepeat, IconTrash } from "./Icons";

type Bucket = {
  cost: number;
  input: number;
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
    output: number;
    cost: number;
    priced: boolean;
  }[];
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
}: {
  budget: string;
  onBudget: (value: string) => void;
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

      {/* A monthly ceiling that warns rather than blocks. A console that stops
          answering mid-sentence because of a number typed here weeks ago is a
          worse surprise than the bill it was meant to prevent. */}
      <div className="bill-budget">
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
                    {turns(row.turns)} · {tokens(row.input)} in · {tokens(row.output)} out
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
                {tokens(turn.input)} / {tokens(turn.output)}
              </span>
              <em>{turn.priced ? money(turn.cost) : "—"}</em>
            </div>
          ))}
        </details>
      )}

      <p className="bill-caveat">
        Counted here from the tokens each vendor reports, priced from the list
        prices shown when you pick a model. It is a close running estimate, not
        an invoice: it cannot see usage from outside this app, nor a vendor's
        own discounts or minimums.
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
