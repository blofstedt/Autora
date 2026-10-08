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

    if (msg.type === "autora:spectra:locate" && typeof msg.id === "number") {
      // Where a page is on this screen, for the agent's cursor in the window that holds the frame.
      const page = Number((msg as { page?: number }).page);
      const id = msg.id;
      const cells = Array.from(document.querySelectorAll<HTMLElement>(".docview-row > .page[data-page-id]"));
      const cell = Number.isInteger(page) && page >= 1 ? cells[page - 1] : undefined;
      /* Brought into view so that the place on it the agent worked is on screen, a little above the middle: the page
         is usually taller than the window, and its middle is not where anything was done. */
      const fy = Number((msg as { fy?: number }).fy);
      if (cell) {
        let scroller: HTMLElement | null = cell.parentElement;
        while (scroller && !(scroller.scrollHeight > scroller.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
        const r = cell.getBoundingClientRect();
        const target = r.top + (Number.isFinite(fy) ? Math.min(1, Math.max(0, fy)) : 0.5) * r.height;
        if (scroller) scroller.scrollTop += target - innerHeight * 0.4;
        else cell.scrollIntoView({ block: "center", inline: "nearest" });
      }
      // A frame later, once the scroll has landed.
      requestAnimationFrame(() => {
        const r = cell?.getBoundingClientRect();
        window.parent.postMessage({
          type: "autora:spectra:located", id,
          rect: r && r.width > 0 ? { x: r.left, y: r.top, w: r.width, h: r.height, view: { w: innerWidth, h: innerHeight } } : null,
        }, "*");
      });
      return;
    }
    if (msg.type === "autora:spectra:result" && typeof msg.id === "number") {
      settle(msg.id, msg.ok !== false, msg.value);
    } else if (msg.type === "autora:spectra:event" && typeof msg.event === "string") {
      receiveEvent(msg.event, msg.payload);
    }
  });

  // What goes wrong in here is said to the window that holds the frame, which shows it: a frame that has failed is
  // otherwise only grey, and the reason is in a console nobody has open.
  let said = 0;
  const complain = (message: string) => {
    if (said++ >= 3 || window.parent === window) return;
    window.parent.postMessage({ type: "autora:spectra:error", message }, "*");
  };
  window.addEventListener("error", (e) => complain(e.message || "an error"));

  window.addEventListener("pagehide", () => announce("closing"));
  announce("ready");
}
