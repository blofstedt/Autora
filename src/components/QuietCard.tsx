import { useEffect, useState } from "react";

/**
 * When the agent keeps its own initiative to itself.
 *
 * Everything else on this page is about the agent doing more without being
 * asked: jobs that outlive the turn, schedules that watch things, agreements
 * that stop the same question coming twice. The failure mode of all of it is
 * one arrival at the wrong hour -- a build notice at 03:40, a suggestion
 * nobody asked for over breakfast. This is the two times that bound it.
 *
 * What waits is only what the agent started on its own account: the briefing
 * about a job that finished, a note it wanted to leave, work it decided to
 * begin. A question asked at 03:40 is still answered at 03:40, and a schedule
 * you set still runs at the time you set it -- that was you asking. Nothing
 * inside the window is thrown away either: the next thing you say carries it.
 */
type Proactivity = { quiet: boolean; from: number; to: number };

async function load(): Promise<Proactivity | null> {
  try {
    const res = await fetch("/api/settings", { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    return (await res.json())?.proactivity ?? null;
  } catch {
    return null;
  }
}

async function save(patch: Record<string, unknown>): Promise<Proactivity | null> {
  try {
    const res = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ proactivity: patch }),
    });
    if (!res.ok) return null;
    return (await res.json())?.proactivity ?? null;
  } catch {
    return null;
  }
}

/** Minutes since midnight as "23:00", which is what a time input wants. */
function clock(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export function QuietCard() {
  const [state, setState] = useState<Proactivity | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void load().then((found) => {
      if (!alive) return;
      setState(found);
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  const change = (patch: Record<string, unknown>) => {
    setNote(null);
    void save(patch).then((next) => {
      if (next) setState(next);
      else setNote("That could not be saved.");
    });
  };

  if (!loaded) {
    return (
      <section className="set-card">
        <h3>Quiet hours</h3>
        <p className="jf-hint">Reading the settings…</p>
      </section>
    );
  }

  const same = state && state.from === state.to;

  return (
    <section className="set-card">
      <h3>Quiet hours</h3>
      <p className="jf-hint">
        When the agent leaves its own initiative alone. Anything it started on its own account — a
        note about a job that has finished, work it decided to begin — is held until the window is
        over, then carried by the next thing you say. Questions you ask inside the window are still
        answered, and schedules you set still run at the time you set them.
      </p>

      <label style={{ display: "flex", gap: 9, alignItems: "flex-start", margin: "7px 0", fontSize: "calc(12.5px * var(--ts, 1))", lineHeight: 1.5 }}>
        <input
          type="checkbox"
          checked={state?.quiet === true}
          onChange={(e) => change({ quiet: e.target.checked })}
        />
        <span>
          Hold the agent's own initiative between two times
          <span style={{ display: "block", color: "var(--text-3)", fontSize: "calc(11.5px * var(--ts, 1))" }}>
            Off means it can speak up at any hour.
          </span>
        </span>
      </label>

      {state?.quiet && (
        <>
          <label className="jf-row" style={{ marginTop: 10 }}>
            <span>From</span>
            <input
              type="time"
              value={clock(state.from)}
              onChange={(e) => e.target.value && change({ from: e.target.value })}
            />
          </label>
          <label className="jf-row" style={{ marginTop: 10 }}>
            <span>To</span>
            <input
              type="time"
              value={clock(state.to)}
              onChange={(e) => e.target.value && change({ to: e.target.value })}
            />
          </label>
          <p className="jf-hint">
            {same
              ? "These are the same time, so there is no window: the agent can speak up at any hour."
              : `Your local clock: ${clock(state.from)} to ${clock(state.to)}${state.from > state.to ? ", over midnight" : ""}.`}
          </p>
        </>
      )}

      {note && <p className="jf-hint">{note}</p>}
    </section>
  );
}
