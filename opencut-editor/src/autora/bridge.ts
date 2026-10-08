/**
 * The editor's only way out: messages to the Autora window that holds this
 * frame (components/OpenCutWindow.tsx).
 *
 * The frame is sandboxed without an origin of its own, so it cannot reach
 * Autora's API, IndexedDB or OPFS. Everything it keeps (projects, media,
 * preferences) goes to the window as a `store` request, and the window answers
 * it over HTTP (server/opencut.ts). Everything the agent does to the project
 * arrives the other way, as a `command`.
 *
 * Opened on its own, with no window around it, the same calls are answered
 * from memory: enough for the editor to be built and driven in a test.
 */

export type StoreOp =
  | { op: "get"; ns: string; key: string }
  | { op: "set"; ns: string; key: string; value: unknown }
  | { op: "remove"; ns: string; key: string }
  | { op: "list"; ns: string }
  | { op: "all"; ns: string }
  | { op: "clear"; ns: string };

const inWindow = window.parent !== window;
let seq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const memory = new Map<string, Map<string, unknown>>();

type Handler = (name: string, args: Record<string, unknown>) => Promise<unknown>;
let handler: Handler | null = null;
type ThemeListener = (vars: Record<string, string>) => void;
const themeListeners = new Set<ThemeListener>();

/** Send a request to the window and wait for its answer. */
function ask<T>(type: string, msg: Record<string, unknown>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    window.parent.postMessage({ type, id, ...msg }, "*");
  });
}

function fromMemory(req: StoreOp): unknown {
  let space = memory.get(req.ns);
  if (!space) memory.set(req.ns, (space = new Map()));
  switch (req.op) {
    case "get":
      return space.get(req.key) ?? null;
    case "set":
      space.set(req.key, req.value);
      return null;
    case "remove":
      space.delete(req.key);
      return null;
    case "list":
      return [...space.keys()];
    case "all":
      return [...space.values()];
    case "clear":
      space.clear();
      return null;
  }
}

export async function store<T = unknown>(req: StoreOp): Promise<T> {
  if (!inWindow) return fromMemory(req) as T;
  return ask<T>("autora:opencut:store", { req });
}

/** The editor tells the window which project it has open. */
export function announce(msg: Record<string, unknown>): void {
  if (inWindow) window.parent.postMessage({ type: "autora:opencut:state", ...msg }, "*");
}

/** Hand a finished file (an export) to the window to keep. */
export function deliver(name: string, mime: string, data: ArrayBuffer): Promise<{ artifact: string }> {
  return ask("autora:opencut:deliver", { name, mime, data });
}

export function onCommand(fn: Handler): void {
  handler = fn;
}

export function onTheme(fn: ThemeListener): () => void {
  themeListeners.add(fn);
  return () => {
    themeListeners.delete(fn);
  };
}

window.addEventListener("message", (e: MessageEvent) => {
  if (e.source !== window.parent) return;
  const msg = e.data as Record<string, unknown> | null;
  if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return;
  if (msg.type === "autora:opencut:result" && typeof msg.id === "number") {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.value);
    else p.reject(new Error(String((msg.value as { message?: string } | null)?.message ?? "Autora could not do that")));
  } else if (msg.type === "autora:opencut:theme" && msg.vars && typeof msg.vars === "object") {
    for (const fn of themeListeners) fn(msg.vars as Record<string, string>);
  } else if (msg.type === "autora:opencut:command" && typeof msg.id === "number" && typeof msg.name === "string") {
    const id = msg.id;
    const run = handler ? handler(msg.name, (msg.args ?? {}) as Record<string, unknown>) : Promise.reject(new Error("The editor is still starting"));
    run.then(
      (value) => window.parent.postMessage({ type: "autora:opencut:reply", id, ok: true, value }, "*"),
      (err: unknown) => window.parent.postMessage({ type: "autora:opencut:reply", id, ok: false, value: { message: String((err as Error)?.message ?? err) } }, "*"),
    );
  }
});

/** Tell the window the editor is up. */
export function ready(): void {
  if (inWindow) window.parent.postMessage({ type: "autora:opencut:ready" }, "*");
}
