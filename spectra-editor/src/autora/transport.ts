/**
 * How the ported renderer reaches Autora.
 *
 * Spectra's renderer talked to Rust over Tauri's IPC. There is no Rust here,
 * and this page runs in a frame sandboxed WITHOUT an origin of its own (it
 * renders PDFs from anywhere, so it must not be able to reach the app or its
 * API if a document turns out to be hostile). That decides the shape of this
 * file, and it is the same decision Autora's own PDF editor lives under:
 *
 *   - In the app, everything goes through the window that holds this frame.
 *     A command is a `postMessage` to the parent, which owns the session and
 *     does the HTTP; the engine's replies come back as messages the parent
 *     relays. This frame never talks to the network itself.
 *   - Opened on its own (a developer looking at the page, or a test harness),
 *     where there is no parent, the same calls go straight to
 *     `POST <base>api/spectra/invoke` and events over
 *     `<base>api/spectra/events`, with the session taken from the page's own
 *     query string. Same server, same command names, nothing else differs.
 *
 * Either way the command names are Spectra's own — they are what its Rust
 * `#[command]`s were called — so this stays a pass-through and Autora's server
 * owns what each one means.
 */

/** Everything up to and including the mount point of Autora: a page at
 *  `${base}spectra-editor/index.html` yields `base` ending in `/`. */
export const BASE = (() => {
  const here = new URL(window.location.href);
  const marker = "/spectra-editor/";
  const at = here.pathname.indexOf(marker);
  const dir = at >= 0 ? here.pathname.slice(0, at) : here.pathname.replace(/[^/]*$/, "");
  return `${here.origin}${dir.endsWith("/") ? dir : `${dir}/`}`;
})();

/** The document this editor is showing, from the page's own address. Only used
 *  on the standalone path; inside the app the parent owns the session. */
export const SESSION = new URL(window.location.href).searchParams.get("session") ?? "";

/** True when this page is inside Autora's window rather than on its own. */
const IN_PARENT = window.parent !== window;

export interface InvokeError {
  error: { code?: number; message: string; kind?: string };
}

/** A bridge failure, shaped like the string error Tauri surfaces so the
 *  renderer's existing error paths read it unchanged. */
export class BridgeError extends Error {
  readonly command: string;

  constructor(command: string, message: string) {
    super(message);
    this.name = "BridgeError";
    this.command = command;
  }
}

function postToParent(msg: Record<string, unknown>): void {
  window.parent.postMessage(msg, "*");
}

// ------------------------------------------------------- event delivery --

type Listener = (payload: unknown) => void;

const listeners = new Map<string, Set<Listener>>();

function deliver(event: string, payload: unknown): void {
  const set = listeners.get(event);
  if (!set) return;
  for (const fn of set) {
    try {
      fn(payload);
    } catch (err) {
      // A throwing listener must not stop the others.
      console.error(`[autora-bridge] listener for ${event} threw`, err);
    }
  }
}

/** Events the parent should relay: told once per event name as it is wanted. */
const wanted = new Set<string>();

function ask(event: string): void {
  if (wanted.has(event)) return;
  wanted.add(event);
  if (IN_PARENT) postToParent({ type: "autora:spectra:listen", event });
}

// ------------------------------------------------ the standalone channel --

/**
 * Out of the app there is no parent to relay, so events come over a socket to
 * the server, which needs a reply to be pushed. Opened on the first listener
 * and kept open: the renderer subscribes before it asks for anything, and a
 * socket that dropped silently would leave a window that looks alive and
 * answers nothing.
 */
let socket: WebSocket | null = null;
let connecting: Promise<void> | null = null;
let retry = 0;

function openSocket(): Promise<void> {
  if (socket && socket.readyState === WebSocket.OPEN) return Promise.resolve();
  if (connecting) return connecting;
  connecting = new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(
      `${BASE.replace(/^http/, "ws")}api/spectra/events?session=${encodeURIComponent(SESSION)}`,
    );
    socket = ws;
    ws.onopen = () => {
      retry = 0;
      connecting = null;
      resolve();
    };
    ws.onmessage = (message) => {
      let parsed: { event?: string; payload?: unknown };
      try {
        parsed = JSON.parse(String(message.data));
      } catch {
        return;
      }
      if (typeof parsed.event === "string") deliver(parsed.event, parsed.payload);
    };
    ws.onerror = () => {
      if (connecting) {
        connecting = null;
        reject(new BridgeError("listen", "Autora's event channel is not reachable"));
      }
    };
    ws.onclose = () => {
      socket = null;
      connecting = null;
      // Reconnect with a capped backoff. The renderer keeps its listeners.
      if (listeners.size) {
        retry = Math.min(retry + 1, 6);
        window.setTimeout(() => {
          openSocket().catch(() => undefined);
        }, 250 * 2 ** retry);
      }
    };
  });
  return connecting;
}

/** Subscribe to an event Rust used to emit. Resolves to the unlisten function. */
export async function subscribe(event: string, fn: Listener): Promise<() => void> {
  let set = listeners.get(event);
  if (!set) {
    set = new Set();
    listeners.set(event, set);
  }
  set.add(fn);
  ask(event);
  if (!IN_PARENT) {
    try {
      await openSocket();
    } catch {
      // Reported through the failure of whatever asked; onclose retries.
    }
  }
  return () => {
    set.delete(fn);
    if (!set.size) listeners.delete(event);
  };
}

/** Called by the window that holds this frame, with one relayed event. */
export function receiveEvent(event: string, payload: unknown): void {
  deliver(event, payload);
}

// ----------------------------------------------------------- invoking --

interface InFlight {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

const inFlight = new Map<number, InFlight>();
let nextId = 1;

/** The window's answer to one command. */
export function settle(id: number, ok: boolean, value: unknown): void {
  const waiting = inFlight.get(id);
  if (!waiting) return;
  inFlight.delete(id);
  if (ok) waiting.resolve(value);
  else {
    const message =
      typeof value === "string"
        ? value
        : ((value as { message?: string } | null)?.message ?? "Autora refused that.");
    const command = (value as { command?: string } | null)?.command ?? "";
    waiting.reject(new BridgeError(command, message));
  }
}

/** One command, sent to Autora's server. */
export async function call<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (IN_PARENT) return callThroughParent<T>(command, args);
  return callDirect<T>(command, args);
}

function callThroughParent<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      inFlight.delete(id);
      reject(new BridgeError(command, "Autora did not answer that in time."));
    }, 15 * 60 * 1000);
    inFlight.set(id, {
      resolve: (value) => {
        window.clearTimeout(timer);
        resolve(value as T);
      },
      reject: (reason) => {
        window.clearTimeout(timer);
        reject(reason);
      },
    });
    postToParent({ type: "autora:spectra:invoke", id, command, args });
  });
}

async function callDirect<T>(command: string, args: Record<string, unknown>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}api/spectra/invoke?session=${encodeURIComponent(SESSION)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command, args }),
    });
  } catch (err) {
    throw new BridgeError(command, `Autora is not reachable: ${(err as Error).message}`);
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Fall through: a route that answered nothing is reported by status below.
  }

  const envelope = (body ?? {}) as { result?: unknown; error?: { message?: string } };
  if (!response.ok || envelope.error) {
    throw new BridgeError(
      command,
      envelope.error?.message ?? `Autora answered ${response.status} for ${command}`,
    );
  }
  return envelope.result as T;
}

/** Drop the socket — used when the window is going away. */
export function closeTransport(): void {
  listeners.clear();
  wanted.clear();
  socket?.close();
  socket = null;
}
