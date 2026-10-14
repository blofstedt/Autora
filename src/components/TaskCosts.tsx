import { useCallback, useEffect, useState } from "react";
import { IconCheck, IconCoin, IconRepeat, IconX } from "./Icons";
import { money } from "./Billing";
import { groupByKind, modelLabel, perGoodText, verdictText, type Mark, type TaskRow, type TaskSummary } from "../lib/taskcost";

const when = (ts: number) =>
  new Date(ts * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * What a good result costs, by the kind of work and the model that did it.
 *
 * One task is one thing you asked for and everything it took: every model call
 * it made, the look back afterwards included. A task is *good* or *poor* only
 * when something says so -- you, the check you set for your project, or the
 * turn ending in an error -- and a task nothing speaks for is left out of the
 * price rather than counted as good. The price of a good result is everything
 * the judged tasks cost, the poor ones too, over how many were good; it appears
 * once five tasks have been judged, and not before. Nothing here is written to
 * the chat, and an incognito chat is not counted.
 */
export function TaskCosts() {
  const [summary, setSummary] = useState<TaskSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [thisBuild, setThisBuild] = useState(false);

  const load = useCallback(() => {
    setError(null);
    void fetch(`/api/tasks${thisBuild ? "?version=current" : ""}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`the server answered ${r.status}`);
        return r.json() as Promise<TaskSummary>;
      })
      .then(setSummary)
      .catch((cause: unknown) =>
        setError(cause instanceof TypeError ? "Could not reach the server." : `Could not read tasks: ${cause instanceof Error ? cause.message : String(cause)}.`),
      );
  }, [thisBuild]);

  useEffect(load, [load]);

  const mark = useCallback((row: TaskRow, next: Mark) => {
    /* Pressing the mark a task already has takes it back. */
    void fetch(`/api/tasks/${row.id}/mark`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mark: row.mark === next ? null : next }),
    })
      .then((r) => { if (!r.ok) throw new Error(String(r.status)); load(); })
      .catch(() => setError("Could not save that mark."));
  }, [load]);

  if (error) {
    return (
      <section className="set-card">
        <h3>Cost per good result</h3>
        <p className="set-warn">{error}</p>
        <button className="btn ghost" onClick={load}>Try again</button>
      </section>
    );
  }
  if (!summary) {
    return (
      <section className="set-card">
        <h3>Cost per good result</h3>
        <p className="jf-hint">Loading…</p>
      </section>
    );
  }

  const groups = groupByKind(summary.cells);

  return (
    <section className="set-card">
      <div className="bill-head">
        <h3><IconCoin size={12} /> Cost per good result</h3>
        <button className="btn ghost bill-refresh" onClick={load} aria-label="Refresh tasks">
          <IconRepeat size={13} /> Refresh
        </button>
      </div>

      <p className="jf-hint">
        What a good result costs, by kind of work and model. A task counts as good or poor only when you
        mark it, your project check says so, or it ends in an error. Unjudged tasks are left out.
      </p>

      <div className="seg task-scope" role="group" aria-label="Which builds">
        <button className={thisBuild ? "" : "on"} aria-pressed={!thisBuild} onClick={() => setThisBuild(false)}>
          Every build
        </button>
        <button className={thisBuild ? "on" : ""} aria-pressed={thisBuild} onClick={() => setThisBuild(true)}>
          This build only ({summary.current})
        </button>
      </div>

      {groups.length === 0 ? (
        <p className="jf-hint bill-empty">
          No tasks yet{thisBuild ? " on this build" : ""}.
        </p>
      ) : (
        groups.map((group) => (
          <div key={group.kind} className="task-group">
            <h4 className="task-kind">{group.label}</h4>
            {group.cells.map((cell) => {
              const figure = perGoodText(cell, summary.minJudged);
              const mixed = cell.versions.length > 1;
              return (
                <div key={`${cell.provider}/${cell.planner ?? ""}/${cell.model}`} className="task-cell" title={figure.why}>
                  <code className="task-model">{modelLabel(cell)}</code>
                  <span className="task-meta">
                    {count(cell.tasks, "task")}
                    {cell.judged > 0 ? ` · ${cell.good} good, ${cell.poor} poor` : ""}
                    {cell.unjudged > 0 ? ` · ${cell.unjudged} not judged` : ""}
                    {cell.avgCost !== null ? ` · ${money(cell.avgCost)} each` : ""}
                    {mixed ? ` · builds ${cell.versions[0]}–${cell.versions[cell.versions.length - 1]}` : ""}
                  </span>
                  <em className={`task-figure ${figure.value === "price" ? "" : "is-none"}`}>
                    {figure.value === "price" ? money(cell.perGood!) : figure.value === "unpriced" ? "unpriced" : "—"}
                  </em>
                </div>
              );
            })}
          </div>
        ))
      )}

      {summary.recent.length > 0 && (
        <details className="bill-recent">
          <summary>Recent tasks: mark how they went</summary>
          {summary.recent.map((row) => (
            <div key={row.id} className="task-row">
              <span className="bill-turn-when">{when(row.ts)}</span>
              <span className="task-row-kind">{row.kindLabel}{row.automated ? " (scheduled)" : ""}</span>
              <code>{modelLabel(row)}</code>
              <span className={`task-verdict ${row.verdict ? `is-${row.verdict}` : ""}`}>{verdictText(row)}</span>
              <em>{row.priced ? money(row.cost) : "—"}</em>
              <button
                className={`task-mark ${row.mark === "good" ? "on-good" : ""}`}
                aria-label="This went well"
                aria-pressed={row.mark === "good"}
                title="This went well"
                onClick={() => mark(row, "good")}
              >
                <IconCheck size={12} />
              </button>
              <button
                className={`task-mark ${row.mark === "poor" ? "on-poor" : ""}`}
                aria-label="This did not go well"
                aria-pressed={row.mark === "poor"}
                title="This did not go well"
                onClick={() => mark(row, "poor")}
              >
                <IconX size={12} />
              </button>
            </div>
          ))}
        </details>
      )}

      <p className="bill-caveat">
        Cost is every model call in the task, so it can fall short of an invoice (see Billing). The kind of work comes
        from the tools used. {count(summary.tasks, "task")} counted
        {summary.tasks > 0 && `; a price needs ${summary.minJudged} judged tasks per model and kind of work`}.
        {" "}Models with no published price are counted, not priced. Marks skew toward tasks that went very well or very badly.
      </p>
    </section>
  );
}
