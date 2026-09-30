import { memo } from "react";
import type { TodoItem } from "../lib/derive";

/**
 * The agent's to-do list: a checklist the person watches tick itself off.
 * Only the agent changes it, so there is nothing here to press. The item the
 * agent is on has a dashed outline that marches; when it finishes, the box
 * fills and the tick draws itself in, and the title is struck through. Each
 * row keeps its element across updates (its key is its number), so those are
 * plain CSS transitions on a class change: nothing animates on first paint,
 * only on the change the person is watching.
 */
function Box() {
  return (
    <svg className="todo-box" viewBox="0 0 20 20" aria-hidden="true">
      <rect className="todo-rect" x="1.5" y="1.5" width="17" height="17" rx="5" />
      <path className="todo-tick" d="M5.6 10.4l3 3 5.8-6.6" pathLength="1" />
    </svg>
  );
}

export const TodoCell = memo(function TodoCell({ items }: { items: TodoItem[] }) {
  const done = items.filter((t) => t.status === "completed").length;
  const pct = items.length ? Math.round((done / items.length) * 100) : 0;
  return (
    <div className="cell todo-cell" role="group" aria-label="To-do list">
      <div className="todo-head">
        <b>To do</b>
        <span className="todo-count">{done} of {items.length} done</span>
      </div>
      <div
        className="todo-bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <i style={{ width: `${pct}%` }} />
      </div>
      <ol className="todo-list">
        {items.map((item) => (
          <li
            key={item.id}
            className={`todo-item${item.status === "in-progress" ? " is-doing" : ""}${item.status === "completed" ? " is-done" : ""}`}
            aria-current={item.status === "in-progress" ? "step" : undefined}
          >
            <Box />
            <span className="todo-title">
              <span className="todo-words">{item.title}</span>
              <span className="sr-only">
                {item.status === "completed" ? " (done)" : item.status === "in-progress" ? " (in progress)" : ""}
              </span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
});
