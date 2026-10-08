import { useSyncExternalStore } from "react";

/**
 * The video window on this page (server/opencut.ts): whether OpenCut's editor
 * is open beside the conversation and which project is in it, and the
 * commands the agent sends it. The project itself lives in the editor's frame
 * and on the server; nothing of it is kept here.
 */
type VideoState = { open: boolean; projectId?: string | null; name?: string | null; since?: number };

/** One thing the agent asked the editor to do. */
export type VideoCommand = { id: string; name: string; args: Record<string, unknown> };

const CLOSED: VideoState = { open: false };
let state: VideoState = CLOSED;
const listeners = new Set<() => void>();

export function setVideoState(next: unknown) {
  state = next && typeof next === "object" && (next as VideoState).open !== undefined ? (next as VideoState) : CLOSED;
  for (const l of listeners) l();
}

export function resetVideo() {
  setVideoState(null);
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export function useVideoState(): VideoState {
  return useSyncExternalStore(subscribe, () => state, () => CLOSED);
}

type CommandListener = (cmd: VideoCommand) => void;
const commandListeners = new Set<CommandListener>();

/** The window listens for what the agent asks of the editor. */
export function onVideoCommand(fn: CommandListener): () => void {
  commandListeners.add(fn);
  return () => {
    commandListeners.delete(fn);
  };
}

/** One command off the session stream (called from App, where the stream lives). */
export function emitVideoCommand(cmd: VideoCommand): void {
  for (const fn of commandListeners) {
    try {
      fn(cmd);
    } catch (err) {
      console.error("[video] a listener threw", err);
    }
  }
}
