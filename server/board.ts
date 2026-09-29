/**
 * The task board: the cards the person watches the work move through.
 *
 * A long job is a plan the person can see rather than a paragraph they have to
 * read: what is going to happen, what is happening now, what is finished. The
 * agent writes the cards before it starts and moves them as it goes, so the
 * board is the shape of the work, and it is right by itself -- no meeting about
 * what to do next.
 *
 * Everything here is pure: a board in, a board out. The event is what the page
 * watches (kanban.update), and this decides what the event says and what the
 * agent is told came back. The types match src/lib/derive.ts, which is the side
 * that draws it: KanbanBoard, KanbanTask and the three columns.
 *
 * Kept out of server.ts so the same rules serve both writers -- the tool the
 * agent calls, and the route the page posts to when a card is dragged.
 */

export type BoardStatus = "todo" | "doing" | "done";

export interface BoardTask {
  id: string;
  title: string;
  status: BoardStatus;
  notes?: string;
  tag?: string;
  progress?: number;
  subtasks?: { id?: string; title: string; done: boolean }[];
}

export interface Board {
  id: string;
  title: string;
  tasks: BoardTask[];
  autonomous: boolean;
  activeTaskId?: string | null;
}

/** A board as it was last written down, from the session's own events. */
export interface BoardEvent {
  kind: string;
  payload: Record<string, any>;
}

export interface BoardResult {
  ok: boolean;
  /** What the model is told came back: the board, and what changed on it. */
  summary: string;
  /** The board to write down, when there is one to write. */
  board?: Board;
  /** What the transcript card says, where it differs. */
  preview?: string;
}

const TITLES: Record<BoardStatus, string> = {
  todo: "To do",
  doing: "Doing",
  done: "Done",
};

/**
 * The three columns, from whatever the model called them.
 *
 * An agent reaching for a card says "in progress", "started", "working on it",
 * "finished", "complete" -- all of them mean one of the three, and refusing
 * them would be pedantry the plan does not survive. Nothing is guessed: a word
 * that means none of them is refused, with the three that work.
 */
export function statusOf(value: unknown): BoardStatus | null {
  const text = String(value ?? "").trim().toLowerCase().replace(/[_-]+/g, " ");
  if (!text) return null;
  if (/^(todo|to do|to-do|backlog|queued|pending|next|planned|not started)$/.test(text)) return "todo";
  if (/^(doing|in progress|inprogress|progress|active|started|starting|working|working on it|now|running)$/.test(text)) return "doing";
  if (/^(done|complete|completed|finished|closed|shipped|resolved|ok)$/.test(text)) return "done";
  return null;
}

export function emptyBoard(title = "Plan", id = "board-main"): Board {
  return { id, title: title.trim() || "Plan", tasks: [], autonomous: true, activeTaskId: null };
}

/** The last board written down in this session, or nothing if there is none. */
export function latestBoard(events: readonly BoardEvent[]): Board | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.kind !== "kanban.update") continue;
    const payload = event.payload ?? {};
    return {
      id: String(payload.id ?? "board-main"),
      title: String(payload.title ?? "Plan"),
      tasks: Array.isArray(payload.tasks) ? payload.tasks.map(readTask) : [],
      autonomous: payload.autonomous === undefined ? true : Boolean(payload.autonomous),
      activeTaskId: payload.activeTaskId ?? null,
    };
  }
  return null;
}

function readTask(raw: any, index: number): BoardTask {
  const status = statusOf(raw?.status) ?? "todo";
  return {
    id: String(raw?.id ?? `t${index + 1}`),
    title: String(raw?.title ?? "").trim() || "(untitled)",
    status,
    ...(raw?.notes ? { notes: String(raw.notes) } : {}),
    ...(raw?.tag ? { tag: String(raw.tag) } : {}),
    ...(raw?.progress !== undefined && Number.isFinite(Number(raw.progress))
      ? { progress: Number(raw.progress) }
      : {}),
    ...(Array.isArray(raw?.subtasks)
      ? {
        subtasks: raw.subtasks.map((s: any) => ({
          ...(s?.id ? { id: String(s.id) } : {}),
          title: String(s?.title ?? "").trim() || "(untitled)",
          done: Boolean(s?.done),
        })),
      }
      : {}),
  };
}

/** The next card id, so ids stay short and readable: t1, t2, t3. */
function nextId(tasks: readonly BoardTask[]): string {
  let highest = 0;
  for (const task of tasks) {
    const match = /^t(\d+)$/.exec(task.id);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `t${highest + 1}`;
}

/**
 * One card, from the words the model used for it.
 *
 * A reference may be an id, or the card's title -- whole, or part of it. Part
 * of it only counts when it picks out one card: two cards that both contain
 * "email" is an ambiguity to be settled, not a coin to be flipped, so the
 * agent is told which ones it might have meant.
 */
function findTask(
  tasks: readonly BoardTask[],
  reference: unknown,
): { task: BoardTask } | { error: string } {
  const wanted = String(reference ?? "").trim();
  if (!wanted) return { error: "Name the card: its id (t3) or its title." };
  const lower = wanted.toLowerCase();

  const byId = tasks.find((t) => t.id.toLowerCase() === lower);
  if (byId) return { task: byId };

  const exact = tasks.filter((t) => t.title.toLowerCase() === lower);
  if (exact.length === 1) return { task: exact[0] };
  if (exact.length > 1) {
    return { error: `More than one card is called "${wanted}": ${exact.map((t) => t.id).join(", ")}. Use an id.` };
  }

  const partial = tasks.filter((t) => t.title.toLowerCase().includes(lower));
  if (partial.length === 1) return { task: partial[0] };
  if (partial.length > 1) {
    return {
      error: `"${wanted}" matches ${partial.length} cards: ` +
        `${partial.map((t) => `${t.id} (${t.title})`).join("; ")}. Use an id.`,
    };
  }
  return {
    error: tasks.length
      ? `There is no card called "${wanted}". On the board: ${tasks.map((t) => `${t.id} (${t.title})`).join("; ")}.`
      : "The board has no cards on it yet.",
  };
}

/**
 * The board as the model reads it.
 *
 * Ids are in it because that is how a card is moved, and the status counts are
 * in it because "how far along am I" is the question a plan gets asked. The
 * titles are not cut short: a card is one line the person wrote the work out
 * in, and a plan nobody can read is not a plan.
 */
export function describeBoard(board: Board): string {
  const counts = (status: BoardStatus) => board.tasks.filter((t) => t.status === status).length;
  const head =
    `Board: ${board.title} -- ${board.tasks.length} card${board.tasks.length === 1 ? "" : "s"} ` +
    `(${counts("todo")} to do, ${counts("doing")} doing, ${counts("done")} done).`;
  if (board.tasks.length === 0) return `${head}\nNothing on it yet.`;
  const lines: string[] = [];
  for (const status of ["todo", "doing", "done"] as BoardStatus[]) {
    const inColumn = board.tasks.filter((t) => t.status === status);
    if (inColumn.length === 0) continue;
    lines.push(`${TITLES[status]}:`);
    for (const task of inColumn) {
      const notes = task.notes ? ` -- ${task.notes}` : "";
      const progress = task.progress !== undefined ? ` (${Math.round(task.progress)}%)` : "";
      const subs = task.subtasks?.length
        ? ` [${task.subtasks.filter((s) => s.done).length}/${task.subtasks.length} sub-steps]`
        : "";
      lines.push(`  ${task.id}. ${task.title}${progress}${subs}${notes}`);
    }
  }
  return [head, ...lines].join("\n");
}

/**
 * What the agent asked for, done to the board.
 *
 * Writes are whole: the board comes back complete every time, because that is
 * what the page is handed and what is written down for the next turn to read.
 * Nothing here throws -- a call that cannot be carried out comes back as a
 * sentence saying why, which is what the model has to work with either way.
 */
export function applyBoard(current: Board | null, action: Record<string, any>): BoardResult {
  const what = String(action?.action ?? "").trim().toLowerCase().replace(/[_-]+/g, " ");
  const base = current ?? emptyBoard();

  /* What the board is called. The first write names it; "the plan" is what it
     is called if nobody said, which is what it is. */
  const title = String(action?.title ?? "").trim();
  const board: Board = { ...base, id: base.id || "board-main", autonomous: true };
  if (title) board.title = title;

  switch (what) {
    case "plan":
    case "set":
    case "replace": {
      const raw = Array.isArray(action?.tasks)
        ? action.tasks
        : Array.isArray(action?.cards)
          ? action.cards
          : [];
      if (raw.length === 0) {
        return {
          ok: false,
          summary: "A plan needs its cards: pass tasks as a list, each a title or {title, status}.",
        };
      }
      const tasks: BoardTask[] = [];
      raw.forEach((entry: any, index: number) => {
        const text = typeof entry === "string" ? entry : String(entry?.title ?? "");
        const clean = text.trim();
        if (!clean) return;
        tasks.push({
          id: `t${index + 1}`,
          title: clean,
          status: statusOf(typeof entry === "object" ? entry?.status : null) ?? "todo",
          ...(typeof entry === "object" && entry?.tag ? { tag: String(entry.tag) } : {}),
        });
      });
      if (tasks.length === 0) {
        return { ok: false, summary: "None of those cards had a title, so nothing was put on the board." };
      }
      board.tasks = tasks;
      board.activeTaskId = null;
      return {
        ok: true,
        board,
        summary: `${describeBoard(board)}\n\nThe board is on the page now, in the conversation, and the cards are in To do. Move each to doing as you start it and to done when it is finished, so what the person sees matches what is happening.`,
        preview: `${tasks.length} card${tasks.length === 1 ? "" : "s"} planned`,
      };
    }

    case "add":
    case "card": {
      const text = String(action?.task ?? action?.title_of_task ?? action?.text ?? "").trim();
      /* "add" is also how a plan is extended, so `task` may be a title or a
         list of them; a list is easier to write than three calls. */
      const many = Array.isArray(action?.tasks) ? action.tasks : null;
      const titles = many
        ? many.map((entry: any) => (typeof entry === "string" ? entry : String(entry?.title ?? ""))).map((t) => t.trim()).filter(Boolean)
        : text
          ? [text]
          : [];
      if (titles.length === 0) return { ok: false, summary: "A card needs a title." };
      const status = statusOf(action?.status) ?? "todo";
      const tasks = [...board.tasks];
      for (const one of titles) {
        tasks.push({ id: nextId(tasks), title: one, status });
      }
      board.tasks = tasks;
      return {
        ok: true,
        board,
        summary: `Added ${titles.length === 1 ? `"${titles[0]}"` : `${titles.length} cards`} to ${TITLES[status]}.\n\n${describeBoard(board)}`,
        preview: titles.length === 1 ? `card: ${titles[0]}` : `${titles.length} cards added`,
      };
    }

    case "move":
    case "start":
    case "finish":
    case "done": {
      const wanted = what === "start" ? "doing" : what === "done" || what === "finish" ? "done" : statusOf(action?.status);
      /* "done" reaches here as a whole-board call too: mark everything done. */
      if (what === "done" && !action?.task && !action?.id) {
        const tasks = board.tasks.map((t) => ({ ...t, status: "done" as BoardStatus }));
        board.tasks = tasks;
        board.activeTaskId = null;
        return { ok: true, board, summary: `Every card is in Done.\n\n${describeBoard(board)}`, preview: "all cards done" };
      }
      const status = wanted ?? statusOf(action?.status);
      if (!status) {
        return { ok: false, summary: "Say where it is going: status is todo, doing or done." };
      }
      const found = findTask(board.tasks, action?.task ?? action?.id ?? action?.title_of_task);
      if ("error" in found) return { ok: false, summary: found.error };
      const tasks = board.tasks.map((t) => (t.id === found.task.id ? { ...t, status } : t));
      board.tasks = tasks;
      if (status === "doing") board.activeTaskId = found.task.id;
      if (status === "done" && board.activeTaskId === found.task.id) board.activeTaskId = null;
      const notes = String(action?.notes ?? "").trim();
      if (notes) {
        board.tasks = board.tasks.map((t) => (t.id === found.task.id ? { ...t, notes } : t));
      }
      return {
        ok: true,
        board,
        summary: `"${found.task.title}" is in ${TITLES[status]}.\n\n${describeBoard(board)}`,
        preview: `${status}: ${found.task.title}`,
      };
    }

    case "note":
    case "notes": {
      const found = findTask(board.tasks, action?.task ?? action?.id ?? action?.title_of_task);
      if ("error" in found) return { ok: false, summary: found.error };
      const notes = String(action?.notes ?? action?.text ?? "").trim();
      board.tasks = board.tasks.map((t) => (t.id === found.task.id ? { ...t, notes } : t));
      return {
        ok: true,
        board,
        summary: `Noted on "${found.task.title}": ${notes || "(nothing)"}.\n\n${describeBoard(board)}`,
        preview: `noted: ${found.task.title}`,
      };
    }

    case "read":
    case "show":
    case "list":
      return { ok: true, board: board.tasks.length ? board : (current ?? undefined), summary: describeBoard(board) };

    case "clear": {
      board.tasks = [];
      board.activeTaskId = null;
      return { ok: true, board, summary: "The board is empty.", preview: "board cleared" };
    }

    default:
      return {
        ok: false,
        summary:
          `Unknown action "${what || "(none)"}". Use plan (write the cards), add, move ` +
          "(status: todo, doing, done), note, show or clear.",
      };
  }
}
