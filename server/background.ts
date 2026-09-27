/**
 * Jobs that outlive the turn that started them.
 *
 * The terminal tool has a time limit, and the turn ends with it, so anything
 * slower than the cap could not be done at all: a build, a download, a long
 * test run, a restore. It was killed at the limit and the work went with it.
 *
 * A background job is the same shell, detached into its own session with its
 * output going to a file, so it keeps running after the tool call, the turn
 * and (as long as the machine stays up) the console itself. The exit code
 * cannot be collected by the process that started the job -- that process may
 * be long gone by the time it finishes -- so the shell writes it out. The
 * filesystem is therefore the state: an `exit` file means finished, and what
 * is in it is the code.
 *
 * What this is not: a place to put a command that should not have been run at
 * all (it has the same shell, the same secrets and the same working
 * directory), and not a scheduler. Something that must happen at a time, or
 * be looked at again later, is a job in the Schedule page -- server/scheduler.ts
 * -- not a background shell.
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { readDoc, saveDoc } from "./store";
import { stateDir } from "./state";

export interface BgJob {
  /** Short and stable, so a note can say "job-4" and a later turn know it. */
  id: string;
  command: string;
  cwd: string;
  /** The detached shell's own process id, for liveness and for stopping it. */
  pid: number;
  started: number;
  /** Why it was started, in the words of whoever started it. */
  note: string;
  session: string;
  log: string;
  exitFile: string;
  /** Set when the shell could not be started at all. */
  error?: string | null;
}

export type BgState = "running" | "finished" | "gone" | "failed";

export interface BgView extends BgJob {
  state: BgState;
  exit: number | null;
  /** When it finished, from the file the shell wrote, or null. */
  finished: number | null;
  /** Seconds it ran, or has been running. */
  seconds: number;
  /** The last thing it printed, one line. */
  last: string;
}

/** Kept: enough history to read a job's output back, and no more. */
const MAX_JOBS = 40;
const KEEP_MS = 7 * 24 * 3600 * 1000;
/** Only recent finishes are worth putting in front of the model. */
const MENTION_FINISHED_MS = 12 * 3600 * 1000;

const dir = () => path.join(stateDir(), "background");

let loaded = false;
let jobs: BgJob[] = [];

function all(): BgJob[] {
  if (!loaded) {
    loaded = true;
    const stored = readDoc<BgJob[]>("background");
    jobs = Array.isArray(stored) ? stored.filter((j) => j && typeof j.id === "string") : [];
  }
  return jobs;
}

function persist() {
  saveDoc("background", () => jobs);
}

function quote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** The shell a background job runs in: bash where there is one, so a command
    written for the terminal tool behaves the same here. */
function shellBin(): string {
  for (const candidate of ["/bin/bash", "/usr/bin/bash", "/bin/sh", "/usr/bin/sh"]) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // Not there; try the next.
    }
  }
  return "sh";
}

function alive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // EPERM means it exists and belongs to somebody else.
    return err?.code === "EPERM";
  }
}

function exitCodeOf(job: BgJob): number | null | undefined {
  try {
    const text = fs.readFileSync(job.exitFile, "utf8").trim();
    return text === "" ? null : Number(text);
  } catch {
    return undefined;
  }
}

function mtimeOf(file: string): number | null {
  try {
    return Math.round(fs.statSync(file).mtimeMs);
  } catch {
    return null;
  }
}

function lastLine(job: BgJob): string {
  const text = readTail(job, 4_000);
  const line = text.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim()).slice(-1)[0] ?? "";
  return line.slice(-300);
}

export function view(job: BgJob): BgView {
  const code = exitCodeOf(job);
  const state: BgState =
    job.error ? "failed"
      : code !== undefined ? "finished"
        : alive(job.pid) ? "running"
          : "gone";
  /* When it ended, from the exit file own timestamp: the process that
     started it is usually gone by then and cannot be asked. */
  const finished = code === undefined ? null : mtimeOf(job.exitFile);
  const end = state === "running" ? Date.now() : finished ?? Date.now();
  return {
    ...job,
    state,
    exit: code ?? null,
    finished,
    seconds: Math.max(0, Math.round((end - job.started) / 1000)),
    last: lastLine(job),
  };
}

export function listJobs(): BgView[] {
  return all().map(view).sort((a, b) => b.started - a.started);
}

export function findJob(id: string): BgView | null {
  const wanted = id.trim();
  const job = all().find((j) => j.id === wanted || j.id === `job-${wanted}`);
  return job ? view(job) : null;
}

/** Up to `bytes` from the end of a job's output. */
export function readTail(job: BgJob, bytes = 20_000): string {
  try {
    const size = fs.statSync(job.log).size;
    const start = Math.max(0, size - bytes);
    const fd = fs.openSync(job.log, "r");
    const length = size - start;
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    fs.closeSync(fd);
    return buffer.toString("utf8");
  } catch {
    return "";
  }
}

export interface StartResult {
  job?: BgJob;
  error?: string;
}

export function startJob(opts: { command: string; cwd: string; note?: string; session: string }): StartResult {
  const command = String(opts.command ?? "").trim();
  if (!command) return { error: "No command was given." };
  const cwd = opts.cwd;
  if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    return { error: `There is no directory ${cwd} on this machine.` };
  }
  try {
    fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
  } catch (err: any) {
    return { error: `Could not make room for its output: ${err?.message ?? err}` };
  }

  const id = `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
  const log = path.join(dir(), `${id}.log`);
  const exitFile = path.join(dir(), `${id}.exit`);
  /* One shell string. The command runs in a subshell so that its own `exit`
     leaves that subshell and not the shell that is keeping score -- with
     braces, `exit 7` took the whole thing with it and no code was ever
     written. The redirection is on the subshell, so what is written
     afterwards is the command's exit code and not the file's. */
  const inner =
    `( ${command}\n) > ${quote(log)} 2>&1; printf '%s\\n' $? > ${quote(exitFile)}`;

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(shellBin(), ["-lc", inner], {
      cwd,
      env: {
        ...process.env,
        PAGER: "cat",
        GIT_PAGER: "cat",
        NO_COLOR: "1",
        DEBIAN_FRONTEND: "noninteractive",
      },
      detached: true,
      stdio: "ignore",
    });
  } catch (err: any) {
    return { error: `Could not start it: ${err?.message ?? err}` };
  }

  const job: BgJob = {
    id,
    command,
    cwd,
    pid: child.pid ?? 0,
    started: Date.now(),
    note: String(opts.note ?? "").trim(),
    session: opts.session,
    log,
    exitFile,
    error: null,
  };
  all().push(job);
  persist();
  prune();

  /* An unhandled 'error' on a detached child would take the server down with
     it, and the usual cause is an ordinary one: no shell. */
  child.on("error", (err: any) => {
    job.error = err?.message ?? String(err);
    persist();
  });
  child.unref();
  return { job };
}

/** Stop a job and everything it started. Its process group is its own, so a
    child of the command goes too. */
export function stopJob(id: string): { ok: boolean; message: string } {
  const job = all().find((j) => j.id === id.trim() || j.id === `job-${id.trim()}`);
  if (!job) return { ok: false, message: `There is no job ${id}.` };
  const state = view(job).state;
  if (state !== "running") return { ok: false, message: `${job.id} is not running (${state}).` };
  let killed = false;
  try {
    process.kill(-job.pid, "SIGTERM");
    killed = true;
  } catch {
    try {
      process.kill(job.pid, "SIGTERM");
      killed = true;
    } catch (err: any) {
      return { ok: false, message: `Could not stop ${job.id}: ${err?.message ?? err}` };
    }
  }
  if (killed) {
    try {
      fs.writeFileSync(job.exitFile, "143\n", { mode: 0o600 });
    } catch {
      // Its exit code is only for reading back; losing it is not fatal.
    }
  }
  return { ok: true, message: `Stopped ${job.id}.` };
}

/** Forget the old ones, and everything they wrote. */
export function prune(now = Date.now()): number {
  const before = all().length;
  const kept = all().filter((j) => now - j.started < KEEP_MS);
  for (const job of all()) {
    if (kept.includes(job)) continue;
    for (const file of [job.log, job.exitFile]) {
      try {
        fs.unlinkSync(file);
      } catch {
        // Already gone.
      }
    }
  }
  const extra = kept.length - MAX_JOBS;
  if (extra > 0) kept.splice(0, extra);
  jobs = kept;
  if (jobs.length !== before) persist();
  return before - jobs.length;
}

/** How a finished job reads in a sentence, for a note or a tool result. */
export function describe(job: BgView): string {
  const what = job.note ? `${job.id} ("${job.note}", \`${short(job.command)}\`)` : `${job.id} (\`${short(job.command)}\`)`;
  const ago = job.seconds < 90 ? `${job.seconds}s` : `${Math.round(job.seconds / 60)}m`;
  if (job.state === "running") return `${what} -- still running, ${ago} so far.`;
  if (job.state === "finished") return `${what} -- finished after ${ago}, exit ${job.exit}.`;
  if (job.state === "failed") return `${what} -- never started: ${job.error}.`;
  return `${what} -- ${ago} and no longer running; it was killed with the machine or the console.`;
}

function short(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

/**
 * What the next turn is told about background work, unprompted.
 *
 * Only what is still going, and what finished recently: a job from last week
 * that nobody asked about is history, and the log is still there for anyone
 * who asks. Empty string when there is nothing to say, so a turn with no
 * background work pays nothing for this.
 */
export function backgroundBriefing(now = Date.now()): string {
  const open = all()
    .map(view)
    .filter((j) => j.state === "running" || j.state === "failed" || now - j.started < MENTION_FINISHED_MS)
    .sort((a, b) => b.started - a.started)
    .slice(0, 6);
  if (open.length === 0) return "";
  const lines = open.map((j) => {
    const line = describe(j);
    const tail = j.last.trim();
    return tail && j.state !== "running" ? `${line} Its last line: ${tail}` : line;
  });
  return [
    "Background jobs you started, still going or just finished:",
    ...lines.map((l) => `- ${l}`),
    "These outlive turns: read one with background_output, start another with run_background.",
  ].join("\n");
}
