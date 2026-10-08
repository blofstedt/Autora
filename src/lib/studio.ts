import { useSyncExternalStore } from "react";

/**
 * Autora Music's window on this page (server/studio.ts): whether it is open beside the conversation, what changed
 * last, and the commands the agent sends it (play, stop, bounce). The song itself is not here: the window fetches it
 * when `rev` moves on and the change was the agent's.
 */
type StudioState = {
  open: boolean;
  /** When the window was opened, which orders it among the others. */
  since?: number;
  /** Goes up on every change to the song, by anyone. */
  rev?: number;
  /** Who made the latest change. */
  by?: "agent" | "person";
  name?: string;
  bpm?: number;
  tracks?: number;
};

/** One thing the agent asked the window to do. */
type StudioCommand = { id: string; name: string; args: Record<string, unknown> };

const CLOSED: StudioState = { open: false };
let state: StudioState = CLOSED;
const listeners = new Set<() => void>();

export function setStudioState(next: unknown) {
  state = next && typeof next === "object" && (next as StudioState).open !== undefined ? (next as StudioState) : CLOSED;
  for (const l of listeners) l();
}

export function resetStudio() {
  setStudioState(null);
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export function useStudioState(): StudioState {
  return useSyncExternalStore(subscribe, () => state, () => CLOSED);
}

/** The state as it is now, for code that is not a component (the window's message handlers). */
export const studioStateNow = (): StudioState => state;

/** Be told whenever the state changes. */
export function onStudioState(fn: () => void): () => void {
  return subscribe(fn);
}

type CommandListener = (cmd: StudioCommand) => void;
const commandListeners = new Set<CommandListener>();

/** The window listens for what the agent asks of it. */
export function onStudioCommand(fn: CommandListener): () => void {
  commandListeners.add(fn);
  return () => { commandListeners.delete(fn); };
}

/** One command off the session stream (called from App, where the stream lives). */
export function emitStudioCommand(cmd: StudioCommand): void {
  for (const fn of commandListeners) {
    try {
      fn(cmd);
    } catch (err) {
      console.error("[studio] a listener threw", err);
    }
  }
}
