import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { KanbanBoard, KanbanTask } from "../lib/derive";
import { IconCheck, IconGrip, IconMark, IconX } from "./Icons";

type ColumnKey = "todo" | "doing" | "done";

interface ColumnDef {
  key: ColumnKey;
  label: string;
  badgeClass: string;
}

/** The three columns, left to right, in the order the work goes. */
const COLUMNS: ColumnDef[] = [
  { key: "todo", label: "To Do", badgeClass: "todo-ind" },
  { key: "doing", label: "Doing", badgeClass: "doing-ind" },
  { key: "done", label: "Done", badgeClass: "done-ind" },
];

const STATUS_LABEL: Record<ColumnKey, string> = { todo: "To Do", doing: "Doing", done: "Done" };

/** Where a card can go from where it is, and what the button says. */
const MOVES: Record<ColumnKey, { to: ColumnKey; label: string; kind?: string }[]> = {
  todo: [
    { to: "doing", label: "Start" },
    { to: "done", label: "Done", kind: "done" },
  ],
  doing: [
    { to: "done", label: "Done", kind: "done" },
    { to: "todo", label: "Back to To Do", kind: "undo" },
  ],
  done: [
    { to: "doing", label: "Reopen in Doing", kind: "undo" },
    { to: "todo", label: "Back to To Do", kind: "undo" },
  ],
};

/**
 * What a card's bar can honestly say.
 *
 * A number only where there is one: steps counted, or a figure the agent
 * wrote down. A card being worked on with nothing to count says so, over a bar
 * that moves without claiming anything -- because a made-up 50% is worse than
 * no number at all: the person reads it as the work being half done, which is
 * the one thing a progress bar must never mean by accident.
 */
function taskProgress(task: KanbanTask, status: ColumnKey): { pct: number | null; label: string } {
  const steps = task.subtasks ?? [];
  if (steps.length > 0) {
    const done = steps.filter((s) => s.done).length;
    return {
      pct: Math.round((done / steps.length) * 100),
      label: `${done} of ${steps.length} steps`,
    };
  }
  if (typeof task.progress === "number" && Number.isFinite(task.progress)) {
    const pct = Math.max(0, Math.min(100, Math.round(task.progress)));
    return { pct, label: `${pct}% complete` };
  }
  if (status === "done") return { pct: 100, label: "done" };
  if (status === "todo") return { pct: 0, label: "not started" };
  return { pct: null, label: "working" };
}

/** The bar itself, used on a card and again in the card's own view. */
function ProgressTrack({ column, pct }: { column: ColumnKey; pct: number | null }) {
  return (
    <span className="kanban-progress-track">
      <i
        className={`kanban-progress-bar status-${column}${pct === null ? " is-unknown" : ""}`}
        style={pct === null ? undefined : { width: `${pct}%` }}
      />
    </span>
  );
}

/** One card, opened: the whole work item, not the two words that fit on it. */
function TaskModal({
  task,
  column,
  onClose,
  onMove,
  onRun,
}: {
  task: KanbanTask;
  column: ColumnKey;
  onClose: () => void;
  onMove: (to: ColumnKey) => void;
  onRun?: () => void;
}) {
  const { pct, label } = taskProgress(task, column);
  const steps = task.subtasks ?? [];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="scrim"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
      role="presentation"
    >
      <div
        className="modal kanban-peek"
        role="dialog"
        aria-modal="true"
        aria-label={task.title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-top">
          <b className="peek-title">{task.title}</b>
          <div className="spacer" />
          <button className="btn icon ghost" onClick={onClose} aria-label="Close">
            <IconX size={14} />
          </button>
        </div>

        <div className="modal-body">
          <div className="kanban-peek-status">
            <span className={`col-indicator ${column}-ind`} />
            <span className="kanban-peek-status-name">{STATUS_LABEL[column]}</span>
            <span className="kanban-peek-id">{task.id}</span>
            {task.tag && task.tag !== "task" && (
              <span className={`kanban-tag ${column}`}>{task.tag}</span>
            )}
          </div>

          <div className="kanban-peek-progress">
            <ProgressTrack column={column} pct={pct} />
            <span className={`kanban-peek-progress-text${pct === null ? " is-unknown" : ""}`}>
              {pct === null ? "in progress — no count yet" : label}
            </span>
          </div>

          {task.notes ? (
            <p className="peek-body">{task.notes}</p>
          ) : (
            <p className="kanban-peek-quiet">Nothing written on this card yet.</p>
          )}

          {steps.length > 0 && (
            <ul className="kanban-peek-steps">
              {steps.map((step, i) => (
                <li key={step.id ?? i} className={step.done ? "is-done" : ""}>
                  <span className="kanban-step-mark" aria-hidden="true">
                    {step.done ? <IconCheck size={11} /> : null}
                  </span>
                  <span>{step.title}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="modal-foot kanban-peek-foot">
          {MOVES[column].map((move) => (
            <button
              key={move.to}
              className={`kanban-step-btn ${move.kind ?? ""}`.trim()}
              onClick={() => onMove(move.to)}
            >
              {move.label}
            </button>
          ))}
          {column === "todo" && onRun && (
            <button className="btn btn-sm btn-accent" onClick={onRun}>
              Run this autonomously
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

export function KanbanCell({
  board,
  sessionId,
  onTaskMove,
  onTaskAdd,
  onRunAutonomous,
}: {
  board: KanbanBoard;
  sessionId: string;
  onTaskMove?: (boardId: string, taskId: string, newStatus: KanbanTask["status"]) => void;
  onTaskAdd?: (boardId: string, title: string) => void;
  onRunAutonomous?: (task: KanbanTask) => void;
}) {
  const [tasks, setTasks] = useState<KanbanTask[]>(board.tasks);
  const [newTitle, setNewTitle] = useState("");
  const [addingTo, setAddingTo] = useState(false);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);

  // Drag and drop state
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [dragOverCol, setDragOverCol] = useState<ColumnKey | null>(null);
  const [dragOverTaskId, setDragOverTaskId] = useState<string | null>(null);
  const [dropPosition, setDropPosition] = useState<"before" | "after">("after");

  // Keep tasks in sync if board updates from outer stream
  const currentTasks = board.tasks.length > 0 ? board.tasks : tasks;

  const columnTasks: Record<ColumnKey, KanbanTask[]> = {
    todo: currentTasks.filter((t) => t.status === "todo"),
    doing: currentTasks.filter((t) => t.status === "doing"),
    done: currentTasks.filter((t) => t.status === "done"),
  };
  const { todo, done } = columnTasks;

  const openTask = openTaskId ? currentTasks.find((t) => t.id === openTaskId) ?? null : null;

  // -------------------------------------------------------------
  // Lift and place: a card that changes column travels there
  // -------------------------------------------------------------
  const cardRefs = useRef(new Map<string, HTMLElement>());
  const lastRects = useRef(new Map<string, DOMRect>());
  const draggedRef = useRef(false);
  const signature = currentTasks.map((t) => `${t.id}:${t.status}`).join("|");

  useLayoutEffect(() => {
    const next = new Map<string, DOMRect>();
    for (const [id, el] of cardRefs.current) {
      if (!el || !el.isConnected) continue;
      const rect = el.getBoundingClientRect();
      next.set(id, rect);

      const prev = lastRects.current.get(id);
      // A card seen for the first time arrives on its own; nothing to fly from.
      if (!prev) continue;
      const dx = prev.left - rect.left;
      const dy = prev.top - rect.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;

      /* The same motion the drag gives it: picked up out of the old column,
         carried across, and set down in the new one. */
      el.style.transition = "none";
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      el.classList.add("is-flying");
      void el.offsetWidth;
      requestAnimationFrame(() => {
        el.style.transition = "transform 0.42s var(--ease), box-shadow 0.2s ease";
        el.style.transform = "";
      });
      window.setTimeout(() => {
        el.classList.remove("is-flying");
        el.style.transition = "";
      }, 480);
    }
    lastRects.current = next;
  }, [signature]);

  const moveTask = (
    taskId: string,
    newStatus: KanbanTask["status"],
    targetTaskId?: string,
    insertPos?: "before" | "after"
  ) => {
    const taskToMove = currentTasks.find((t) => t.id === taskId);
    if (!taskToMove) return;

    let updated: KanbanTask[];

    if (targetTaskId && targetTaskId !== taskId) {
      // Reordering with target task
      const remaining = currentTasks.filter((t) => t.id !== taskId);
      const targetIndex = remaining.findIndex((t) => t.id === targetTaskId);
      const updatedTask = { ...taskToMove, status: newStatus };

      if (targetIndex !== -1) {
        const insertionIndex = insertPos === "before" ? targetIndex : targetIndex + 1;
        remaining.splice(insertionIndex, 0, updatedTask);
        updated = remaining;
      } else {
        updated = [...remaining, updatedTask];
      }
    } else {
      // Simple status update
      updated = currentTasks.map((t) =>
        t.id === taskId ? { ...t, status: newStatus } : t
      );
    }

    setTasks(updated);
    setOpenTaskId(null);

    if (onTaskMove) {
      onTaskMove(board.id, taskId, newStatus);
    }

    // Persist to session backend
    fetch(`/api/sessions/${sessionId}/kanban`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ boardId: board.id, taskId, newStatus }),
    }).catch(() => undefined);
  };

  const addTask = () => {
    const title = newTitle.trim();
    if (!title) return;
    const newTask: KanbanTask = {
      id: `task-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 6)}`,
      title,
      status: "todo",
      tag: "task",
    };
    const updated = [...currentTasks, newTask];
    setTasks(updated);
    setNewTitle("");
    setAddingTo(false);

    if (onTaskAdd) {
      onTaskAdd(board.id, title);
    }

    fetch(`/api/sessions/${sessionId}/kanban`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ boardId: board.id, task: newTask }),
    }).catch(() => undefined);
  };

  const runNext = (only?: KanbanTask) => {
    const nextTask = only ?? todo[0] ?? columnTasks.doing[0];
    if (!nextTask) return;
    if (nextTask.status !== "doing") moveTask(nextTask.id, "doing");
    if (onRunAutonomous) {
      onRunAutonomous(nextTask);
    } else {
      fetch(`/api/sessions/${sessionId}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: `Autonomously execute task: "${nextTask.title}" and update the Kanban board.`,
        }),
      }).catch(() => undefined);
    }
  };

  // -------------------------------------------------------------
  // Drag and Drop Event Handlers
  // -------------------------------------------------------------
  const handleDragStart = (e: React.DragEvent<HTMLElement>, task: KanbanTask) => {
    draggedRef.current = true;
    setDraggingTaskId(task.id);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", task.id);
    e.dataTransfer.setData(
      "application/json",
      JSON.stringify({ taskId: task.id, fromStatus: task.status })
    );
  };

  const handleDragEnd = () => {
    setDraggingTaskId(null);
    setDragOverCol(null);
    setDragOverTaskId(null);
    // The click that ends a drag is not a tap on the card.
    window.setTimeout(() => {
      draggedRef.current = false;
    }, 140);
  };

  const handleColDragOver = (e: React.DragEvent<HTMLDivElement>, colKey: ColumnKey) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    if (dragOverCol !== colKey) setDragOverCol(colKey);
  };

  const handleColDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverCol(null);
  };

  const handleColDrop = (e: React.DragEvent<HTMLDivElement>, targetCol: ColumnKey) => {
    e.preventDefault();
    e.stopPropagation();
    const taskId = e.dataTransfer.getData("text/plain") || draggingTaskId;
    if (taskId) moveTask(taskId, targetCol, dragOverTaskId ?? undefined, dropPosition);
    setDraggingTaskId(null);
    setDragOverCol(null);
    setDragOverTaskId(null);
  };

  const handleCardDragOver = (
    e: React.DragEvent<HTMLElement>,
    targetTask: KanbanTask,
    colKey: ColumnKey
  ) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    if (dragOverCol !== colKey) setDragOverCol(colKey);
    if (draggingTaskId !== targetTask.id) {
      setDragOverTaskId(targetTask.id);
      const rect = e.currentTarget.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      setDropPosition(e.clientY < midY ? "before" : "after");
    }
  };

  const handleCardDragLeave = (e: React.DragEvent<HTMLElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverTaskId(null);
  };

  const openCard = (id: string) => {
    if (draggedRef.current) return;
    setOpenTaskId(id);
  };

  const total = currentTasks.length;
  const finished = done.length;
  const boardPct = total === 0 ? 0 : Math.round((finished / total) * 100);

  return (
    <div className="kanban-cell" role="region" aria-label={`Kanban Board: ${board.title}`}>
      {/* Kanban Header */}
      <div className="kanban-header">
        <div className="kanban-title">
          <span className="kanban-badge">
            <IconMark size={12} />
          </span>
          <b>{board.title}</b>
          <span className="kanban-count">
            {finished}/{total} done
          </span>
          <span className="kanban-dnd-hint">Drag a card, or tap it, to move it on</span>
        </div>

        <div className="kanban-actions">
          {todo.length > 0 && (
            <button
              className="btn btn-sm btn-accent"
              onClick={() => runNext()}
              title="Agent autonomously works through tasks"
            >
              <span className="kanban-pulse-dot" />
              Run Next Autonomously
            </button>
          )}
          <button
            className="btn btn-sm ghost"
            onClick={() => setAddingTo(!addingTo)}
            title="Create new task"
          >
            {addingTo ? "Cancel" : "+ Add Task"}
          </button>
        </div>
      </div>

      {/* How far along the whole board is: the only percentage that is real. */}
      {total > 0 && (
        <div className="kanban-board-progress" aria-label={`${finished} of ${total} cards done`}>
          <span className="kanban-progress-track">
            <i
              className={`kanban-progress-bar${finished === total ? " status-done" : " status-doing"}`}
              style={{ width: `${boardPct}%` }}
            />
          </span>
          <span className="kanban-board-pct">{boardPct}%</span>
        </div>
      )}

      {/* Inline Add Task Bar */}
      {addingTo && (
        <div className="kanban-add-bar">
          <input
            type="text"
            className="kanban-add-input"
            placeholder="What needs to be done? Press Enter to save..."
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addTask();
              if (e.key === "Escape") setAddingTo(false);
            }}
            autoFocus
          />
          <button className="btn btn-sm primary" onClick={addTask} disabled={!newTitle.trim()}>
            Add
          </button>
        </div>
      )}

      {/* Three columns, left to right: To Do, Doing, Done */}
      <div className="kanban-cols">
        {COLUMNS.map((col) => {
          const list = columnTasks[col.key];
          const isColOver = dragOverCol === col.key;

          return (
            <div
              key={col.key}
              className={`kanban-col ${col.key} ${isColOver ? "is-drag-over" : ""}`}
              onDragOver={(e) => handleColDragOver(e, col.key)}
              onDragLeave={handleColDragLeave}
              onDrop={(e) => handleColDrop(e, col.key)}
              data-column={col.key}
            >
              {/* Column Header */}
              <div className="kanban-col-head">
                <span className={`col-indicator ${col.badgeClass}`} />
                <span className="col-name">{col.label}</span>
                <span className="col-badge">{list.length}</span>
              </div>

              {/* Items List / Drop Zone */}
              <div className="kanban-items">
                {list.length === 0 ? (
                  <div className={`kanban-empty ${isColOver ? "is-drop-active" : ""}`}>
                    {isColOver ? "Release to drop here" : "Empty"}
                  </div>
                ) : (
                  list.map((task) => {
                    const isDragging = draggingTaskId === task.id;
                    const isTarget = dragOverTaskId === task.id;
                    const { pct } = taskProgress(task, col.key);

                    return (
                      <article
                        key={task.id}
                        ref={(el) => {
                          if (el) cardRefs.current.set(task.id, el);
                          else cardRefs.current.delete(task.id);
                        }}
                        draggable
                        onDragStart={(e) => handleDragStart(e, task)}
                        onDragEnd={handleDragEnd}
                        onDragOver={(e) => handleCardDragOver(e, task, col.key)}
                        onDragLeave={handleCardDragLeave}
                        onClick={() => openCard(task.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            openCard(task.id);
                          }
                        }}
                        role="button"
                        tabIndex={0}
                        aria-label={`${task.title} — ${STATUS_LABEL[col.key]}. Open the card.`}
                        className={`kanban-card ${col.key === "doing" ? "active" : ""} ${
                          col.key === "done" ? "completed" : ""
                        } ${isDragging ? "is-dragging" : ""} ${
                          isTarget ? `drop-target-${dropPosition}` : ""
                        } ${openTaskId === task.id ? "is-open" : ""}`}
                        title={task.title}
                      >
                        <span className="kanban-drag-grip" aria-hidden="true">
                          <IconGrip size={12} />
                        </span>

                        <span
                          className={`kanban-card-title ${
                            col.key === "done" ? "completed-text" : ""
                          }`}
                        >
                          {task.title}
                        </span>

                        <span className="kanban-card-state">
                          {col.key === "doing" && <span className="kanban-spin-dot" />}
                          {col.key === "done" && (
                            <span className="kanban-check-icon">
                              <IconCheck size={11} />
                            </span>
                          )}
                          {pct !== null && col.key !== "todo" && (
                            <span className="kanban-card-pct">{pct}%</span>
                          )}
                        </span>

                        <ProgressTrack column={col.key} pct={pct} />
                      </article>
                    );
                  })
                )}

                {isColOver && draggingTaskId && (
                  <div className="kanban-drop-placeholder">
                    <span className="kanban-drop-icon">
                      <IconMark size={11} />
                    </span>
                    <span>Drop into {col.label}</span>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {openTask && (
        <TaskModal
          task={openTask}
          column={openTask.status}
          onClose={() => setOpenTaskId(null)}
          onMove={(to) => moveTask(openTask.id, to)}
          onRun={openTask.status === "todo" ? () => runNext(openTask) : undefined}
        />
      )}
    </div>
  );
}
