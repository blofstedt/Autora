import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TodoItem } from "../lib/derive";
import { IconCheck, IconChevron } from "./Icons";
import { TodoList } from "./TodoCell";

/** How long the finished task stays on its way out before the next is alone. */
const ROTATE_MS = 420;
/** How long a list that opened itself for a finished task stays: the tick lands, the line is drawn, a beat to read it. */
const STRIKE_MS = 2600;
/** How long the list takes to fold open (.todo-dock-fold): the finished task is shown still undone until then, so the
    tick and the line are drawn in front of the person rather than behind a shut door. */
const OPEN_MS = 340;

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

  /* A finished task opens the list by itself so the person sees it crossed out -- tick, then the line drawn through
     it as if the agent were striking it off -- and the list folds away again. Only for a task finished while the
     list is on screen (a list that arrives part done just appears), and never shut on someone who opened it. */
  const doneIds = useRef(new Set(items.filter((t) => t.status === "completed").map((t) => t.id)));
  const autoOpened = useRef(false);
  /* Tasks that have just been finished, still drawn as in progress while the list opens. */
  const [unrevealed, setUnrevealed] = useState<string[]>([]);
  /* ...and then, until the list folds, the ones to give the burst. */
  const [fresh, setFresh] = useState<string[]>([]);
  useEffect(() => {
    const before = doneIds.current;
    const now = new Set(items.filter((t) => t.status === "completed").map((t) => t.id));
    doneIds.current = now;
    const finished = [...now].filter((id) => !before.has(id));
    if (!finished.length) return;
    if (!autoOpened.current && open) return;
    autoOpened.current = true;
    const wasShut = !open;
    if (wasShut) setUnrevealed(finished);
    setFresh(finished);
    setOpen(true);
    const reveal = window.setTimeout(() => setUnrevealed([]), wasShut ? OPEN_MS : 0);
    const fold = window.setTimeout(() => {
      if (autoOpened.current) { autoOpened.current = false; setOpen(false); }
      setFresh([]);
    }, (wasShut ? OPEN_MS : 0) + STRIKE_MS);
    return () => { window.clearTimeout(reveal); window.clearTimeout(fold); };
    // `open` is read only to leave a list the person opened alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done]);
  const shownItems = unrevealed.length
    ? items.map((t) => (unrevealed.includes(t.id) ? { ...t, status: "in-progress" as const } : t))
    : items;

  /* The list is measured rather than guessed at, so it is pulled open to its
     own height and no further: three tasks and twelve each end exactly at the
     last one, and closing runs the same distance back. It is measured while
     shut too -- the fold clips it, the list keeps its height -- so the first
     tap already knows how far to go. */
  const listRef = useRef<HTMLDivElement | null>(null);
  const [foldH, setFoldH] = useState(0);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const measure = () => setFoldH(el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [items.length]);

  return (
    <section className={`todo-dock${open ? " is-open" : ""}${all ? " is-all" : ""}`} aria-label="To-do list">
      {/* Kept in the page while shut, with no height, so it can slide open and
          shut rather than appear and vanish. */}
      <div className="todo-dock-fold" style={{ height: open ? foldH : 0 }} aria-hidden={!open}>
        <div className="todo-dock-list" ref={listRef}>
          <TodoList items={shownItems} fresh={fresh} />
        </div>
      </div>
      <button
        type="button"
        className="todo-dock-bar"
        onClick={() => { autoOpened.current = false; setOpen((v) => !v); }}
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
