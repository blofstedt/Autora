import { useSyncExternalStore } from "react";

/**
 * The Word window's state on this page (server/officedesk.ts): whether a
 * document is open beside the conversation, and which version of it. The
 * document itself is fetched by the window when `loadRev` changes.
 */
export type WordVersion = { n: number; label: string; at: number; by: "agent" | "person"; name: string };

export type WordState = {
  open: boolean;
  name?: string;
  /** The artifact the document is kept in, once there is one. */
  working?: string | null;
  /** Goes up on every change by anyone. */
  rev?: number;
  /** Goes up when the agent changed the document: the window loads it again. */
  loadRev?: number;
  since?: number;
  problem?: string | null;
  versions?: WordVersion[];
};

const CLOSED: WordState = { open: false };
let state: WordState = CLOSED;
const listeners = new Set<() => void>();

export function setWordState(next: unknown) {
  state = next && typeof next === "object" && (next as WordState).open !== undefined ? (next as WordState) : CLOSED;
  for (const l of listeners) l();
}

export function resetWord() {
  setWordState(null);
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export function useWordState(): WordState {
  return useSyncExternalStore(subscribe, () => state, () => CLOSED);
}
