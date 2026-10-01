import { memo, useEffect, useRef, useState } from "react";
import type { TodoItem } from "../lib/derive";
import { IconCheck, IconChevron } from "./Icons";
import { TodoList } from "./TodoCell";

/** How long the finished task stays on its way out before the next is alone. */
const ROTATE_MS = 420;

/** The task to show folded: the one being worked, else the next to start. */
function currentOf(items: TodoItem[]): TodoItem | null {
  return items.find((t) => t.status === "in-progress")
    ?? items.find((t) => t.status !== "completed")
    ?? null;
}

/**
 * The agent's to-do list, docked to the top of the message box.
 *
 * It used to sit in the pinned bar at the top of the screen on a phone, and in
 * the thread on a laptop, where the next reply pushed it out of sight. Here it
 * is one line attached to the box you type in: the task the agent is on now.
 * When that one is done it slides up and out, ticked, and the next slides in
 * from below, so following the work is watching one line change. Tap it to
 * see every task.
 */
export const TodoDock = memo(function TodoDock({ items }: { items: TodoItem[] }) {
  const [open, setOpen] = useState(false);
  const done = items.filter((t) => t.status === "completed").length;
  const all = items.length > 0 && done === items.length;
  const current = currentOf(items);

  /* The task leaving, kept on screen just long enough to animate out. Only a
     change of task the person is watching animates: the first one shown, and
     a list that arrives already part done, simply appear. */
  const [leaving, setLeaving] = useState<TodoItem | null>(null);
  const shownId = useRef<string | null>(current?.id ?? null);
  useEffect(() => {
    const id = current?.id ?? null;
    if (id === shownId.current) return;
    const before = items.find((t) => t.id === shownId.current) ?? null;
    shownId.current = id;
    if (before) setLeaving({ ...before, status: "completed" });
  }, [current?.id, items]);
  useEffect(() => {
    if (!leaving) return;
    const t = window.setTimeout(() => setLeaving(null), ROTATE_MS);
    return () => window.clearTimeout(t);
  }, [leaving]);

  const pct = items.length ? (done / items.length) * 100 : 0;

  return (
    <section className={`todo-dock${open ? " is-open" : ""}${all ? " is-all" : ""}`} aria-label="To-do list">
      {open && (
        <div className="todo-dock-list">
          <TodoList items={items} />
        </div>
      )}
      <button
        type="button"
        className="todo-dock-bar"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={open ? "Hide the to-do list" : `Show all ${items.length} tasks`}
      >
        <span className="todo-dock-count" aria-hidden="true">
          {done}/{items.length}
        </span>
        <span className="todo-dock-now" aria-live="polite">
          {leaving && (
            <span className="todo-dock-line is-leaving" key={`out-${leaving.id}`} aria-hidden="true">
              <span className="todo-dock-tick"><IconCheck size={11} /></span>
              <span className="todo-dock-words">{leaving.title}</span>
            </span>
          )}
          {all ? (
            <span className={`todo-dock-line${leaving ? " is-entering" : ""}`} key="all">
              <span className="todo-dock-tick"><IconCheck size={11} /></span>
              <span className="todo-dock-words">All {items.length} done</span>
            </span>
          ) : current && (
            <span className={`todo-dock-line${leaving ? " is-entering" : ""}`} key={`in-${current.id}`}>
              <span className={`todo-dock-dot${current.status === "in-progress" ? " is-doing" : ""}`} aria-hidden="true" />
              <span className="todo-dock-words">{current.title}</span>
            </span>
          )}
        </span>
        <span className="todo-dock-chev" aria-hidden="true"><IconChevron size={14} /></span>
        <i className="todo-dock-bar-fill" style={{ width: `${pct}%` }} aria-hidden="true" />
      </button>
    </section>
  );
});
