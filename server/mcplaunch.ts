/**
 * Getting an MCP server's launcher to run on this machine.
 *
 * Every catalog server is started with `npx`, which is why the catalog can
 * say that nothing needs installing first. A few of those launchers are not
 * Node programs, though: they download a compiled binary for the platform
 * and run that. @webclaw/mcp is one of them, and its platform map has no
 * musl entry -- linux/x64 always maps to the glibc build. Autora's own
 * container is Alpine (musl), so the launcher caches a binary that cannot
 * exec here, the server dies as it starts, and all the person sees is
 * "MCP error -32000: Connection closed".
 *
 * So before such a server is started we make sure the build for this machine
 * is on disk and put its path in the variable the launcher checks first
 * (WEBCLAW_MCP_BIN). One download, into the data directory rather than
 * /root/.cache -- which a container update wipes -- and the server works.
 *
 * None of it is fatal. A launcher that knows its own machine is left alone,
 * and if the build cannot be fetched the connection error says why.
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { log } from "./logs";
import type { McpServerConfig } from "./mcp";

const WEBCLAW_PKG = "@webclaw/mcp";
const WEBCLAW_REPO = "0xMassi/webclaw";
/** The variable @webclaw/mcp checks before it downloads anything. */
const WEBCLAW_BIN_VAR = "WEBCLAW_MCP_BIN";
/** Used when neither the person nor GitHub says which release to take. */
const WEBCLAW_DEFAULT_TAG = "v0.6.23";
/** How long a release lookup is trusted. */
const TAG_TTL_MS = 6 * 60 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 180_000;

/** The data directory the binary belongs in: not /root, which a container
    update replaces, and not the state directory, which holds settings. */
function binRoot(): string {
  const named = (process.env.AUTORA_MCP_BIN_DIR || "").trim();
  if (named) return named;
  const home = (process.env.AUTORA_HOME || "").trim() || "/data";
  return path.join(home, "bin");
}

/** True on a musl Linux: this machine cannot run a glibc build. */
export function isMusl(): boolean {
  if (process.platform !== "linux") return false;
  try {
    const header = (process as any).report?.getReport?.()?.header;
    return !header?.glibcVersionRuntime;
  } catch {
    return false;
  }
}

/** The release's own name for this machine's build. */
function targetTriple(): string | null {
  if (process.arch === "x64") return "x86_64-unknown-linux-musl";
  if (process.arch === "arm64") return "aarch64-unknown-linux-musl";
  return null;
}

function isRunnable(file: string): boolean {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() && stat.size > 1_000_000 && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** One file out of an uncompressed tar (ustar: 512-byte headers, name and
    size in ASCII, the rest padded to 512). Its own reader rather than the
    container's `tar`, which is not guaranteed to be there. */
export function untarEntry(tar: Buffer, base: string): Buffer | null {
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const field = (from: number, to: number) =>
      header.subarray(from, to).toString("utf8").replace(/\0.*$/, "").trim();
    const prefix = field(345, 500);
    const name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    const size = parseInt(field(124, 136), 8) || 0;
    const type = String.fromCharCode(header[156] || 48);
    if ((type === "0" || type === "1") && name.split("/").pop() === base) {
      return Buffer.from(tar.subarray(offset + 512, offset + 512 + size));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return null;
}

/** The release to take: what the person pinned, else the newest, else a pin. */
async function releaseTag(dir: string): Promise<string> {
  const pinned = (process.env.WEBCLAW_MCP_VERSION || "").trim();
  if (pinned) return pinned;

  const cache = path.join(dir, "latest.json");
  try {
    const cached = JSON.parse(fs.readFileSync(cache, "utf8"));
    if (typeof cached?.tag === "string" && Date.now() - Number(cached.at) < TAG_TTL_MS) return cached.tag;
  } catch { /* nothing cached yet */ }

  try {
    const res = await fetch(`https://api.github.com/repos/${WEBCLAW_REPO}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "autora" },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const tag = String(((await res.json()) as any)?.tag_name ?? "").trim();
      if (/^v?\d+\.\d+/.test(tag)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
        fs.writeFileSync(cache, JSON.stringify({ tag, at: Date.now() }));
        return tag;
      }
    }
  } catch { /* offline, or rate-limited: the pin will do */ }

  return WEBCLAW_DEFAULT_TAG;
}

/** The musl build of the webclaw CLI, fetching it if this machine has not
    got it. Throws with a reason if it cannot be had. */
export async function ensureWebclawBinary(): Promise<string> {
  const triple = targetTriple();
  if (!triple) throw new Error(`no musl build is published for ${process.arch}`);
  const dir = path.join(binRoot(), "webclaw");
  const tag = await releaseTag(dir);
  const file = path.join(dir, tag, "webclaw-mcp");
  if (isRunnable(file)) return file;

  const url = `https://github.com/${WEBCLAW_REPO}/releases/download/${tag}/webclaw-${tag}-${triple}.tar.gz`;
  log("info", "mcp", `webclaw: fetching ${tag} (${triple})`);
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  const inner = untarEntry(zlib.gunzipSync(Buffer.from(await res.arrayBuffer())), "webclaw-mcp");
  if (!inner) throw new Error("the archive has no webclaw-mcp in it");

  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
  fs.writeFileSync(file, inner, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
  if (!isRunnable(file)) throw new Error("the build that arrived is not executable");
  log("info", "mcp", `webclaw: ${tag} ready at ${file}`);
  return file;
}

/** Which server a config is, for the ones that need looking after. */
function isWebclaw(cfg: McpServerConfig): boolean {
  if (cfg.transport !== "stdio") return false;
  return `${cfg.command ?? ""} ${(cfg.args ?? []).join(" ")}`.includes(WEBCLAW_PKG);
}

/**
 * Environment a stdio server needs before it starts, worked out here rather
 * than by the person. Empty for every server that looks after itself.
 */
export async function prepareStdioEnv(cfg: McpServerConfig): Promise<Record<string, string>> {
  if (!isWebclaw(cfg)) return {};

  const pointed = (cfg.env?.[WEBCLAW_BIN_VAR] || process.env[WEBCLAW_BIN_VAR] || "").trim();
  if (pointed && isRunnable(pointed)) return {};       // already someone else's business
  if (!isMusl()) return {};                            // the launcher's own choice is right here

  try {
    const file = await ensureWebclawBinary();
    return { [WEBCLAW_BIN_VAR]: file };
  } catch (err: any) {
    log("warn", "mcp", `webclaw: no musl build available (${err?.message ?? err}); leaving it to its launcher`);
    return {};
  }
}

/** A sentence for the person when such a server still will not start. */
export function launchHint(cfg: McpServerConfig, error: string | null): string | null {
  if (!isWebclaw(cfg) || !isMusl()) return null;
  if (!/closed|spawn|ENOENT|not found/i.test(error ?? "")) return null;
  return `Its launcher downloads the wrong build for this machine (glibc on musl) and Autora could not fetch the right one. ` +
    `Check this machine can reach github.com, then reconnect. A build can also be dropped in by hand and named in ${WEBCLAW_BIN_VAR}.`;
}
