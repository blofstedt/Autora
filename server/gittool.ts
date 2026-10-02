/**
 * The git tool: a repository as a program, not a string to type.
 *
 * One tool, many actions. Reading actions (status, diff, log, show, blame,
 * branches, stashes) return a compact, structured answer instead of git's
 * pager-shaped text, and are what Plan mode may run. Changing actions (add,
 * commit, switch, branch, restore, stash, merge) are changes. Talking to a
 * remote (fetch, pull, push) is a change that leaves the machine.
 *
 * git is run directly, never through a shell, so nothing the agent passes can
 * become a second command. What can destroy work -- a force push, a hard
 * reset, cleaning untracked files -- is not an action here at all: the agent
 * has to ask the person, who can run it in the terminal.
 */

import { execFile } from "node:child_process";
import path from "node:path";

import { GIT_READ } from "./readonly";
export { GIT_READ };
export const GIT_ACTIONS = [
  ...GIT_READ, "add", "commit", "switch", "branch", "restore", "stash", "merge", "fetch", "pull", "push",
] as const;
export type GitAction = (typeof GIT_ACTIONS)[number];

/** Whether this call only reads the repository. */
export function gitReadOnly(args: Record<string, any>): boolean {
  return GIT_READ.has(String(args.action ?? "").trim().toLowerCase());
}

const MAX_OUT = 24_000;
const TIMEOUT_MS = 60_000;

function run(cwd: string, args: string[], opts: { timeout?: number; input?: string } = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      "git",
      ["-c", "core.pager=cat", "-c", "color.ui=never", "-c", "core.quotepath=false", ...args],
      { cwd, timeout: opts.timeout ?? TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" } },
      (error, stdout, stderr) => {
        const code = error ? (typeof (error as any).code === "number" ? (error as any).code : 1) : 0;
        resolve({ code, out: String(stdout ?? ""), err: String(stderr ?? (error ? error.message : "")) });
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

const clip = (text: string, max = MAX_OUT) =>
  text.length > max ? `${text.slice(0, max)}\n... (${text.length - max} more characters; narrow it with path, or ask for a range)` : text;

/** A ref or path that could be read as an option. */
function safeWord(value: unknown, what: string): string {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (text.startsWith("-") || /[\0\n\r]/.test(text)) throw new Error(`${what} "${text}" is not allowed.`);
  return text;
}

function paths(value: unknown): string[] {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list.map((p) => safeWord(p, "path")).filter(Boolean);
}

export interface GitCall {
  /** The folder the repository is in (or under). */
  cwd: string;
  args: Record<string, any>;
}

export interface GitResult {
  ok: boolean;
  summary: string;
  preview?: string;
}

/** The repository's top folder, or null when `cwd` is not in one. */
async function topLevel(cwd: string): Promise<string | null> {
  const r = await run(cwd, ["rev-parse", "--show-toplevel"]);
  return r.code === 0 ? r.out.trim() : null;
}

async function status(cwd: string): Promise<GitResult> {
  const r = await run(cwd, ["status", "--porcelain=v2", "--branch", "--untracked-files=normal"]);
  if (r.code !== 0) return { ok: false, summary: r.err.trim() || "git status failed." };
  let branch = "(detached)", upstream = "", ahead = 0, behind = 0, oid = "";
  const staged: string[] = [], changed: string[] = [], untracked: string[] = [], conflicts: string[] = [];
  for (const line of r.out.split("\n")) {
    if (line.startsWith("# branch.head ")) branch = line.slice(14);
    else if (line.startsWith("# branch.upstream ")) upstream = line.slice(18);
    else if (line.startsWith("# branch.oid ")) oid = line.slice(13, 20);
    else if (line.startsWith("# branch.ab ")) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) { ahead = Number(m[1]); behind = Number(m[2]); }
    } else if (line.startsWith("1 ") || line.startsWith("2 ")) {
      const parts = line.split(" ");
      const xy = parts[1];
      const file = line.startsWith("2 ") ? line.split("\t")[0].split(" ").slice(9).join(" ") + " <- " + line.split("\t")[1] : parts.slice(8).join(" ");
      if (xy[0] !== ".") staged.push(`${xy[0]} ${file}`);
      if (xy[1] !== ".") changed.push(`${xy[1]} ${file}`);
    } else if (line.startsWith("u ")) conflicts.push(line.split(" ").slice(10).join(" "));
    else if (line.startsWith("? ")) untracked.push(line.slice(2));
  }
  const out = [
    `On ${branch}${upstream ? ` (tracking ${upstream}${ahead || behind ? `: ${ahead} ahead, ${behind} behind` : ", in step"})` : oid ? ` at ${oid}` : ""}.`,
  ];
  const block = (title: string, list: string[]) => {
    if (list.length) out.push(`${title} (${list.length}):`, ...list.slice(0, 60).map((l) => `  ${l}`), ...(list.length > 60 ? [`  ... ${list.length - 60} more`] : []));
  };
  block("Conflicts", conflicts);
  block("Staged", staged);
  block("Changed, not staged", changed);
  block("Untracked", untracked);
  if (!staged.length && !changed.length && !untracked.length && !conflicts.length) out.push("Working tree clean.");
  return { ok: true, summary: out.join("\n"), preview: `${branch}: ${staged.length} staged, ${changed.length} changed, ${untracked.length} new` };
}

async function diff(cwd: string, a: Record<string, any>): Promise<GitResult> {
  const files = paths(a.paths ?? a.path);
  const base = ["diff", "--no-ext-diff", "--no-textconv"];
  if (a.staged === true) base.push("--cached");
  const range = [safeWord(a.from, "from"), safeWord(a.to, "to")].filter(Boolean);
  const tail = [...range, ...(files.length ? ["--", ...files] : [])];
  const stat = await run(cwd, [...base, "--stat=100", ...tail]);
  if (stat.code !== 0) return { ok: false, summary: stat.err.trim() || "git diff failed." };
  if (!stat.out.trim()) return { ok: true, summary: "No differences.", preview: "no differences" };
  if (a.stat_only === true) return { ok: true, summary: clip(stat.out), preview: "diff stat" };
  const body = await run(cwd, [...base, "--unified=3", ...tail]);
  return { ok: true, summary: `${stat.out.trim().split("\n").slice(-1)[0]}\n\n${clip(body.out)}`, preview: stat.out.trim().split("\n").slice(-1)[0] };
}

async function log(cwd: string, a: Record<string, any>): Promise<GitResult> {
  const n = Math.min(100, Math.max(1, Math.round(Number(a.limit) || 15)));
  const files = paths(a.paths ?? a.path);
  const args = ["log", `-n${n}`, "--date=short", "--pretty=format:%h %ad %an  %s%d"];
  const ref = safeWord(a.ref, "ref");
  if (ref) args.push(ref);
  if (typeof a.search === "string" && a.search.trim()) args.push(`--grep=${safeWord(a.search, "search")}`, "-i");
  if (files.length) args.push("--", ...files);
  const r = await run(cwd, args);
  if (r.code !== 0) return { ok: false, summary: r.err.trim() || "git log failed." };
  return { ok: true, summary: r.out.trim() || "No commits.", preview: `${r.out.trim().split("\n").length} commits` };
}

async function show(cwd: string, a: Record<string, any>): Promise<GitResult> {
  const ref = safeWord(a.ref, "ref") || "HEAD";
  const files = paths(a.paths ?? a.path);
  const r = await run(cwd, ["show", "--no-ext-diff", "--stat=100", "--patch", "--date=short", ref, ...(files.length ? ["--", ...files] : [])]);
  if (r.code !== 0) return { ok: false, summary: r.err.trim() || "git show failed." };
  return { ok: true, summary: clip(r.out), preview: `show ${ref}` };
}

async function blame(cwd: string, a: Record<string, any>): Promise<GitResult> {
  const file = safeWord(a.path, "path");
  if (!file) return { ok: false, summary: "blame needs a path." };
  const start = Math.max(1, Math.round(Number(a.start) || 1));
  const end = Math.max(start, Math.round(Number(a.end) || start + 39));
  const r = await run(cwd, ["blame", "--date=short", "-L", `${start},${Math.min(end, start + 199)}`, safeWord(a.ref, "ref") || "HEAD", "--", file]);
  if (r.code !== 0) return { ok: false, summary: r.err.trim() || "git blame failed." };
  return { ok: true, summary: clip(r.out), preview: `blame ${path.basename(file)}` };
}

async function branches(cwd: string): Promise<GitResult> {
  const r = await run(cwd, ["branch", "-vv", "--all", "--no-color"]);
  if (r.code !== 0) return { ok: false, summary: r.err.trim() || "git branch failed." };
  return { ok: true, summary: clip(r.out.trim() || "No branches yet."), preview: "branches" };
}

/** What a changing action reports: its own words, or the new status. */
async function changed(cwd: string, said: string): Promise<GitResult> {
  const s = await status(cwd);
  return { ok: true, summary: `${said.trim() ? `${said.trim()}\n\n` : ""}${s.summary}`, preview: s.preview };
}

export async function runGit(call: GitCall): Promise<GitResult> {
  const a = call.args;
  const action = String(a.action ?? "").trim().toLowerCase() as GitAction;
  if (!(GIT_ACTIONS as readonly string[]).includes(action)) {
    return { ok: false, summary: `action is one of: ${GIT_ACTIONS.join(", ")}.` };
  }
  const asked = typeof a.repo === "string" && a.repo.trim() ? path.resolve(call.cwd, a.repo.trim()) : call.cwd;
  const top = await topLevel(asked);
  if (!top) return { ok: false, summary: `${asked} is not inside a git repository. Start one with the terminal (git init) if that is what the person wants.` };
  const cwd = top;
  try {
    switch (action) {
      case "status": return await status(cwd);
      case "diff": return await diff(cwd, a);
      case "log": return await log(cwd, a);
      case "show": return await show(cwd, a);
      case "blame": return await blame(cwd, a);
      case "branches": return await branches(cwd);
      case "remotes": {
        const r = await run(cwd, ["remote", "-v"]);
        return { ok: r.code === 0, summary: r.out.trim() || r.err.trim() || "No remotes.", preview: "remotes" };
      }
      case "stashes": {
        const r = await run(cwd, ["stash", "list"]);
        return { ok: r.code === 0, summary: r.out.trim() || "No stashes.", preview: "stashes" };
      }
      case "add": {
        const files = paths(a.paths ?? a.path);
        const r = await run(cwd, files.length ? ["add", "--", ...files] : ["add", "--all"]);
        if (r.code !== 0) return { ok: false, summary: r.err.trim() || "git add failed." };
        return await changed(cwd, "");
      }
      case "commit": {
        const message = String(a.message ?? "").trim();
        if (!message) return { ok: false, summary: "A commit needs a message: say what changed and why." };
        const files = paths(a.paths ?? a.path);
        if (a.all === true && !files.length) {
          const added = await run(cwd, ["add", "--update"]);
          if (added.code !== 0) return { ok: false, summary: added.err.trim() || "git add failed." };
        } else if (files.length) {
          const added = await run(cwd, ["add", "--", ...files]);
          if (added.code !== 0) return { ok: false, summary: added.err.trim() || "git add failed." };
        }
        const staged = await run(cwd, ["diff", "--cached", "--quiet"]);
        if (staged.code === 0) return { ok: false, summary: "Nothing is staged, so there is nothing to commit. Use add (or all: true to take every tracked change)." };
        const r = await run(cwd, ["commit", "-m", message, ...(a.amend === true ? ["--amend", "--no-edit"] : [])]);
        if (r.code !== 0) return { ok: false, summary: clip(`${r.out}\n${r.err}`.trim()) };
        return await changed(cwd, r.out.split("\n").slice(0, 3).join("\n"));
      }
      case "switch": {
        const target = safeWord(a.branch ?? a.ref, "branch");
        if (!target) return { ok: false, summary: "switch needs a branch." };
        const r = await run(cwd, ["switch", ...(a.create === true ? ["-c"] : []), target, ...(a.create === true && a.from ? [safeWord(a.from, "from")] : [])]);
        if (r.code !== 0) return { ok: false, summary: clip(r.err.trim() || r.out.trim()) };
        return await changed(cwd, `Now on ${target}.`);
      }
      case "branch": {
        const name = safeWord(a.branch, "branch");
        if (!name) return await branches(cwd);
        if (a.delete === true) {
          const r = await run(cwd, ["branch", "-d", name]); // -d: git refuses what is not merged
          return r.code === 0 ? { ok: true, summary: r.out.trim() } : { ok: false, summary: r.err.trim() };
        }
        const r = await run(cwd, ["branch", name, ...(a.from ? [safeWord(a.from, "from")] : [])]);
        return r.code === 0 ? { ok: true, summary: `Created ${name}.` } : { ok: false, summary: r.err.trim() };
      }
      case "restore": {
        const files = paths(a.paths ?? a.path);
        if (!files.length) return { ok: false, summary: "restore needs paths: it is never run on everything at once." };
        // Unstage by default; discarding the working copy is explicit.
        const r = await run(cwd, a.discard === true ? ["restore", "--", ...files] : ["restore", "--staged", "--", ...files]);
        if (r.code !== 0) return { ok: false, summary: r.err.trim() || "git restore failed." };
        return await changed(cwd, a.discard === true ? `Discarded the changes in ${files.join(", ")}.` : `Unstaged ${files.join(", ")}.`);
      }
      case "stash": {
        const mode = String(a.mode ?? "push");
        if (mode === "pop") {
          const r = await run(cwd, ["stash", "pop"]);
          if (r.code !== 0) return { ok: false, summary: clip(`${r.out}\n${r.err}`.trim()) };
          return await changed(cwd, "Restored the latest stash.");
        }
        const r = await run(cwd, ["stash", "push", ...(a.untracked === true ? ["--include-untracked"] : []), ...(a.message ? ["-m", String(a.message)] : [])]);
        return r.code === 0 ? { ok: true, summary: r.out.trim() || "Stashed." } : { ok: false, summary: r.err.trim() };
      }
      case "merge": {
        const ref = safeWord(a.ref ?? a.branch, "branch");
        if (!ref) return { ok: false, summary: "merge needs a branch." };
        const r = await run(cwd, ["merge", "--no-edit", ref]);
        if (r.code !== 0) {
          return { ok: false, summary: clip(`${r.out}\n${r.err}`.trim()) + "\n\nIf there are conflicts, status lists them; fix the files, add them and commit, or run `git merge --abort` in the terminal." };
        }
        return await changed(cwd, r.out.trim().split("\n").slice(0, 4).join("\n"));
      }
      case "fetch":
      case "pull":
      case "push": {
        const remote = safeWord(a.remote, "remote");
        const branch = safeWord(a.branch, "branch");
        const extra = action === "pull" ? ["--ff-only"] : action === "push" && a.set_upstream === true ? ["-u"] : [];
        const r = await run(cwd, [action, ...extra, ...(remote ? [remote] : []), ...(branch ? [branch] : [])], { timeout: 120_000 });
        const said = clip(`${r.out}\n${r.err}`.trim());
        if (r.code !== 0) return { ok: false, summary: said || `git ${action} failed.` };
        return { ok: true, summary: said || `git ${action} done.`, preview: `git ${action}` };
      }
    }
    return { ok: false, summary: `${action} is not handled.` };
  } catch (err: any) {
    return { ok: false, summary: String(err?.message ?? err) };
  }
}
