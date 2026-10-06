/**
 * `@tauri-apps/api/event`, over Autora's event socket.
 *
 * `listen` is what the renderer's whole backend story hangs off: the engine's
 * responses arrive as events addressed back to the window that asked, exactly
 * as Rust used to address them.
 */
import { subscribe } from "./transport";
import { call } from "./transport";

export interface Event<T> {
  event: string;
  id: number;
  payload: T;
}

type Handler<T> = (event: Event<T>) => void;

let nextId = 1;

export async function listen<T>(
  event: string,
  handler: Handler<T>,
): Promise<() => void> {
  const id = nextId++;
  return subscribe(event, (payload) => handler({ event, id, payload: payload as T }));
}

export async function once<T>(event: string, handler: Handler<T>): Promise<() => void> {
  const off = await listen<T>(event, (e) => {
    off();
    handler(e);
  });
  return off;
}

/** Events flow one way in this port; Autora is the only emitter. */
export async function emit(_event: string, _payload?: unknown): Promise<void> {
  return undefined;
}

/** Tauri's cross-window bus, used by the tab-drag code. */
export async function emitTo(_target: string, _event: string, _payload?: unknown): Promise<void> {
  return undefined;
}
