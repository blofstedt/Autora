/**
 * The to-do list: the plan the person watches instead of reading.
 *
 * A long job is a checklist the person can see rather than a paragraph they
 * have to read: what is left, what is happening now, what is finished. The
 * agent writes the list before it starts and rewrites it as it goes, one item
 * in progress at a time, so the list is the shape of the work.
 *
 * The write is always the whole list, the way an editor's agent does it: the
 * model says what the list is now, and there is no second writer to
 * disagree with. Everything here is pure -- a list in, a list out. The event
 * is what the page watches (todo.update), and this decides what it says and
 * what the agent is told came back. The types match src/lib/derive.ts.
 */

export type TodoStatus = "not-started" | "in-progress" | "completed";

/**
 * One piece of an item: the steps a card is made of.
 *
 * Often the work on a card is not this agent's -- it is handed to one of the
 * others (Sabrina on the repository, Trevor on what is true today, Victor on a
 * release) -- so a step can say whose it is. That is a name, not a link: the
 * list says who is doing it, and the agent is still started, watched and
 * reported on the way it always was.
 */
export interface TodoSubtask {
  title: string;
  /** The agent this step belongs to, when it was handed to one. */
  agent?: string;
  status: TodoStatus;
}

export interface TodoItem {
  id: string;
  title: string;
  status: TodoStatus;
  /** The steps under this item, when it has any. Left off an item that has
      none, so a card written before subtasks existed is unchanged. */
  subtasks?: TodoSubtask[];
}

export interface TodoList {
  items: TodoItem[];
}

export interface TodoEvent {
  kind: string;
  payload: Record<string, any>;
}

export interface TodoResult {
  ok: boolean;
  /** What the model is told came back: the list as it now stands. */
  summary: string;
  /** The list to write down, when there is one. */
  list?: TodoList;
  /** What the transcript card says, where it differs. */
  preview?: string;
}

const MAX_ITEMS = 40;
const MAX_TITLE = 200;
/** Enough steps to say what a card is made of without turning one card into a
    list of its own. Past this the rest are dropped rather than refused: the
    item is still a real item. */
const MAX_SUBTASKS = 20;
/** A name, not a biography. */
const MAX_AGENT = 60;

/**
 * The three states, from whatever the model called them.
 *
 * An agent reaching for a status says "in progress", "doing", "done",
 * "finished" -- all mean one of the three, and refusing them would be
 * pedantry the list does not survive. A word that means none of them is
 * `null`, and the caller says which three work.
 */
export function statusOf(value: unknown): TodoStatus | null {
  const text = String(value ?? "").trim().toLowerCase().replace(/[_\s]+/g, "-");
  if (!text) return null;
  if (/^(not-started|todo|to-do|pending|queued|planned|next|backlog|open)$/.test(text)) return "not-started";
  if (/^(in-progress|inprogress|progress|doing|active|started|starting|working|working-on-it|now|running)$/.test(text)) {
    return "in-progress";
  }
  if (/^(completed|complete|done|finished|closed|shipped|resolved|ok)$/.test(text)) return "completed";
  return null;
}

/** The last list written down in this session, or nothing if there is none.
    A session recorded before the to-do list existed wrote its plan as a board;
    it reads back as the list it would have been. */
export function latestTodos(events: readonly TodoEvent[]): TodoList | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.kind === "todo.update") return { items: readItems(event.payload?.items) };
    if (event.kind === "kanban.update") return { items: readItems(event.payload?.tasks) };
  }
  return null;
}

/** Items as the page and the model both need them: numbered, titled, with a
    state. Anything else that came with them is dropped. */
export function readItems(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) return [];
  const items: TodoItem[] = [];
  for (const entry of raw) {
    const text = typeof entry === "string" ? entry : String((entry as any)?.title ?? (entry as any)?.text ?? "");
    const title = text.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
    if (!title) continue;
    const status = typeof entry === "object" ? statusOf((entry as any)?.status) : null;
    const item: TodoItem = { id: String(items.length + 1), title, status: status ?? "not-started" };
    const subtasks = readSubtasks((entry as any)?.subtasks, item.status);
    /* Left off entirely when there are none: a card with no steps has no
       subtasks key at all, exactly as it did before any of this existed. */
    if (subtasks.length > 0) item.subtasks = subtasks;
    items.push(item);
    if (items.length >= MAX_ITEMS) break;
  }
  return items;
}

/**
 * The steps under one item, as the page and the model both need them.
 *
 * A step is either a string or {title, agent?, status?}, so an agent in a hurry
 * can write the steps as a plain list of what has to be done and add a name
 * only where there is one. A step's state moves with the card's: a card that is
 * completed has finished everything on it, whatever its steps were left saying,
 * because the card is the thing the person ticks. A card that is not started
 * but whose steps say some of them are done is left as it says -- steps get
 * done before the card is ticked, not after.
 */
export function readSubtasks(raw: unknown, parentStatus: TodoStatus = "not-started"): TodoSubtask[] {
  if (!Array.isArray(raw)) return [];
  const out: TodoSubtask[] = [];
  for (const entry of raw) {
    if (out.length >= MAX_SUBTASKS) break;
    const text = typeof entry === "string"
      ? entry
      : String((entry as any)?.title ?? (entry as any)?.text ?? (entry as any)?.task ?? "");
    const title = text.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
    if (!title) continue;
    const named = typeof entry === "object" && entry ? (entry as any)?.agent ?? (entry as any)?.who : "";
    const agent = String(named ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_AGENT);
    const status = typeof entry === "object" ? statusOf((entry as any)?.status) : null;
    const step: TodoSubtask = { title, status: status ?? "not-started" };
    if (agent) step.agent = agent;
    out.push(step);
  }
  if (parentStatus === "completed") for (const step of out) step.status = "completed";
  return out;
}

/** The list as the model reads it back: a checklist with each item's state,
    and the steps under an item indented beneath it, each saying whose it is. */
export function describeTodos(list: TodoList): string {
  if (list.items.length === 0) return "The to-do list is empty.";
  const done = list.items.filter((i) => i.status === "completed").length;
  const mark = { "not-started": "[ ]", "in-progress": "[~]", completed: "[x]" } as const;
  const lines: string[] = [];
  for (const item of list.items) {
    lines.push(`${mark[item.status]} ${item.id}. ${item.title}`);
    (item.subtasks ?? []).forEach((step, index) => {
      const who = step.agent ? ` (${step.agent})` : "";
      lines.push(`    ${mark[step.status]} ${item.id}.${index + 1} ${step.title}${who}`);
    });
  }
  return [`To-do list -- ${done} of ${list.items.length} done:`, ...lines].join("\n");
}

/**
 * What the agent asked for, done to the list.
 *
 * `todos` is the whole list as it now stands. Nothing throws: a call that
 * cannot be carried out comes back as a sentence saying why, which is what the
 * model has to work with either way. More than one item in progress is kept
 * (it may be true) but mentioned, because a list that says three things are
 * happening at once has stopped saying where the work is.
 */
export function applyTodos(current: TodoList | null, action: Record<string, any>): TodoResult {
  const raw = action?.todos ?? action?.items ?? action?.tasks ?? action?.todoList;
  if (raw === undefined && !action?.clear) {
    return {
      ok: true,
      summary: current ? describeTodos(current) : "The to-do list is empty.",
    };
  }
  if (action?.clear === true || (Array.isArray(raw) && raw.length === 0)) {
    return { ok: true, list: { items: [] }, summary: "The to-do list is empty.", preview: "list cleared" };
  }
  if (!Array.isArray(raw)) {
    return { ok: false, summary: "Pass todos as a list of {title, status}, the whole list as it now stands." };
  }
  const unknown = raw.find(
    (e: any) => e && typeof e === "object" && e.status !== undefined && statusOf(e.status) === null,
  );
  if (unknown) {
    return {
      ok: false,
      summary: `"${String(unknown.status)}" is not a status. Use not-started, in-progress or completed.`,
    };
  }
  /* A step's status is checked the way an item's is: a word meaning none of the
     three is said so, rather than quietly read as not started. */
  const badStep = raw.find(
    (e: any) =>
      e && typeof e === "object" && Array.isArray(e.subtasks) &&
      e.subtasks.some(
        (s: any) => s && typeof s === "object" && s.status !== undefined && statusOf(s.status) === null,
      ),
  );
  if (badStep) {
    const step = (badStep as any).subtasks.find(
      (s: any) => s && typeof s === "object" && s.status !== undefined && statusOf(s.status) === null,
    );
    return {
      ok: false,
      summary: `"${String(step.status)}" is not a status for a subtask either. Use not-started, in-progress or completed.`,
    };
  }
  const items = readItems(raw);
  if (items.length === 0) return { ok: false, summary: "None of those items had a title." };

  const list = { items };
  const doing = items.filter((i) => i.status === "in-progress").length;
  const done = items.filter((i) => i.status === "completed").length;
  const note = doing > 1
    ? `\n\nNote: ${doing} items are in progress. Keep one in progress at a time, and mark it completed the moment it is finished.`
    : "";
  return {
    ok: true,
    list,
    summary: `${describeTodos(list)}${note}`,
    preview: `${done} of ${items.length} done`,
  };
}

/**
 * What every turn is told about this chat's list.
 *
 * The conversation the model reads back carries words, not tool calls, so
 * without this the list it wrote last turn is gone by the next one: it either
 * forgot to tick items it then finished, or -- in a chat that has never had a
 * list -- wrote one from a plan it remembered from somewhere else. A new chat
 * is said to have an empty list in so many words.
 */
export function todoBriefing(list: TodoList | null): string {
  if (!list || list.items.length === 0) {
    return "This chat's to-do list is empty. Nothing carries over from another chat: " +
      "if this task needs a list, write a new one for it with todo.";
  }
  const open = list.items.filter((i) => i.status !== "completed").length;
  return [
    describeTodos(list),
    open === 0
      ? "Every item is completed. A new task gets a new list: write it with todo, replacing this one."
      : "This is the list as it stands. Keep it true: mark each item completed with todo the moment it is " +
        "finished. If the person has moved on to something else, replace the list rather than adding to it.",
  ].join("\n");
}

/**
 * The reminder for a turn that is about to end with items still open, or null
 * when the list says the work is finished. The agent is asked once: it may
 * have finished and not ticked them, or stopped early, and only it knows which.
 */
export function unfinishedTodos(list: TodoList | null): string | null {
  if (!list) return null;
  const open = list.items.filter((i) => i.status !== "completed");
  if (open.length === 0) return null;
  return [
    `(Autora: the to-do list still shows ${open.length} of ${list.items.length} items not completed:`,
    ...open.map((i) => `- ${i.id}. ${i.title} (${i.status})`),
    "If they are done, mark them completed with todo now. If not, carry on with them, " +
      "or take them off the list and say in your reply why they are left.)",
  ].join("\n");
}
