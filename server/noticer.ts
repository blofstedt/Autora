/**
 * What the console notices without being asked.
 *
 * Something alive pays attention. Before this, a disk that filled up, an app
 * restarting in a loop beside Autora on the same box, or a schedule that had
 * failed every night for a week were all visible to anyone who went looking
 * -- and nobody goes looking. So a few cheap checks run every few minutes, and
 * what they find is said once, with one tap to have the agent look into it.
 *
 * The checks are deliberately few and deliberately dumb: numbers and states
 * that are either true or not, read without a model and without running a
 * command (Docker is asked over its socket, read-only). A notice is a fact
 * with a suggested next step, never an action; nothing here changes anything.
 *
 * Each notice has a key that names the condition, and the condition is the
 * whole of its life: said once when it first appears (and not again after a
 * restart), kept quiet once the person dismisses it, and forgotten -- dismissal
 * included -- when it clears, so the next time it happens is news again.
 */

import http from "node:http";
import fs from "node:fs";
import type { Container, JobBrief } from "./suggest";
import { troubled } from "./suggest";

export interface Noticed {
  key: string;
  tone: "warn" | "bad";
  title: string;
  detail: string;
  /** What "Look into it" sends. */
  prompt: string;
  /** When it was first seen, in seconds. */
  since: number;
}

export type Finding = Omit<Noticed, "since">;

export interface Readings {
  disk: { used: number; total: number } | null;
  containers: Container[] | null;
  jobs: JobBrief[];
}

/** How full a disk has to be to say so, and to say so louder. */
export const DISK_WARN = 0.9;
export const DISK_CRITICAL = 0.97;

function size(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n < 10 && i > 1 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

/** What is wrong right now, from one set of readings. */
export function findings(r: Readings): Finding[] {
  const out: Finding[] = [];

  if (r.disk && r.disk.total > 0) {
    const share = r.disk.used / r.disk.total;
    if (share >= DISK_WARN) {
      const pct = Math.round(share * 100);
      const free = size(Math.max(0, r.disk.total - r.disk.used));
      const critical = share >= DISK_CRITICAL;
      out.push({
        // A different key when it gets worse, so a dismissed "90% full" does
        // not keep "almost out of space" quiet.
        key: critical ? "disk:critical" : "disk",
        tone: critical ? "bad" : "warn",
        title: critical ? `The disk is almost out of space (${pct}%)` : `The disk is ${pct}% full`,
        detail: `${free} left on the disk Autora's data is on.`,
        prompt:
          `The disk is ${pct}% full, with ${free} left. Find the biggest folders and files on it, and ` +
          "tell me what is safe to clear and how much it would free. Delete nothing yet.",
      });
    }
  }

  for (const c of r.containers ?? []) {
    const trouble = troubled(c);
    if (!trouble) continue;
    out.push({
      key: `container:${trouble}:${c.name}`,
      tone: trouble === "restarting" ? "bad" : "warn",
      title: trouble === "restarting" ? `${c.name} keeps restarting` : `${c.name} is unhealthy`,
      detail: `Docker says: ${c.status}.`,
      prompt:
        `The container ${c.name} is ${trouble === "restarting" ? "restarting over and over" : "failing its health check"} ` +
        `(${c.status}). Read its logs, find out why, and tell me what would fix it. Change nothing yet.`,
    });
  }

  for (const job of r.jobs) {
    if (!job.enabled || !job.failed) continue;
    out.push({
      key: `job:${job.id}`,
      tone: "warn",
      title: `“${job.name}” failed`,
      detail: (job.last_error || "Its last run did not finish.").slice(0, 160),
      prompt:
        `My scheduled task “${job.name}” failed on its last run` +
        `${job.last_error ? ` with: ${job.last_error.slice(0, 300)}` : ""}. Find out why, and fix the task ` +
        "if the fix is in the task itself; otherwise tell me what is wrong.",
    });
  }

  return out;
}

/** What is kept on disk between restarts. */
export interface NoticerMemory {
  /** Conditions already said, by key, with when they were first seen. */
  announced: Record<string, number>;
  /** Conditions the person waved away, until they clear. */
  dismissed: Record<string, number>;
}

/**
 * The notices over time: what is current, what is new, what was dismissed.
 *
 * `update` takes a fresh set of findings and returns only the ones to announce
 * -- new since the last look, and not already said before a restart.
 */
export class Noticer {
  private active = new Map<string, Noticed>();

  constructor(
    private readonly memory: NoticerMemory,
    private readonly changed: () => void = () => undefined,
  ) {}

  update(found: Finding[], now = Math.floor(Date.now() / 1000)): Noticed[] {
    const keys = new Set(found.map((f) => f.key));
    let dirty = false;
    // Cleared: gone from the list, and from memory, so a return is news.
    for (const key of [...this.active.keys()]) if (!keys.has(key)) this.active.delete(key);
    for (const store of [this.memory.announced, this.memory.dismissed]) {
      for (const key of Object.keys(store)) {
        if (!keys.has(key)) {
          delete store[key];
          dirty = true;
        }
      }
    }
    const fresh: Noticed[] = [];
    for (const f of found) {
      const seen = this.active.get(f.key);
      if (seen) {
        // Still true; the numbers in it may have moved.
        this.active.set(f.key, { ...f, since: seen.since });
        continue;
      }
      const since = this.memory.announced[f.key] ?? now;
      const n = { ...f, since };
      this.active.set(f.key, n);
      if (this.memory.announced[f.key] === undefined) {
        this.memory.announced[f.key] = now;
        dirty = true;
        if (!this.memory.dismissed[f.key]) fresh.push(n);
      }
    }
    if (dirty) this.changed();
    return fresh;
  }

  /** What is true and not waved away, worst first. */
  list(): Noticed[] {
    return [...this.active.values()]
      .filter((n) => !this.memory.dismissed[n.key])
      .sort((a, b) => (a.tone === b.tone ? b.since - a.since : a.tone === "bad" ? -1 : 1));
  }

  get(key: string): Noticed | undefined {
    return this.active.get(key);
  }

  dismiss(key: string, now = Math.floor(Date.now() / 1000)): boolean {
    if (!this.active.has(key)) return false;
    this.memory.dismissed[key] = now;
    this.changed();
    return true;
  }
}

// ------------------------------------------------------------------ docker --

/** Where Docker's socket may be: the usual place, and the host's, which the
    Umbrel app mounts at /host. */
const SOCKETS = ["/var/run/docker.sock", "/host/var/run/docker.sock", "/host/run/docker.sock"];

function socketPath(): string | null {
  const fromEnv = (process.env.DOCKER_HOST || "").trim();
  if (fromEnv.startsWith("unix://")) return fromEnv.slice("unix://".length);
  for (const candidate of SOCKETS) {
    try {
      if (fs.statSync(candidate).isSocket()) return candidate;
    } catch {
      /* not there */
    }
  }
  return null;
}

/**
 * The containers on this machine, read from Docker's API over its socket --
 * one GET, no CLI needed, nothing changed. Null when there is no Docker to
 * ask, which is different from a Docker with nothing running.
 */
export function dockerContainers(timeoutMs = 3000): Promise<Container[] | null> {
  const socket = socketPath();
  if (!socket) return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = http.get({ socketPath: socket, path: "/containers/json?all=true", timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
        if (body.length > 4_000_000) req.destroy();
      });
      res.on("end", () => {
        try {
          const rows = JSON.parse(body);
          if (!Array.isArray(rows)) return resolve(null);
          resolve(rows.map((row: any) => ({
            name: String(row?.Names?.[0] ?? row?.Id ?? "container").replace(/^\//, ""),
            state: String(row?.State ?? ""),
            status: String(row?.Status ?? ""),
          })));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });
}
