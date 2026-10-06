/**
 * The frame's half of the conversation with the window that holds it.
 *
 * Installed once, from the renderer's entry, before anything else runs: the
 * window answers commands and relays the engine's events, and both are useless
 * if this is not listening by the time the first one is asked for.
 */
import { receiveEvent, settle } from "./transport";

let installed = false;

/** Tell the window what this frame is waiting for. */
export function announce(kind: "ready" | "closing", detail?: unknown): void {
  if (window.parent === window) return;
  window.parent.postMessage({ type: "autora:spectra:" + kind, ...(detail as object ?? {}) }, "*");
}

export function installHost(): void {
  if (installed) return;
  installed = true;

  window.addEventListener("message", (event: MessageEvent) => {
    // Only the window that holds this frame may drive it.
    if (window.parent !== window && event.source !== window.parent) return;
    const msg = event.data as
      | { type?: string; id?: number; ok?: boolean; value?: unknown; event?: string; payload?: unknown }
      | null;
    if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return;

    if (msg.type === "autora:spectra:result" && typeof msg.id === "number") {
      settle(msg.id, msg.ok !== false, msg.value);
    } else if (msg.type === "autora:spectra:event" && typeof msg.event === "string") {
      receiveEvent(msg.event, msg.payload);
    }
  });

  window.addEventListener("pagehide", () => announce("closing"));
  announce("ready");
}
