/**
 * `@tauri-apps/plugin-fs`, over Autora.
 *
 * A page cannot touch the filesystem, so every call here is a round trip to
 * Autora's server, which does the work under the document's own folder. Byte
 * bodies cross as base64 — JSON cannot carry a Uint8Array.
 */
import { call } from "./transport";
// invoke, not call: it is where byte answers come back as bytes (see core.ts).
import { invoke } from "./core";

function toBase64(data: Uint8Array | string): string {
  if (typeof data === "string") return btoa(unescape(encodeURIComponent(data)));
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < data.length; i += chunk) {
    binary += String.fromCharCode(...data.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Reading: Tauri answers an ArrayBuffer, and so does the bridge here — the
 *  bytes are turned back from base64 at the invoke boundary (autora/core.ts). */
export async function readFile(
  path: string,
  options?: { encoding?: string } | string,
): Promise<Uint8Array> {
  const buffer = await invoke<ArrayBuffer>("read_file_binary", { filePath: path });
  return new Uint8Array(buffer);
}

export async function readTextFile(path: string): Promise<string> {
  return new TextDecoder().decode(await readFile(path));
}

export async function exists(path: string): Promise<boolean> {
  return call<boolean>("path_exists", { path });
}

export async function writeFile(
  path: string,
  data: Uint8Array | string,
  _options?: unknown,
): Promise<void> {
  await call<void>("write_file_binary", { path, base64: toBase64(data) });
}

export async function writeTextFile(path: string, data: string): Promise<void> {
  await call<void>("write_file_text", { path, text: data });
}

export async function rename(oldPath: string, newPath: string): Promise<void> {
  await call<void>("rename_path", { from: oldPath, to: newPath });
}

export async function remove(path: string, options?: { recursive?: boolean }): Promise<void> {
  await call<void>("remove_path", { path, recursive: Boolean(options?.recursive) });
}

export async function mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
  await call<void>("make_dir", { path, recursive: Boolean(options?.recursive) });
}

export async function readDir(path: string): Promise<Array<{ name: string; isDirectory: boolean }>> {
  return call("read_dir", { path });
}

export async function stat(path: string): Promise<{ size: number; isDirectory: boolean; mtime: number }> {
  return call("stat_path", { path });
}
