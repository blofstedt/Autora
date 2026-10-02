/**
 * Chrome extensions for the browser.
 *
 * Each lives unpacked in its own folder under AUTORA_HOME/extensions and is
 * loaded when the browser starts (see launchArgs, used by browser.ts), so a
 * change takes effect the next time the browser restarts. They run in the
 * page like in any Chrome: an ad blocker blocks, a password manager fills.
 *
 * An extension sees every page the browser opens, signed-in ones included,
 * so nothing is installed unless the person asks for it by name.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";
import { stateFilePath } from "./state";

export interface ExtensionInfo {
  /** The id Chrome gives it: for an unpacked folder, from the folder's path. */
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  /** "store" with the Web Store id it came from, or "file". */
  source: "store" | "file";
  /** Its popup page, when the toolbar button opens one. */
  popup: string | null;
  options: string | null;
}

const MAX_BYTES = 60 * 1024 * 1024;

const root = () => path.join(path.dirname(stateFilePath()), "extensions");

/** Chrome's id for an extension loaded from a folder with no key: the first
    half of the SHA-256 of its path, in the letters a to p. */
export function idForPath(dir: string): string {
  const hex = crypto.createHash("sha256").update(path.resolve(dir)).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode("a".charCodeAt(0) + parseInt(c, 16))).join("");
}

function manifestOf(dir: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

/** "__MSG_name__" is in the extension's own locale files; use them if there. */
function localised(dir: string, text: unknown, fallback: string, manifest: any): string {
  const raw = String(text ?? "");
  const m = /^__MSG_(.+)__$/.exec(raw);
  if (!m) return raw || fallback;
  const lang = String(manifest?.default_locale ?? "en");
  for (const l of [lang, "en"]) {
    try {
      const messages = JSON.parse(fs.readFileSync(path.join(dir, "_locales", l, "messages.json"), "utf8"));
      const hit = Object.entries(messages).find(([k]) => k.toLowerCase() === m[1].toLowerCase())?.[1] as any;
      if (hit?.message) return String(hit.message);
    } catch { /* next */ }
  }
  return fallback;
}

export function listExtensions(): ExtensionInfo[] {
  const out: ExtensionInfo[] = [];
  let names: string[] = [];
  try { names = fs.readdirSync(root()); } catch { return out; }
  for (const name of names) {
    const dir = path.join(root(), name);
    const manifest = manifestOf(path.join(dir, "pkg"));
    if (!manifest) continue;
    let meta: { enabled?: boolean; source?: "store" | "file" } = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, "autora.json"), "utf8")); } catch { /* defaults */ }
    const id = idForPath(path.join(dir, "pkg"));
    const popup = manifest.action?.default_popup ?? manifest.browser_action?.default_popup ?? null;
    const options = manifest.options_ui?.page ?? manifest.options_page ?? null;
    out.push({
      id,
      name: localised(path.join(dir, "pkg"), manifest.name, name, manifest),
      version: String(manifest.version ?? ""),
      enabled: meta.enabled !== false,
      source: meta.source ?? "file",
      popup: popup ? `chrome-extension://${id}/${String(popup).replace(/^\//, "")}` : null,
      options: options ? `chrome-extension://${id}/${String(options).replace(/^\//, "")}` : null,
    });
  }
  return out;
}

/** The folders of the enabled extensions. */
function enabledDirs(): string[] {
  const ids = new Set(listExtensions().filter((e) => e.enabled).map((e) => e.id));
  let names: string[] = [];
  try { names = fs.readdirSync(root()); } catch { return []; }
  return names
    .map((n) => path.join(root(), n, "pkg"))
    .filter((d) => ids.has(idForPath(d)));
}

/** Chrome's command line for what is installed: nothing when nothing is. */
export function launchArgs(): string[] {
  const dirs = enabledDirs();
  if (!dirs.length) return [];
  const list = dirs.join(",");
  return [`--disable-extensions-except=${list}`, `--load-extension=${list}`, "--headless=new"];
}

export function hasExtensions(): boolean {
  return enabledDirs().length > 0;
}

/** A CRX is a zip behind a header; a plain zip is taken as it is. */
export function zipOf(bytes: Buffer): Buffer {
  if (bytes.subarray(0, 4).toString("latin1") !== "Cr24") return bytes;
  const version = bytes.readUInt32LE(4);
  if (version === 3) return bytes.subarray(12 + bytes.readUInt32LE(8));
  if (version === 2) return bytes.subarray(16 + bytes.readUInt32LE(8) + bytes.readUInt32LE(12));
  throw new Error(`Unknown extension package version ${version}.`);
}

/** Unpack a package into a folder of its own. */
export function installPackage(bytes: Buffer, source: "store" | "file", key: string): ExtensionInfo {
  if (bytes.byteLength > MAX_BYTES) throw new Error("That extension is too large.");
  const files = unzipSync(new Uint8Array(zipOf(bytes)));
  if (!files["manifest.json"]) throw new Error("That is not a Chrome extension: it has no manifest.json.");
  const slug = key.replace(/[^a-z0-9._-]/gi, "_").slice(0, 60) || crypto.randomBytes(6).toString("hex");
  const dir = path.join(root(), slug);
  const pkg = path.join(dir, "pkg");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(pkg, { recursive: true, mode: 0o700 });
  for (const [name, data] of Object.entries(files)) {
    if (name.endsWith("/")) continue;
    const target = path.resolve(pkg, name);
    // A package cannot write outside its own folder.
    if (target !== pkg && !target.startsWith(pkg + path.sep)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  }
  fs.writeFileSync(path.join(dir, "autora.json"), JSON.stringify({ enabled: true, source }));
  const id = idForPath(pkg);
  const info = listExtensions().find((e) => e.id === id);
  if (!info) throw new Error("The extension did not unpack.");
  return info;
}

/** A Chrome Web Store id, from the id itself or a store address. */
export function storeIdOf(text: string): string | null {
  const t = text.trim();
  if (/^[a-p]{32}$/.test(t)) return t;
  try {
    const u = new URL(t);
    if (!/(^|\.)(chromewebstore\.google\.com|chrome\.google\.com)$/.test(u.hostname)) return null;
    return u.pathname.split("/").find((p) => /^[a-p]{32}$/.test(p)) ?? null;
  } catch {
    return null;
  }
}

export async function installFromStore(input: string): Promise<ExtensionInfo> {
  const id = storeIdOf(input);
  if (!id) throw new Error("Give a Chrome Web Store address or the extension's 32-letter id.");
  const url =
    "https://clients2.google.com/service/update2/crx?response=redirect&os=linux&arch=x64&os_arch=x86_64" +
    `&nacl_arch=x86-64&prod=chromiumcrx&prodchannel=unknown&prodversion=130.0.0.0&acceptformat=crx2,crx3&x=id%3D${id}%26uc`;
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`The Web Store did not send it (${res.status}).`);
  return installPackage(Buffer.from(await res.arrayBuffer()), "store", id);
}

function folderOf(id: string): string | null {
  try {
    for (const name of fs.readdirSync(root())) {
      if (idForPath(path.join(root(), name, "pkg")) === id) return path.join(root(), name);
    }
  } catch { /* none */ }
  return null;
}

export function setExtensionEnabled(id: string, enabled: boolean): boolean {
  const dir = folderOf(id);
  if (!dir) return false;
  let meta: Record<string, unknown> = {};
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, "autora.json"), "utf8")); } catch { /* new */ }
  fs.writeFileSync(path.join(dir, "autora.json"), JSON.stringify({ ...meta, enabled }));
  return true;
}

export function removeExtension(id: string): boolean {
  const dir = folderOf(id);
  if (!dir) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}
