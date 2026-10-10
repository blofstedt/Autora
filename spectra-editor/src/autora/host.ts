/**
 * The frame's half of the conversation with the window that holds it.
 *
 * Installed once, from the renderer's entry, before anything else runs: the
 * window answers commands and relays the engine's events, and both are useless
 * if this is not listening by the time the first one is asked for.
 */
import { receiveEvent, settle } from "./transport";

let installed = false;

/**
 * pdf.js's data files (character maps, standard fonts, image decoders), asked for through the window that holds the
 * frame. A frame with no origin sends no cookies, and behind a login proxy that turns every request it makes itself
 * away; the window's own requests carry them. Only files under the editor's own `pdfjs/` folder are ever asked for.
 */
const wanting = new Map<number, (r: Response) => void>();
let asset = 1;
function relayed(url: string): Promise<Response> {
  const id = asset++;
  return new Promise<Response>((resolve, reject) => {
    const timer = window.setTimeout(() => { wanting.delete(id); reject(new TypeError("the window did not answer for " + url)); }, 30_000);
    wanting.set(id, (r) => { window.clearTimeout(timer); resolve(r); });
    window.parent.postMessage({ type: "autora:spectra:asset", id, path: new URL(url, location.href).pathname }, "*");
  });
}
function relayPdfjsFetches(): void {
  if (window.parent === window) return;
  const real = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const at = new URL(url, location.href);
      if (at.origin === location.origin && /\/spectra-editor\/pdfjs\//.test(at.pathname) && (init?.method ?? "GET").toUpperCase() === "GET") return relayed(at.href);
    } catch { /* not a URL: left to the browser */ }
    return real(input, init);
  };
}

/** Tell the window what this frame is waiting for. */
export function announce(kind: "ready" | "closing", detail?: unknown): void {
  if (window.parent === window) return;
  window.parent.postMessage({ type: "autora:spectra:" + kind, ...(detail as object ?? {}) }, "*");
}

/**
 * The editor takes its light or dark from the operating system (`prefers-color-scheme`); Autora is dark in every theme,
 * so on a light machine the PDF window was a white island in a dark app. Said here, before the editor reads it: this
 * frame is always dark. (A theme the person picks inside the editor still wins: that is stored, and read first.)
 */
function followAutoraDark(): void {
  const real = window.matchMedia.bind(window);
  window.matchMedia = (query: string) => {
    if (/prefers-color-scheme:\s*light/.test(query)) return real("not all");
    if (/prefers-color-scheme:\s*dark/.test(query)) return real("all");
    return real(query);
  };
}

export function installHost(): void {
  if (installed) return;
  installed = true;
  followAutoraDark();
  relayPdfjsFetches();
  // The phone's paired-down editor: a class that puts the desktop chrome away and a bar of the tools a thumb can use.
  void import("./phone").then((m) => m.installPhone());

  window.addEventListener("message", (event: MessageEvent) => {
    // Only the window that holds this frame may drive it.
    if (window.parent !== window && event.source !== window.parent) return;
    const msg = event.data as
      | { type?: string; id?: number; ok?: boolean; value?: unknown; event?: string; payload?: unknown }
      | null;
    if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return;

    if (msg.type === "autora:spectra:asset-result" && typeof msg.id === "number") {
      const m = msg as { id: number; status?: number; mime?: string; body?: ArrayBuffer };
      const done = wanting.get(m.id);
      wanting.delete(m.id);
      done?.(new Response(m.body ?? null, { status: m.status ?? 502, headers: m.mime ? { "Content-Type": m.mime } : {} }));
      return;
    }
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
