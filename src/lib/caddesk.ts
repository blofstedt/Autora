import { useSyncExternalStore } from "react";

/**
 * Autora 3D's window on this page (server/caddesk.ts): whether it is open beside the conversation, and what changed
 * last. The model itself is not here: the window fetches it when `rev` moves on and the change was the agent's.
 */
type CadState = {
  open: boolean;
  /** When the window was opened, which orders it among the others. */
  since?: number;
  /** Goes up on every change to the model, by anyone. */
  rev?: number;
  /** Who made the latest change. */
  by?: "agent" | "person";
  /** Shapes in the model. */
  shapes?: number;
};

const CLOSED: CadState = { open: false };
let state: CadState = CLOSED;
const listeners = new Set<() => void>();

export function setCadState(next: unknown) {
  state = next && typeof next === "object" && (next as CadState).open !== undefined ? (next as CadState) : CLOSED;
  for (const l of listeners) l();
}

export function resetCad() {
  setCadState(null);
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export function useCadState(): CadState {
  return useSyncExternalStore(subscribe, () => state, () => CLOSED);
}

/** The state as it is now, for code that is not a component (the window's message handler). */
export const cadStateNow = (): CadState => state;

/** Be told whenever the state changes. */
export function onCadState(fn: () => void): () => void {
  return subscribe(fn);
}
