import type { Device, ElementInfo, LightInfo, Rect, ReviewComment, StyleChange } from "./preview";

/**
 * Talking to the app window's server side (server.ts, "the app window").
 * Everything is a POST with a small JSON body, and every call can fail in
 * ordinary ways -- the page moved, the element is gone, the preview closed --
 * so each returns null (or an error message) rather than throwing.
 */
export type Reply<T> = { ok: true; data: T } | { ok: false; error: string };

export function previewApi(sessionId: string) {
  const base = `/api/sessions/${sessionId}/preview`;
  async function call<T = any>(method: string, path: string, body?: unknown): Promise<Reply<T>> {
    try {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: String(data?.error ?? `That did not work (${res.status}).`) };
      return { ok: true, data: data as T };
    } catch {
      return { ok: false, error: "Could not reach the server." };
    }
  }
  /** Input to the page itself goes through the browser routes, pointed at the
      preview's browser rather than the agent's. */
  const input = async (path: string, body: unknown) => {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/browser/${path}?target=preview`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      return (await res.json().catch(() => ({}))) as any;
    } catch {
      return {};
    }
  };
  return {
    device: (device: Device) => call("POST", "/device", { device }),
    reload: () => call("POST", "/reload"),
    close: () => call("POST", "/close"),
    at: (x: number, y: number, light = false) =>
      call<{ info: ElementInfo | LightInfo | null }>("POST", "/inspect", { x, y, light }),
    sel: (selector: string, nav?: "parent" | "child" | "next" | "prev", light = false) =>
      call<{ info: ElementInfo | LightInfo | null }>("POST", "/inspect", { selector, nav, light }),
    rects: (selectors: string[]) =>
      call<{ scroll: { x: number; y: number }; rects: Array<Rect | null> }>("POST", "/rects", { selectors }),
    style: (selector: string, css: Record<string, string>) =>
      call<{ before: Record<string, string>; info: ElementInfo }>("POST", "/style", { selector, css }),
    text: (selector: string, text: string) => call<{ info: ElementInfo }>("POST", "/text", { selector, text }),
    reset: (selector: string) => call<{ info: ElementInfo }>("POST", "/reset", { selector }),
    comment: (body: {
      kind: "element" | "region"; text: string; selectors?: string[]; region?: Rect;
      textEdit?: { from: string; to: string }; styleChanges?: StyleChange[];
    }) => call<{ comment: ReviewComment }>("POST", "/comments", body),
    reword: (id: string, text: string) => call("POST", `/comments/${id}`, { text }),
    remove: (id: string) => call("DELETE", `/comments/${id}`),
    send: (text: string) => call("POST", "/send", { text }),
    click: (x: number, y: number, double = false) => input("click", { x, y, double }),
    scroll: (dx: number, dy: number) => input("scroll", { dx, dy }),
    type: (text: string) => input("type", { text }),
    key: (key: string) => input("key", { key }),
  };
}

export type PreviewApi = ReturnType<typeof previewApi>;

export function toHex(color: string | undefined): string {
  const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(color ?? "");
  if (!m) return /^#[0-9a-f]{6}$/i.test(color ?? "") ? (color as string) : "#000000";
  return "#" + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("");
}

export const px = (value: string | undefined): number => {
  const n = parseFloat(value ?? "");
  return Number.isFinite(n) ? n : 0;
};
