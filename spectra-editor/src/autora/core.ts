/**
 * `@tauri-apps/api/core`, over Autora.
 *
 * `invoke` keeps Tauri's exact shape — a command name and an argument bag —
 * because it is called from about a hundred places in Spectra's renderer and
 * the whole point of the port is that none of them change. The command name
 * is passed through to Autora's server, which owns what it means.
 */
import { call } from "./transport";

/**
 * The commands whose answer is bytes. JSON cannot carry an ArrayBuffer, so
 * they cross as base64 and are turned back here, where Tauri's own boundary
 * was: the renderer is written against `invoke` returning an ArrayBuffer from
 * `read_file_binary`, and every one of its readers expects that.
 */
const BYTE_RESULTS = new Set(["read_file_binary", "read_file_binary_capped"]);

function fromBase64(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function toBase64(data: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < data.length; i += chunk) {
    binary += String.fromCharCode(...data.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Arguments that carry bytes, named as Tauri named them. */
const BYTE_ARGS = ["contents", "content", "data", "bytes"];

function shapeArgs(command: string, args: Record<string, unknown>): Record<string, unknown> {
  let out = args;
  for (const key of BYTE_ARGS) {
    const value = out[key];
    if (value instanceof Uint8Array) {
      if (out === args) out = { ...args };
      out[key] = toBase64(value);
      out[`${key}Encoding`] = "base64";
    } else if (value instanceof ArrayBuffer) {
      if (out === args) out = { ...args };
      out[key] = toBase64(new Uint8Array(value));
      out[`${key}Encoding`] = "base64";
    }
  }
  return out;
}

export async function invoke<T = unknown>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const result = await call<unknown>(command, shapeArgs(command, args ?? {}));
  if (BYTE_RESULTS.has(command) && result && typeof result === "object") {
    const base64 = (result as { base64?: unknown }).base64;
    if (typeof base64 === "string") return fromBase64(base64) as T;
  }
  return result as T;
}

/**
 * Tauri's Channel: a one-way pipe a command answers on, out of band from its
 * return value. Spectra uses it for long operations that report progress.
 * Autora delivers those as events named for the channel id.
 */
export class Channel<T = unknown> {
  /** Set by the caller, as in Tauri. */
  onmessage: (message: T) => void = () => {};

  /** Autora needs a name to address this channel's events by. */
  readonly id: string = `ch_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

  /** Called by the transport when an event names this channel. */
  __deliver(message: T): void {
    this.onmessage?.(message);
  }
}

/** Tauri's `convertFileSrc`: a path an <img>/<video> can load. Autora serves
 *  the document itself, so the renderer asks for it by path. */
export function convertFileSrc(filePath: string): string {
  return filePath;
}
