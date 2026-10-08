import { useSyncExternalStore } from "react";

/**
 * The Terminal window on this page (server/termdesk.ts): whether it is open beside the conversation, where its
 * shell is, and a revision that goes up whenever anything moves in it. The scrollback itself is not here: the
 * window asks for what it has not seen when `rev` changes.
 */
export type TermState = {
  open: boolean;
  /** When the window was opened, which orders it among the others. */
  since?: number;
  cwd?: string;
  rev?: number;
  /** A command is running. */
  running?: boolean;
};

const CLOSED: TermState = { open: false };
let state: TermState = CLOSED;
const listeners = new Set<() => void>();

export function setTermState(next: unknown) {
  state = next && typeof next === "object" && (next as TermState).open !== undefined ? (next as TermState) : CLOSED;
  for (const l of listeners) l();
}

export function resetTerm() {
  setTermState(null);
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export function useTermState(): TermState {
  return useSyncExternalStore(subscribe, () => state, () => CLOSED);
}
