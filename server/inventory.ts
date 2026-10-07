/**
 * What this machine has, looked up once and then remembered.
 *
 * Every session used to start blind: which shell, whether docker is here,
 * where python is, what is in the working directory -- each of those was
 * discovered again by running commands to find out, and the discovering cost
 * a round-trip or three before any work started. Worse, an old fact about the
 * machine (there is no python3; the work is in /root/work) could be carried in
 * the memory graph long after it stopped being true, and nothing checked.
 *
 * So: a probe, cheap and synchronous, kept on disk with the time it was taken.
 * The first session after a restart is given it as a note, and it can be
 * looked at again on demand. Nothing here runs a command -- a `which` is a
 * path check, not a shell -- so it costs milliseconds and can happen inside a
 * turn that is already busy.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readDoc, saveDoc } from "./store";
import { stateDir } from "./state";

interface Inventory {
  /** Milliseconds since the epoch, when this was worked out. */
  at: number;
  /** The machine, one fact per line, phrased to be read by the model. */
  lines: string[];
}

/** How long a look at the machine is trusted before it is taken again. */
const TTL_MS = 6 * 3600 * 1000;

/** The commands worth knowing about. Not everything on the box: the ones that
    change what can be done -- a build, a database, a picture, a PDF, a
    browser, the host it is running on. */
const WANTED = [
  "git", "node", "npm", "pnpm", "yarn", "bun", "tsx",
  "python3", "pip3", "uv", "ruby", "php", "go", "cargo", "gcc", "make",
  "docker", "docker-compose", "podman", "kubectl", "systemctl", "umbreld", "tailscale",
  "ffmpeg", "magick", "convert", "tesseract", "pdftotext", "qpdf", "libreoffice",
  "jq", "yq", "sqlite3", "psql", "mysql", "redis-cli",
  "curl", "wget", "rsync", "ssh", "scp", "unzip", "zip", "tar", "xz", "zstd",
  "chromium", "chromium-browser", "google-chrome", "playwright",
  "setsid", "timeout", "crontab", "flock", "watch",
];

/** Where an executable of this name is, or null. Checks the shebang too: a
    wrapper script that execs something elsewhere is worth knowing about, since
    it behaves differently from the real thing. */
function where(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      if (!st.isFile()) continue;
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch {
      // Not here; the next directory.
    }
  }
  return null;
}

function isWrapper(file: string): boolean {
  try {
    const st = fs.statSync(file);
    if (st.size > 4096) return false;
    const head = fs.readFileSync(file, "utf8").slice(0, 200);
    return head.startsWith("#!") && /exec|python|node/.test(head.split("\n").slice(-3).join("\n"));
  } catch {
    return false;
  }
}

function human(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let unit = 0;
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024;
    unit += 1;
  }
  return `${n < 10 && unit > 1 ? n.toFixed(1) : Math.round(n)} ${units[unit]}`;
}

/** The top of the working directory, so the agent knows what it is standing
    in rather than listing it to find out. */
function topOf(dir: string, limit = 14): string | null {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => !e.name.startsWith(".") || e.name === ".git" || e.name === ".env")
      .slice(0, limit)
      .map((e) => `${e.name}${e.isDirectory() ? "/" : ""}`);
    return entries.length ? entries.join(", ") : "(empty)";
  } catch {
    return null;
  }
}

function workdir(): string {
  const fromEnv = (process.env.AUTORA_WORKDIR || "").trim();
  if (fromEnv) return fromEnv;
  return process.cwd();
}

function look(): Inventory {
  const lines: string[] = [];
  const shell = ["/bin/bash", "/usr/bin/bash", "/bin/sh"].find((s) => fs.existsSync(s)) ?? "sh";
  const user = (() => {
    try {
      return os.userInfo().username;
    } catch {
      return "unknown";
    }
  })();
  const host = (() => {
    try {
      return os.hostname();
    } catch {
      return "unknown";
    }
  })();

  lines.push(
    `The machine: ${os.platform()} ${os.arch()}, ${host}, as ${user}, ` +
    `node ${process.version.replace(/^v/, "")}, shell ${shell}. ` +
    `Autora's own files are in ${stateDir()}.`,
  );

  const have: string[] = [];
  const missing: string[] = [];
  const wrappers: string[] = [];
  for (const name of WANTED) {
    const at = where(name);
    if (!at) {
      missing.push(name);
      continue;
    }
    have.push(name);
    if (isWrapper(at)) wrappers.push(`${name} (a wrapper at ${at}, not the real thing)`);
  }
  lines.push(`Installed: ${have.join(", ")}.`);
  if (missing.length) lines.push(`Not installed: ${missing.join(", ")}.`);
  if (wrappers.length) lines.push(`Worth knowing: ${wrappers.join("; ")}.`);

  const dir = workdir();
  const top = topOf(dir);
  lines.push(
    `Commands start in ${dir}${fs.existsSync(path.join(dir, ".git")) ? " (a git repository)" : ""}` +
    `${top ? `, which holds: ${top}.` : "."}`,
  );

  try {
    const st = fs.statfsSync(dir);
    lines.push(`Disk: ${human(st.bavail * st.bsize)} free of ${human(st.blocks * st.bsize)}.`);
  } catch {
    // No statfs here; the disk is the least of it.
  }

  if (fs.existsSync("/.dockerenv") || fs.existsSync("/run/.containerenv")) {
    lines.push(
      "It is running inside a container: the host's filesystem is where it is mounted, " +
      "and a container restart takes anything not written to a mounted path with it.",
    );
  }

  return { at: Date.now(), lines };
}

let loaded = false;
let current: Inventory | null = null;

export function get(refresh = false): Inventory {
  if (!loaded) {
    loaded = true;
    const stored = readDoc<Inventory>("inventory");
    current = stored && Array.isArray(stored.lines) && typeof stored.at === "number" ? stored : null;
  }
  if (refresh || !current || Date.now() - current.at > TTL_MS) {
    current = look();
    saveDoc("inventory", () => current);
  }
  return current!;
}

/** A line saying how old this look is, for whoever is about to trust it. */
function age(at: number): string {
  const mins = Math.round((Date.now() - at) / 60_000);
  if (mins < 2) return "just now";
  if (mins < 90) return `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  return hours < 36 ? `${hours} hours ago` : `${Math.round(hours / 24)} days ago`;
}

/**
 * What the first turn of a session is told about the machine. Empty when it
 * has already been said in this process and the look is still fresh: the note
 * stays in the session's own history, so repeating it every turn would be
 * paying for the same paragraph again and again.
 */
const told = new Set<string>();
export function inventoryBriefing(sessionId: string, refresh = false): string {
  if (!refresh && told.has(sessionId)) return "";
  const seen = get(refresh);
  told.add(sessionId);
  return [
    `What this machine has, looked at ${age(seen.at)} (call inventory for a fresh look):`,
    ...seen.lines,
  ].join("\n");
}
