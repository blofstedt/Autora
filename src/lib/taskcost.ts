/**
 * What the Usage page says about a task's cost, decided in one place.
 *
 * The server does the arithmetic (server/taskledger.ts); this only decides what
 * to print for it, and never prints a figure the server did not give. A price
 * per good result that is missing is shown as missing, with the reason, not as
 * zero and not as a guess.
 */

export type Mark = "good" | "poor";

export interface TaskCell {
  provider: string;
  label: string;
  model: string;
  /** The planner that worked with `model` (Settings, Roles); absent from an older server. */
  planner?: string | null;
  kind: string;
  kindLabel: string;
  tasks: number;
  unpriced: number;
  spend: number;
  avgCost: number | null;
  judged: number;
  good: number;
  poor: number;
  unjudged: number;
  perGood: number | null;
  goodRate: number | null;
  versions: string[];
}

export interface TaskRow {
  id: string;
  ts: number;
  kind: string;
  kindLabel: string;
  provider: string;
  model: string;
  planner?: string | null;
  version: string;
  cost: number;
  priced: boolean;
  automated: boolean;
  outcome: "running" | "finished" | "failed" | "stopped";
  check: "passed" | "failed" | null;
  mark: Mark | null;
  verdict: Mark | null;
  source: "rated" | "check" | "error" | null;
}

export interface TaskSummary {
  minJudged: number;
  tasks: number;
  versions: string[];
  version: string | null;
  current: string;
  cells: TaskCell[];
  recent: TaskRow[];
}

/** What to print in the "per good result" column, and why when there is no figure. */
export function perGoodText(cell: TaskCell, minJudged: number): { value: "price" | "none" | "unpriced"; why: string } {
  if (cell.unpriced === cell.tasks) return { value: "unpriced", why: "This model has no published price, so its tasks are counted but not priced." };
  if (cell.perGood !== null) {
    return {
      value: "price",
      why: `${cell.good} good of ${cell.judged} judged. Everything the judged tasks cost, divided by how many were good.`,
    };
  }
  if (cell.judged < minJudged) {
    return { value: "none", why: `Needs ${minJudged} judged tasks for a figure; ${cell.judged} so far.` };
  }
  return { value: "none", why: "None of the judged tasks was good, so there is no price for a good one yet." };
}

/** Cells grouped by the kind of work, so models are compared on the same job:
    the kinds with the most tasks first, and in each the cheapest good result
    first, models with no figure after them. */
export function groupByKind(cells: readonly TaskCell[]): { kind: string; label: string; cells: TaskCell[] }[] {
  const groups = new Map<string, { kind: string; label: string; cells: TaskCell[]; tasks: number }>();
  for (const cell of cells) {
    const group = groups.get(cell.kind) ?? { kind: cell.kind, label: cell.kindLabel, cells: [], tasks: 0 };
    group.cells.push(cell);
    group.tasks += cell.tasks;
    groups.set(cell.kind, group);
  }
  const byPrice = (a: TaskCell, b: TaskCell) =>
    (a.perGood ?? Infinity) - (b.perGood ?? Infinity) || b.tasks - a.tasks;
  return [...groups.values()]
    .sort((a, b) => b.tasks - a.tasks || a.label.localeCompare(b.label))
    .map(({ kind, label, cells: inKind }) => ({ kind, label, cells: [...inKind].sort(byPrice) }));
}

/** How a task's verdict reads, and what said so. */
export function verdictText(row: Pick<TaskRow, "verdict" | "source" | "outcome">): string {
  if (!row.verdict) return row.outcome === "stopped" ? "stopped" : "not judged";
  const word = row.verdict === "good" ? "good" : "poor";
  if (row.source === "rated") return `${word}, by you`;
  if (row.source === "check") return `${word}, by your check`;
  return "failed";
}

/** The model a task ran on, as printed: "planner → builder" when a planner took part. */
export function modelLabel(t: { model: string; planner?: string | null }): string {
  return t.planner ? `${t.planner} → ${t.model}` : t.model;
}
