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

export interface TodoItem {
  id: string;
  title: string;
  status: TodoStatus;
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
    items.push({ id: String(items.length + 1), title, status: status ?? "not-started" });
    if (items.length >= MAX_ITEMS) break;
  }
  return items;
}

/** The list as the model reads it back: a checklist with each item's state. */
export function describeTodos(list: TodoList): string {
  if (list.items.length === 0) return "The to-do list is empty.";
  const done = list.items.filter((i) => i.status === "completed").length;
  const mark = { "not-started": "[ ]", "in-progress": "[~]", completed: "[x]" } as const;
  return [
    `To-do list -- ${done} of ${list.items.length} done:`,
    ...list.items.map((i) => `${mark[i.status]} ${i.id}. ${i.title}`),
  ].join("\n");
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
