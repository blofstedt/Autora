/**
 * Version history for the folder the agent builds in.
 *
 * Each turn that changed code is saved as a snapshot, and any snapshot can be
 * put back. The history lives in a git directory of its own under Autora's
 * state, with the project as its work tree, so the project's own .git (or the
 * lack of one) is never touched: no commits appear in the person's repo, and
 * restoring works in a folder that was never under version control.
 *
 * Restoring first saves the present, so a restore can itself be undone.
 */

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { stateDir } from "./state";

const run = promisify(execFile);

export interface Snapshot { id: string; label: string; ts: number; files: number }

/** What is never saved: dependencies and build output, which are rebuilt, and
    the person's own repository data. */
const EXCLUDE = [
  "node_modules/", ".git/", "dist/", "build/", ".next/", ".nuxt/", ".svelte-kit/", ".cache/", ".parcel-cache/",
  "__pycache__/", ".venv/", "venv/", "target/", "coverage/", ".turbo/", "*.log", ".env", ".env.*",
];
const MAX_FILE_BYTES = 5 * 1024 * 1024;

function gitDirFor(folder: string): string {
  const key = crypto.createHash("sha1").update(path.resolve(folder)).digest("hex").slice(0, 16);
  return path.join(stateDir(), "snapshots", `${key}.git`);
}

async function git(folder: string, args: string[]): Promise<string> {
  const dir = gitDirFor(folder);
  const { stdout } = await run("git", [`--git-dir=${dir}`, `--work-tree=${path.resolve(folder)}`, ...args], {
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60_000,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Autora", GIT_AUTHOR_EMAIL: "autora@localhost",
      GIT_COMMITTER_NAME: "Autora", GIT_COMMITTER_EMAIL: "autora@localhost",
    },
  });
  return stdout;
}

async function ensure(folder: string) {
  const dir = gitDirFor(folder);
  if (fs.existsSync(path.join(dir, "HEAD"))) return;
  fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
  await run("git", ["init", "-q", "--bare", dir]);
  fs.mkdirSync(path.join(dir, "info"), { recursive: true });
  fs.writeFileSync(path.join(dir, "info", "exclude"), EXCLUDE.join("\n") + "\n");
  await git(folder, ["config", "core.bare", "false"]);
  await git(folder, ["config", "core.autocrlf", "false"]);
}

/** Too large to follow: a home directory is not a project. */
async function tooBig(folder: string): Promise<boolean> {
  const out = await git(folder, ["ls-files", "--others", "--cached", "--exclude-standard"]).catch(() => "");
  return out.split("\n").length > 5000;
}

/**
 * Save the folder as it is, if it differs from the last snapshot. Returns the
 * snapshot, or null when nothing changed or the folder is not a project.
 */
export async function snapshot(folder: string, label: string): Promise<Snapshot | null> {
  try {
    await ensure(folder);
    await git(folder, ["add", "-A", "--", "."]);
    // A file too large to be source stays out.
    const staged = (await git(folder, ["diff", "--cached", "--numstat", "-z"]).catch(() => "")).split("\0").filter(Boolean);
    for (const entry of staged) {
      const file = entry.split("\t")[2];
      if (!file) continue;
      try {
        if (fs.statSync(path.join(folder, file)).size > MAX_FILE_BYTES) await git(folder, ["rm", "--cached", "-q", "--", file]);
      } catch { /* gone already */ }
    }
    const pending = (await git(folder, ["status", "--porcelain"])).trim();
    if (!pending) return null;
    if (await tooBig(folder)) return null;
    await git(folder, ["commit", "-q", "-m", label.replace(/\s+/g, " ").trim().slice(0, 200) || "Snapshot"]);
    return (await versions(folder, 1))[0] ?? null;
  } catch {
    return null;
  }
}

/** Newest first. */
export async function versions(folder: string, limit = 50): Promise<Snapshot[]> {
  if (!fs.existsSync(path.join(gitDirFor(folder), "HEAD"))) return [];
  try {
    const out = await git(folder, ["log", `-n${limit}`, "--format=%H%x1f%ct%x1f%s", "--shortstat"]);
    const list: Snapshot[] = [];
    for (const line of out.split("\n")) {
      if (line.includes("\x1f")) {
        const [id, ts, label] = line.split("\x1f");
        list.push({ id, label: label ?? "", ts: Number(ts) * 1000, files: 0 });
      } else if (list.length) {
        const n = /(\d+) files? changed/.exec(line)?.[1];
        if (n) list[list.length - 1].files = Number(n);
      }
    }
    return list;
  } catch {
    return [];
  }
}

/** Put the folder back as it was at `id`; files made since are removed. */
export async function restore(folder: string, id: string): Promise<Snapshot | null> {
  if (!/^[0-9a-f]{40}$/.test(id)) throw new Error("Not a snapshot.");
  await ensure(folder);
  await snapshot(folder, "Before restoring an earlier version");
  const old = (await versions(folder, 200)).find((v) => v.id === id);
  if (!old) throw new Error("That version is not in the history.");
  await git(folder, ["read-tree", "--reset", "-u", id]);
  const saved = await snapshot(folder, `Restored: ${old.label}`);
  return saved;
}
