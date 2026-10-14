/**
 * What each task cost, and whether it was done well.
 *
 * The spend ledger (state.ts `usage`) is one row per model call, with no idea
 * what the call was for. This is the other half: one record per turn -- a
 * "task" -- holding the money every call made on its behalf, the kind of work
 * it was, and what is known about how it ended. Read together over time they
 * answer "what does a good result cost, on this model, for this kind of work".
 *
 * A figure like that is only worth having if it can be checked, so every part
 * of it is mechanical:
 *
 *  - Cost is the sum of the ledger's own rows for the turn. `AsyncLocalStorage`
 *    carries the task through every `await` of the turn, so a call is billed to
 *    the task that made it: the model's own rounds, the voice, compaction, a
 *    sub-agent and the look back after the turn -- and not a remark or a Threads
 *    post that merely happened at the same time.
 *  - The kind of work is read from the tools the turn called, never guessed by a
 *    model (`kindOfCall`).
 *  - "Done well" is only ever the person's own mark, or a plain-code fact: the
 *    check they set for their project passed or failed, or the turn ended in an
 *    error. A turn with none of those is *unjudged*, and is counted as that --
 *    not as good, and not as poor.
 *
 * Nothing here writes to the chat, and an incognito chat leaves no record.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { isEphemeral } from "./ephemeral";
import { providerSpec } from "./providers";
import { onUsage, type UsageEntry } from "./state";
import { readDoc, saveDoc } from "./store";

// ------------------------------------------------------------------ kinds --

/** In the order a tie between two kinds is broken: a deliverable beats the
    means of making it, and "just talking" is only what is left. */
const KINDS = [
  "documents", "spreadsheets", "presentations", "pdf", "video", "music", "3d", "games", "photo",
  "code", "web", "desktop", "agents", "scheduling", "integrations", "chat",
] as const;
type TaskKind = (typeof KINDS)[number];

const KIND_LABEL: Record<TaskKind, string> = {
  documents: "Documents",
  spreadsheets: "Spreadsheets",
  presentations: "Presentations",
  pdf: "PDF",
  video: "Video",
  music: "Music",
  "3d": "3D",
  games: "Games",
  photo: "Photo and images",
  code: "Code and files",
  web: "Web and research",
  desktop: "Desktop",
  agents: "Agents",
  scheduling: "Scheduling",
  integrations: "Connected services",
  chat: "Conversation",
};

const CODE_TOOLS = new Set([
  "terminal", "edit_file", "read_file", "code_search", "run_background", "background_jobs",
  "background_output", "background_stop", "app_preview", "tool_create", "tool_delete",
]);
const WEB_TOOLS = new Set(["web_search", "http_request", "research"]);
const AGENT_TOOLS = new Set(["agent_run", "agents", "thread"]);
const SCHEDULE_TOOLS = new Set(["schedule", "schedules", "unschedule", "pre_authorise", "pre_authorisations"]);

/** Which Office program a call is about, from the file or the type it names. */
function officeKind(args: Record<string, any>): TaskKind {
  const named = String(args.file ?? args.path ?? args.type ?? args.domain ?? "").toLowerCase();
  if (/xlsx|sheets?\b/.test(named)) return "spreadsheets";
  if (/pptx|slides?\b/.test(named)) return "presentations";
  return "documents";
}

/**
 * The kind of work one tool call is, or null when it says nothing about it:
 * writing to memory, asking the person, keeping a to-do list or loading a
 * manual happen in every kind of task.
 */
export function kindOfCall(name: string, args: Record<string, any> = {}): TaskKind | null {
  if (name.startsWith("office_")) return officeKind(args ?? {});
  if (name.startsWith("pdf_")) return "pdf";
  if (name.startsWith("video_")) return "video";
  if (name.startsWith("studio_")) return "music";
  if (name.startsWith("cad_")) return "3d";
  if (name.startsWith("game_")) return "games";
  if (name.startsWith("photo_") || name === "image_generate") return "photo";
  if (CODE_TOOLS.has(name)) return "code";
  if (name.startsWith("browser_") || WEB_TOOLS.has(name)) return "web";
  if (name.startsWith("computer_")) return "desktop";
  if (AGENT_TOOLS.has(name)) return "agents";
  if (SCHEDULE_TOOLS.has(name)) return "scheduling";
  if (name.startsWith("mcp__") || name === "mcp_offer") return "integrations";
  return null;
}

/** The kind a turn was, from how many calls it made of each: the most, and the
    earlier one in KINDS on a tie. No tool that says anything: a conversation. */
export function kindOfTally(tally: Partial<Record<TaskKind, number>>): TaskKind {
  let best: TaskKind = "chat";
  let most = 0;
  for (const kind of KINDS) {
    const n = tally[kind] ?? 0;
    if (n > most) { best = kind; most = n; }
  }
  return best;
}

// ---------------------------------------------------------------- records --

type Outcome = "running" | "finished" | "failed" | "stopped";
type Mark = "good" | "poor";

interface TaskRecord {
  id: string;
  /** When it began, in seconds since the epoch. */
  ts: number;
  session: string;
  provider: string;
  /** The model the turn was run on. The cost is everything it took, including
      what a cheaper model did for it (compaction, the look back). */
  model: string;
  /** The planner, when a different model planned part of it (server/roles.ts):
      the task was the pair's work, and is priced as the pair. Absent otherwise,
      and on every task recorded before roles existed. */
  planner?: string;
  /** The main model answered a round itself. With a planner, false means the
      planner did all of it (a Plan-mode chat), and the task is the planner's alone. */
  built?: boolean;
  /** Which build of Autora ran it: a model is only comparable against the same
      harness, and the harness changes. */
  version: string;
  /** A schedule or a watcher: nobody was there to say how it went. */
  automated: boolean;
  kind: TaskKind;
  /** Calls made of each kind, which `kind` is read from. */
  tally: Partial<Record<TaskKind, number>>;
  /** Model calls billed to it. */
  calls: number;
  /** USD, as the spend ledger priced each call. */
  cost: number;
  input: number;
  output: number;
  /** False when any call was on a model with no published price: `cost` is then
      short by an unknown amount and the task is left out of the money figures. */
  priced: boolean;
  /** Some call's token counts are our own arithmetic. */
  estimated: boolean;
  ms: number | null;
  outcome: Outcome;
  /** The person's project check, the last time it ran this turn. */
  check: "passed" | "failed" | null;
  /** The person's own word on how it went. */
  mark: Mark | null;
}

/**
 * How it went, when that is known, and what says so.
 *
 * Only three things can say: the person ("rated"), the project check they set
 * ("check"), and the turn ending in an error ("error"). A turn the person
 * stopped, or one that nothing says anything about, is unjudged -- null.
 */
export function verdictOf(t: Pick<TaskRecord, "mark" | "outcome" | "check">):
  { verdict: Mark; source: "rated" | "check" | "error" } | null {
  if (t.mark) return { verdict: t.mark, source: "rated" };
  if (t.outcome === "stopped" || t.outcome === "running") return null;
  if (t.outcome === "failed") return { verdict: "poor", source: "error" };
  if (t.check) return { verdict: t.check === "passed" ? "good" : "poor", source: "check" };
  return null;
}

const KEEP = 3000;

interface Doc { v: 1; tasks: TaskRecord[] }

const loaded = readDoc<Doc>("tasks");
const records: TaskRecord[] = Array.isArray(loaded?.tasks) ? loaded!.tasks.filter(sane) : [];
const byId = new Map<string, TaskRecord>();
for (const rec of records) {
  /* The server stopped while this was running: it was cut short. */
  if (rec.outcome === "running") rec.outcome = "stopped";
  byId.set(rec.id, rec);
}

function sane(rec: any): rec is TaskRecord {
  return Boolean(rec) && typeof rec.id === "string" && typeof rec.ts === "number" &&
    typeof rec.cost === "number" && Number.isFinite(rec.cost) && typeof rec.kind === "string" &&
    (KINDS as readonly string[]).includes(rec.kind) && typeof rec.model === "string" &&
    typeof rec.provider === "string";
}

const save = () => saveDoc("tasks", () => ({ v: 1, tasks: records } satisfies Doc));

// -------------------------------------------------------------- recording --

const scope = new AsyncLocalStorage<{ id: string }>();

/**
 * Begin a task. Returns its id, or null for an incognito chat, which leaves
 * nothing behind (its spend is still on the spend ledger, with no chat named).
 */
export function openTask(init: {
  session: string; provider: string; model: string; version: string; automated: boolean;
}): string | null {
  if (isEphemeral(init.session)) return null;
  const rec: TaskRecord = {
    id: `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    ts: Math.floor(Date.now() / 1000),
    session: init.session,
    provider: init.provider,
    model: init.model,
    version: init.version,
    automated: init.automated,
    kind: "chat",
    tally: {},
    calls: 0, cost: 0, input: 0, output: 0,
    priced: true, estimated: false,
    ms: null, outcome: "running", check: null, mark: null,
  };
  records.push(rec);
  byId.set(rec.id, rec);
  while (records.length > KEEP) byId.delete(records.shift()!.id);
  save();
  return rec.id;
}

/** Run `fn` as the task: every call it makes, however deep, is billed to it. */
export function withTask<T>(id: string | null, fn: () => T): T {
  return id ? scope.run({ id }, fn) : fn();
}

const current = () => {
  const id = scope.getStore()?.id;
  return id ? byId.get(id) ?? null : null;
};

/** A tool call the task made. */
export function noteCall(name: string, args: Record<string, any> = {}) {
  const rec = current();
  if (!rec) return;
  const kind = kindOfCall(name, args);
  if (!kind) return;
  rec.tally[kind] = (rec.tally[kind] ?? 0) + 1;
  rec.kind = kindOfTally(rec.tally);
  save();
}

/** A round of the task's own work ran: on the planner (a model other than the
    main one), or on the main model. The voice and background calls are not rounds. */
export function noteRound(model: string, planner: boolean) {
  const rec = current();
  if (!rec || !model) return;
  if (planner ? rec.planner === model : rec.built) return;
  if (planner) rec.planner = model; else rec.built = true;
  save();
}

/** Which model, or pair, a task is filed under: the pair only when both worked. */
function workedBy(rec: TaskRecord): { model: string; planner: string | null } {
  if (!rec.planner) return { model: rec.model, planner: null };
  if (!rec.built) return { model: rec.planner, planner: null };
  return { model: rec.model, planner: rec.planner };
}

/** The project's own check ran, and passed or did not. The last run stands. */
export function noteCheck(ok: boolean) {
  const rec = current();
  if (!rec) return;
  rec.check = ok ? "passed" : "failed";
  save();
}

/** The turn is over. What it cost goes on arriving until the look back is done. */
export function closeTask(id: string | null, outcome: Exclude<Outcome, "running">, ms: number) {
  const rec = id ? byId.get(id) : null;
  if (!rec || rec.outcome !== "running") return;
  rec.outcome = outcome;
  rec.ms = Math.max(0, Math.round(ms));
  save();
}

/** The person's word on a task; null takes it back. */
export function markTask(id: string, mark: Mark | null): boolean {
  const rec = byId.get(id);
  if (!rec) return false;
  rec.mark = mark;
  save();
  return true;
}

/** Every priced row the ledger writes, billed to the task that is making it. */
onUsage((entry: UsageEntry) => {
  const rec = current();
  if (!rec) return;
  rec.calls += 1;
  rec.cost += entry.cost;
  rec.input += entry.input;
  rec.output += entry.output;
  if (!entry.priced) rec.priced = false;
  if (entry.estimated) rec.estimated = true;
  save();
});

// ---------------------------------------------------------------- reading --

/** Fewest judged tasks a cell needs before it gives a figure. Below it, three
    tasks of which one went badly is an anecdote, and printing a price for it
    would be a claim the data cannot back. */
export const MIN_JUDGED = 5;

interface Cell {
  provider: string;
  label: string;
  model: string;
  /** The planner that worked with `model`, or null for the model alone. */
  planner: string | null;
  kind: TaskKind;
  kindLabel: string;
  /** Finished tasks of this kind on this model. */
  tasks: number;
  /** Of them, on a model with no published price: counted, not priced. */
  unpriced: number;
  /** Money spent on the priced ones, and what one costs on average. */
  spend: number;
  avgCost: number | null;
  /** Priced tasks something could say how they went, and how it went. */
  judged: number;
  good: number;
  poor: number;
  /** Priced tasks nothing said anything about. */
  unjudged: number;
  /** Everything the judged tasks cost, over how many of them were good: what a
      good result costs here, the poor ones' money included. Null below
      MIN_JUDGED judged tasks, or with no good result yet. */
  perGood: number | null;
  goodRate: number | null;
  /** The builds the tasks ran on, oldest first. More than one means the cell
      mixes harnesses. */
  versions: string[];
}

interface TaskRow {
  id: string;
  ts: number;
  kind: TaskKind;
  kindLabel: string;
  provider: string;
  model: string;
  planner: string | null;
  version: string;
  cost: number;
  priced: boolean;
  automated: boolean;
  outcome: Outcome;
  check: "passed" | "failed" | null;
  mark: Mark | null;
  verdict: Mark | null;
  source: "rated" | "check" | "error" | null;
}

const RECENT = 25;

const versionOrder = (a: string, b: string) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
};

export function taskSummary(opts: { version?: string | null } = {}) {
  const all = records.filter((r) => r.outcome !== "running");
  const versions = [...new Set(all.map((r) => r.version))].sort(versionOrder);
  const use = opts.version ? all.filter((r) => r.version === opts.version) : all;

  const cells = new Map<string, Cell & { _judgedSpend: number; _v: Set<string> }>();
  for (const rec of use) {
    const by = workedBy(rec);
    const key = `${rec.provider}\u0000${by.planner ?? ""}\u0000${by.model}\u0000${rec.kind}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = {
        provider: rec.provider, label: providerSpec(rec.provider)?.label ?? rec.provider,
        model: by.model, planner: by.planner, kind: rec.kind, kindLabel: KIND_LABEL[rec.kind],
        tasks: 0, unpriced: 0, spend: 0, avgCost: null, judged: 0, good: 0, poor: 0, unjudged: 0,
        perGood: null, goodRate: null, versions: [], _judgedSpend: 0, _v: new Set(),
      };
      cells.set(key, cell);
    }
    cell.tasks += 1;
    cell._v.add(rec.version);
    if (!rec.priced) { cell.unpriced += 1; continue; }
    cell.spend += rec.cost;
    const said = verdictOf(rec);
    if (!said) { cell.unjudged += 1; continue; }
    cell.judged += 1;
    cell._judgedSpend += rec.cost;
    if (said.verdict === "good") cell.good += 1; else cell.poor += 1;
  }

  const out: Cell[] = [...cells.values()].map(({ _judgedSpend, _v, ...cell }) => {
    const priced = cell.tasks - cell.unpriced;
    return {
      ...cell,
      avgCost: priced > 0 ? cell.spend / priced : null,
      perGood: cell.judged >= MIN_JUDGED && cell.good > 0 ? _judgedSpend / cell.good : null,
      goodRate: cell.judged > 0 ? cell.good / cell.judged : null,
      versions: [..._v].sort(versionOrder),
    };
  }).sort((a, b) => b.spend - a.spend || b.tasks - a.tasks);

  const rows: TaskRow[] = use.slice(-RECENT).reverse().map((r) => {
    const said = verdictOf(r);
    return {
      id: r.id, ts: r.ts, kind: r.kind, kindLabel: KIND_LABEL[r.kind], provider: r.provider,
      ...workedBy(r), version: r.version, cost: r.cost, priced: r.priced, automated: r.automated,
      outcome: r.outcome, check: r.check, mark: r.mark,
      verdict: said?.verdict ?? null, source: said?.source ?? null,
    };
  });

  return {
    currency: "USD",
    minJudged: MIN_JUDGED,
    tasks: use.length,
    versions,
    version: opts.version ?? null,
    cells: out,
    recent: rows,
  };
}
