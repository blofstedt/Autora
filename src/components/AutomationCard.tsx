import { useEffect, useState } from "react";

/**
 * What the agent's own automation is allowed to cost.
 *
 * The failure mode this exists for: a watcher on something that changes often.
 * Every firing opens a fresh session, and a fresh session loads the whole
 * prompt, the tool list and the memory before the job has done anything, so a
 * job nobody is watching becomes the largest line on the bill. Schedules are
 * worth having -- this is not a way to switch them off.
 *
 * So: a budget for automated runs alone, apart from the conversation. The day
 * budget is checked before a job is allowed to start, the run budget every
 * round of a run already going. Neither ever deletes a job or clears its
 * cron: a job held back runs again after midnight, and one that was stopped
 * part-way runs again at its next time.
 */
type Budget = { enabled: boolean; dailyUsd: number; runUsd: number };
type Ledger = { day: string; usd: number; runs: number; stopped: number; skipped: number };

export function AutomationCard() {
  const [budget, setBudget] = useState<Budget | null>(null);
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [line, setLine] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await fetch("/api/automation", { headers: { Accept: "application/json" } });
      if (!res.ok) return;
      const body = await res.json();
      setBudget(body?.budget ?? null);
      setLedger(body?.ledger ?? null);
      setLine(typeof body?.line === "string" ? body.line : "");
    } catch {
      /* Nothing to say: the card simply shows what it last had. */
    }
  };

  useEffect(() => {
    let alive = true;
    void load().finally(() => {
      if (alive) setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  const change = (patch: Record<string, unknown>) => {
    setNote(null);
    void (async () => {
      try {
        const res = await fetch("/api/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ automation: patch }),
        });
        if (!res.ok) {
          setNote("That could not be saved.");
          return;
        }
        await load();
      } catch {
        setNote("That could not be saved.");
      }
    })();
  };

  if (!loaded) {
    return (
      <section className="set-card">
        <h3>Automation budget</h3>
        <p className="jf-hint">Reading the settings…</p>
      </section>
    );
  }

  return (
    <section className="set-card">
      <h3>Automation budget</h3>
      <p className="jf-hint">
        A daily cap on what jobs and watchers may spend. A watcher on something that changes often starts a fresh
        session every time it fires. A held-back job runs again after midnight; a stopped run, at its next time.
        Nothing is switched off or deleted.
      </p>

      <label className="opt-check">
        <input
          type="checkbox"
          checked={budget?.enabled !== false}
          onChange={(e) => change({ enabled: e.target.checked })}
        />
        <span>
          Hold automated runs to a budget
          <span className="opt-note">
            Off means jobs run whatever they cost. They still report what they spent.
          </span>
        </span>
      </label>

      {budget?.enabled !== false && (
        <>
          <label className="jf-row is-spaced">
            <span>All jobs, per day</span>
            <input
              type="number"
              min={0.05}
              max={50}
              step={0.05}
              value={budget?.dailyUsd ?? 1}
              onChange={(e) => e.target.value && change({ dailyUsd: Number(e.target.value) })}
            />
          </label>
          <label className="jf-row is-spaced">
            <span>One run</span>
            <input
              type="number"
              min={0.01}
              max={10}
              step={0.05}
              value={budget?.runUsd ?? 0.25}
              onChange={(e) => e.target.value && change({ runUsd: Number(e.target.value) })}
            />
          </label>
          <p className="jf-hint">Both in US dollars.</p>
        </>
      )}

      <p className="jf-hint">
        {line || "Nothing spent today yet."}
        {ledger && ledger.stopped > 0
          ? ` ${ledger.stopped} run${ledger.stopped === 1 ? "" : "s"} stopped part-way today.`
          : ""}
      </p>
      {note && <p className="jf-hint">{note}</p>}
    </section>
  );
}
