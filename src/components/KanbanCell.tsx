import React, { useState } from "react";
import type { KanbanBoard, KanbanTask } from "../lib/derive";
import { IconCheck, IconChevron, IconGrip, IconSpark } from "./Icons";

type ColumnKey = "todo" | "doing" | "done";

interface ColumnDef {
  key: ColumnKey;
  label: string;
  badgeClass: string;
}

const COLUMNS: ColumnDef[] = [
  { key: "todo", label: "To Do", badgeClass: "todo-ind" },
  { key: "doing", label: "Doing", badgeClass: "doing-ind" },
  { key: "done", label: "Done", badgeClass: "done-ind" },
];

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

  // Drag and drop state
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [dragOverCol, setDragOverCol] = useState<ColumnKey | null>(null);
  const [dragOverTaskId, setDragOverTaskId] = useState<string | null>(null);
  const [dropPosition, setDropPosition] = useState<"before" | "after">("after");

  // Keep tasks in sync if board updates from outer stream
  const currentTasks = board.tasks.length > 0 ? board.tasks : tasks;

  const todo = currentTasks.filter((t) => t.status === "todo");
  const doing = currentTasks.filter((t) => t.status === "doing");
  const done = currentTasks.filter((t) => t.status === "done");

  const columnTasks: Record<ColumnKey, KanbanTask[]> = {
    todo,
    doing,
    done,
  };

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

  const runNext = () => {
    const nextTask = todo[0] || doing[0];
    if (!nextTask) return;
    moveTask(nextTask.id, "doing");
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
  const handleDragStart = (e: React.DragEvent<HTMLDivElement>, task: KanbanTask) => {
    setDraggingTaskId(task.id);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", task.id);
    e.dataTransfer.setData(
      "application/json",
      JSON.stringify({ taskId: task.id, fromStatus: task.status })
    );

    // Set a subtle drag preview styling
    if (e.currentTarget) {
      e.currentTarget.classList.add("is-dragging");
    }
  };

  const handleDragEnd = (e: React.DragEvent<HTMLDivElement>) => {
    if (e.currentTarget) {
      e.currentTarget.classList.remove("is-dragging");
    }
    setDraggingTaskId(null);
    setDragOverCol(null);
    setDragOverTaskId(null);
  };

  const handleColDragOver = (e: React.DragEvent<HTMLDivElement>, colKey: ColumnKey) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    if (dragOverCol !== colKey) {
      setDragOverCol(colKey);
    }
  };

  const handleColDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    // Only unset if we are leaving the column container entirely
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDragOverCol(null);
    }
  };

  const handleColDrop = (e: React.DragEvent<HTMLDivElement>, targetCol: ColumnKey) => {
    e.preventDefault();
    e.stopPropagation();

    const taskId = e.dataTransfer.getData("text/plain") || draggingTaskId;
    if (taskId) {
      moveTask(taskId, targetCol, dragOverTaskId ?? undefined, dropPosition);
    }

    setDraggingTaskId(null);
    setDragOverCol(null);
    setDragOverTaskId(null);
  };

  const handleCardDragOver = (
    e: React.DragEvent<HTMLDivElement>,
    targetTask: KanbanTask,
    colKey: ColumnKey
  ) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";

    if (dragOverCol !== colKey) {
      setDragOverCol(colKey);
    }

    if (draggingTaskId !== targetTask.id) {
      setDragOverTaskId(targetTask.id);
      const rect = e.currentTarget.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      setDropPosition(e.clientY < midY ? "before" : "after");
    }
  };

  const handleCardDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDragOverTaskId(null);
    }
  };

  return (
    <div className="kanban-cell" role="region" aria-label={`Kanban Board: ${board.title}`}>
      {/* Kanban Header */}
      <div className="kanban-header">
        <div className="kanban-title">
          <span className="kanban-badge">
            <IconSpark size={12} />
          </span>
          <b>{board.title}</b>
          <span className="kanban-count">{currentTasks.length} tasks</span>
          <span className="kanban-dnd-hint">Drag cards to update status</span>
        </div>

        <div className="kanban-actions">
          {todo.length > 0 && (
            <button
              className="btn btn-sm btn-accent"
              onClick={runNext}
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

      {/* 3 Columns Grid: To Do, Doing, Done */}
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
                  <div
                    className={`kanban-empty ${isColOver ? "is-drop-active" : ""}`}
                  >
                    {isColOver ? "Release to drop in " + col.label : "No tasks in " + col.label}
                  </div>
                ) : (
                  list.map((task) => {
                    const isDragging = draggingTaskId === task.id;
                    const isTarget = dragOverTaskId === task.id;

                    // Calculate sub-task completion or stage progress
                    let progressPct = 0;
                    let progressLabel = "Queued";
                    if (task.subtasks && task.subtasks.length > 0) {
                      const completedCount = task.subtasks.filter((s) => s.done).length;
                      progressPct = Math.round((completedCount / task.subtasks.length) * 100);
                      progressLabel = `${completedCount}/${task.subtasks.length} subtasks`;
                    } else if (typeof task.progress === "number") {
                      progressPct = Math.max(0, Math.min(100, Math.round(task.progress)));
                      progressLabel = `${progressPct}% complete`;
                    } else if (col.key === "done") {
                      progressPct = 100;
                      progressLabel = "100% complete";
                    } else if (col.key === "doing") {
                      progressPct = 50;
                      progressLabel = "In progress (50%)";
                    } else {
                      progressPct = 0;
                      progressLabel = "Not started (0%)";
                    }

                    return (
                      <div
                        key={task.id}
                        draggable
                        onDragStart={(e) => handleDragStart(e, task)}
                        onDragEnd={handleDragEnd}
                        onDragOver={(e) => handleCardDragOver(e, task, col.key)}
                        onDragLeave={handleCardDragLeave}
                        className={`kanban-card ${col.key === "doing" ? "active" : ""} ${
                          col.key === "done" ? "completed" : ""
                        } ${isDragging ? "is-dragging" : ""} ${
                          isTarget ? `drop-target-${dropPosition}` : ""
                        }`}
                        title="Click and drag to move to another column"
                      >
                        <div className="kanban-card-head">
                          {/* Drag handle grip */}
                          <span
                            className="kanban-drag-grip"
                            title="Drag to reorder or move column"
                            aria-label="Drag handle"
                          >
                            <IconGrip size={13} />
                          </span>

                          {col.key === "doing" && <span className="kanban-spin-dot" />}
                          {col.key === "done" && (
                            <span className="kanban-check-icon">
                              <IconCheck size={12} />
                            </span>
                          )}

                          <div
                            className={`kanban-card-title ${
                              col.key === "done" ? "completed-text" : ""
                            }`}
                          >
                            {task.title}
                          </div>
                        </div>

                        {/* Visual Progress Bar inside task card */}
                        <div
                          className="kanban-card-progress"
                          title={`Progress: ${progressLabel}`}
                        >
                          <div className="kanban-progress-track">
                            <div
                              className={`kanban-progress-bar status-${col.key}`}
                              style={{ width: `${progressPct}%` }}
                            />
                          </div>
                          <div className="kanban-progress-meta">
                            <span className="kanban-progress-label">{progressLabel}</span>
                            <span className="kanban-progress-pct">{progressPct}%</span>
                          </div>
                        </div>

                        <div className="kanban-card-foot">
                          {task.tag && (
                            <span className={`kanban-tag ${col.key}`}>{task.tag}</span>
                          )}
                          <div className="spacer" />

                          {/* Fallback 1-click step buttons */}
                          {col.key === "todo" && (
                            <button
                              className="kanban-step-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                moveTask(task.id, "doing");
                              }}
                              title="Move to Doing"
                            >
                              Start <IconChevron size={10} />
                            </button>
                          )}

                          {col.key === "doing" && (
                            <button
                              className="kanban-step-btn done"
                              onClick={(e) => {
                                e.stopPropagation();
                                moveTask(task.id, "done");
                              }}
                              title="Mark as Done"
                            >
                              <IconCheck size={11} /> Done
                            </button>
                          )}

                          {col.key === "done" && (
                            <button
                              className="kanban-step-btn undo"
                              onClick={(e) => {
                                e.stopPropagation();
                                moveTask(task.id, "todo");
                              }}
                              title="Reopen task"
                            >
                              Reopen
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}

                {/* Drop placeholder indicator when dragging over column */}
                {isColOver && draggingTaskId && (
                  <div className="kanban-drop-placeholder">
                    <span className="kanban-drop-icon">
                      <IconSpark size={11} />
                    </span>
                    <span>Drop into {col.label}</span>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
