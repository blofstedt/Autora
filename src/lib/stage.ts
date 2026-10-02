/**
 * The pinned stage: which of the things the agent shows are held in view.
 *
 * A page the agent is working, its plan and an explainer it drew all appear in
 * the thread where they happened -- and on a phone the next reply pushes each
 * of them up out of sight, so watching one means scrolling back for it every
 * time. On a phone they are held in one panel above the thread instead, with
 * tabs for whichever exist, and the thread keeps the words.
 *
 * Which cells are held is decided here, from the derived thread and nothing
 * else, so that any one of the three alone or any mix of them takes the same
 * path: a list of surfaces, at most one per kind, newest first-shown.
 */
import { useSyncExternalStore } from "react";
import type { Bucket, Cell } from "./derive";

export type SurfaceKind = "app" | "pdf" | "word" | "browser" | "plan" | "widget";

export type Surface = { kind: SurfaceKind; cell: Cell; key: string };

/** The order the tabs sit in, however they arrived. */
const ORDER: SurfaceKind[] = ["app", "pdf", "word", "browser", "plan", "widget"];

/** Who a cell is, for React and for the stage: the event that started it. */
export function cellKey(cell: Cell): string {
  return `${cell.kind}-${cell.seq}`;
}

const kindOf = (cell: Cell, liveBrowserSeq: number | null, appOpen: boolean): SurfaceKind | null => {
  if (cell.kind === "app") return appOpen ? "app" : null;
  if (cell.kind === "screen") {
    // Only the page that is open now: an older card shows what happened, and
    // there is nothing left of it to hold.
    return cell.source === "browser" && cell.seq === liveBrowserSeq ? "browser" : null;
  }
  if (cell.kind === "todo") return "plan";
  if (cell.kind === "widget") return "widget";
  return null;
};

/** A plan with work still to do is what the person is waiting on; a finished
    one is a record, and belongs in the thread like any other. */
const unfinished = (cell: Cell) =>
  cell.kind === "todo" && cell.items.some((t) => t.status !== "completed");

/**
 * What to hold, given the thread.
 *
 * The app window is held for as long as it is open, from the turn that opened
 * it on. The page is held for as long as it is open. A plan is held while it has work
 * left, or while it is the latest turn's. A widget is held for the latest turn
 * only -- an explainer from three questions ago is not what the person is
 * looking at, and pinning it forever would spend the top of the screen on it.
 * The newest of each kind wins; the rest stay in the thread.
 */
export function pickSurfaces(buckets: readonly Bucket[], liveBrowserSeq: number | null, appOpen = false): Surface[] {
  const found = new Map<SurfaceKind, Cell>();
  const last = buckets.length - 1;
  buckets.forEach((bucket, index) => {
    for (const cell of bucket.cells) {
      const kind = kindOf(cell, liveBrowserSeq, appOpen);
      if (!kind) continue;
      const latest = index === last;
      if (kind === "widget" && !latest) continue;
      if (kind === "plan" && !latest && !unfinished(cell)) continue;
      const have = found.get(kind);
      if (!have || cell.seq > have.seq) found.set(kind, cell);
    }
  });
  return ORDER.flatMap((kind) => {
    const cell = found.get(kind);
    return cell ? [{ kind, cell, key: cellKey(cell) }] : [];
  });
}

/**
 * The to-do list docked above the message box, on every screen size: the same
 * plan the stage used to hold at the top (one with work left, or the latest
 * turn's), now where the eye already is while typing. Null when there is none.
 */
export function dockedPlan(buckets: readonly Bucket[]): Extract<Cell, { kind: "todo" }> | null {
  const cell = pickSurfaces(buckets, null).find((s) => s.kind === "plan")?.cell;
  return cell && cell.kind === "todo" ? cell : null;
}

/** The last the agent did on a surface: a page it clicked, an item it ticked. */
export function activityOf(cell: Cell): number {
  if (cell.kind === "screen") return cell.touched ?? cell.seq;
  if (cell.kind === "todo") return cell.updated ?? cell.seq;
  return cell.seq;
}

/** What "follow" shows: the surface the agent touched most recently. */
export function busiestSurface(surfaces: readonly Surface[]): Surface | null {
  let best: Surface | null = null;
  for (const surface of surfaces) {
    if (!best || activityOf(surface.cell) > activityOf(best.cell)) best = surface;
  }
  return best;
}

/** The tab shown when nobody has picked one: whatever arrived last. */
export function newestSurface(surfaces: readonly Surface[]): Surface | null {
  let best: Surface | null = null;
  for (const surface of surfaces) {
    if (!best || surface.cell.seq > best.cell.seq) best = surface;
  }
  return best;
}

/** The width below which the app is a phone: the same line the stylesheet's
    other phone rules use. */
const PHONE = "(max-width: 680px)";

const subscribe = (notify: () => void) => {
  if (typeof matchMedia !== "function") return () => undefined;
  const query = matchMedia(PHONE);
  query.addEventListener("change", notify);
  return () => query.removeEventListener("change", notify);
};

export function usePhone(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => typeof matchMedia === "function" && matchMedia(PHONE).matches,
    () => false,
  );
}
