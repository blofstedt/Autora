import { useSyncExternalStore } from "react";

/**
 * Autora Photo's window on this page (server/photodesk.ts): whether it is open beside the conversation, and what changed
 * last. The picture itself is not here: the window fetches it when `rev` moves on and the change was the agent's.
 */
type PhotoState = {
  open: boolean;
  /** When the window was opened, which orders it among the others. */
  since?: number;
  /** Goes up on every change to the picture, by anyone. */
  rev?: number;
  /** Who made the latest change. */
  by?: "agent" | "person";
  /** The picture's size in pixels, once there is one. */
  size?: { w: number; h: number };
  /** Layers in the picture. */
  layers?: number;
  /** The revision the window made itself, by the agent's hand: it has it, so it does not load it again. */
  hand?: number;
};

/** The agent's edit, to be done in the window by hand (Visible work on): the commands, in order. */
export type PhotoHand = { id: string; commands: Array<{ id: string; params: Record<string, unknown> }> };

const CLOSED: PhotoState = { open: false };
let state: PhotoState = CLOSED;
const listeners = new Set<() => void>();

export function setPhotoState(next: unknown) {
  state = next && typeof next === "object" && (next as PhotoState).open !== undefined ? (next as PhotoState) : CLOSED;
  for (const l of listeners) l();
}

export function resetPhoto() {
  setPhotoState(null);
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export function usePhotoState(): PhotoState {
  return useSyncExternalStore(subscribe, () => state, () => CLOSED);
}

/** The state as it is now, for code that is not a component (the window's message handler). */
export const photoStateNow = (): PhotoState => state;

/** Be told whenever the state changes. */
export function onPhotoState(fn: () => void): () => void {
  return subscribe(fn);
}

const handListeners = new Set<(hand: PhotoHand) => void>();

/** The window listens for the agent's edits to do by hand. */
export function onPhotoHand(fn: (hand: PhotoHand) => void): () => void {
  handListeners.add(fn);
  return () => { handListeners.delete(fn); };
}

/** One edit off the session stream (called from App, where the stream lives). */
export function emitPhotoHand(msg: unknown): void {
  const m = msg as { id?: unknown; commands?: unknown } | null;
  if (!m || typeof m.id !== "string" || !Array.isArray(m.commands)) return;
  const commands = m.commands
    .filter((c): c is { id: string; params?: unknown } => !!c && typeof c === "object" && typeof (c as { id?: unknown }).id === "string")
    .map((c) => ({ id: c.id, params: c.params && typeof c.params === "object" ? (c.params as Record<string, unknown>) : {} }));
  for (const fn of handListeners) {
    try {
      fn({ id: m.id, commands });
    } catch (err) {
      console.error("[photo] a listener threw", err);
    }
  }
}
