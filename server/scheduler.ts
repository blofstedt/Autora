/**
 * Scheduled jobs and watchers.
 *
 * A job is a prompt and a cron expression. On its own the cron says when the
 * prompt is run. With a `watch` it says how often to look at something -- a
 * web page, a file or folder, a command's output -- and the prompt is run
 * only when what was seen has changed since the last look, with the change
 * attached.
 *
 * Runs that were due while the server was down are not made up: a job that
 * should have run at 3am on a box that was off at 3am runs at its next time.
 * Catching up would mean a restart after a week away firing everything at
 * once.
 *
 * Times are the server's local time, like cron's. In the Umbrel container
 * that is UTC unless TZ is set.
 */

import crypto from "node:crypto";

export interface JobWatch {
  kind: "page" | "file" | "command";
  /** A URL, a path, or a shell command. */
  target: string;
}

export interface JobRun {
  at: number;
  finished: number | null;
  reason: "schedule" | "manual" | "change";
  session: string | null;
  ok: boolean;
  error: string | null;
  /** The start of what the agent said. */
  summary: string;
}

export interface Job {
  id: string;
  name: string;
  cron: string;
  prompt: string;
  enabled: boolean;
  created: number;
  last_run: number | null;
  last_session: string | null;
  last_error: string | null;
  next_run: number | null;
  cron_error: string | null;
  watch?: JobWatch | null;
  /** What the watcher saw last time. */
  last_seen?: { hash: string; text: string; at: number } | null;
  /** Newest last. */
  runs?: JobRun[];
}

const MAX_RUNS = 20;

// ------------------------------------------------------------------ cron --

type Field = { values: Set<number>; star: boolean };
export type Cron = { minute: Field; hour: Field; dom: Field; month: Field; dow: Field };

const ALIASES: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
};
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function field(text: string, min: number, max: number, names?: string[]): Field {
  const values = new Set<number>();
  const name = (s: string) => {
    const i = names?.indexOf(s.toLowerCase()) ?? -1;
    if (i >= 0) return i + min;
    if (!/^\d+$/.test(s)) throw new Error(`"${s}" is not a number`);
    return Number(s);
  };
  for (const part of text.split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in "${part}"`);
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = min;
      hi = max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-");
      lo = name(a);
      hi = name(b);
    } else {
      lo = name(range);
      hi = stepText === undefined ? lo : max;
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`"${part}" is outside ${min}-${max}`);
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return { values, star: text === "*" };
}

/** Parse five-field cron (or an @alias). Throws with a readable reason. */
export function parseCron(expr: string): Cron {
  const text = ALIASES[expr.trim().toLowerCase()] ?? expr.trim();
  const parts = text.split(/\s+/);
  if (parts.length !== 5) throw new Error("cron needs five fields: minute hour day month weekday");
  const dow = field(parts[4], 0, 7, DAYS);
  // 7 is Sunday too.
  if (dow.values.delete(7)) dow.values.add(0);
  return {
    minute: field(parts[0], 0, 59),
    hour: field(parts[1], 0, 23),
    dom: field(parts[2], 1, 31),
    month: field(parts[3], 1, 12, MONTHS),
    dow,
  };
}

function dayMatches(c: Cron, d: Date): boolean {
  const dom = c.dom.values.has(d.getDate());
  const dow = c.dow.values.has(d.getDay());
  // Cron's rule: with both restricted, either one will do.
  if (!c.dom.star && !c.dow.star) return dom || dow;
  return dom && dow;
}

/** The first matching minute strictly after `after`, or null within a year and a bit. */
export function nextRun(expr: string, after: Date): Date | null {
  const c = parseCron(expr);
  const d = new Date(after.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = after.getTime() + 400 * 24 * 3600 * 1000;
  while (d.getTime() <= limit) {
    if (!c.month.values.has(d.getMonth() + 1) || !dayMatches(c, d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!c.hour.values.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!c.minute.values.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
      continue;
    }
    return d;
  }
  return null;
}

// ------------------------------------------------------------------ diff --

/** Lines gone and lines new, as a short note for the prompt. */
export function describeChange(before: string, after: string, maxLines = 40): string {
  const count = (text: string) => {
    const m = new Map<string, number>();
    for (const line of text.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim())) {
      m.set(line, (m.get(line) ?? 0) + 1);
    }
    return m;
  };
  const a = count(before);
  const b = count(after);
  const gone: string[] = [];
  const added: string[] = [];
  for (const [line, n] of a) for (let i = (b.get(line) ?? 0); i < n; i += 1) gone.push(line);
  for (const [line, n] of b) for (let i = (a.get(line) ?? 0); i < n; i += 1) added.push(line);
  const clip = (lines: string[]) =>
    lines.length > maxLines
      ? [...lines.slice(0, maxLines), `... and ${lines.length - maxLines} more`]
      : lines;
  const out: string[] = [];
  if (added.length) out.push("New:", ...clip(added).map((l) => `+ ${l.slice(0, 300)}`));
  if (gone.length) out.push("Gone:", ...clip(gone).map((l) => `- ${l.slice(0, 300)}`));
  return out.length ? out.join("\n") : "The content changed, but only in whitespace or order.";
}

export const hashOf = (text: string) => crypto.createHash("sha256").update(text).digest("hex");

// ------------------------------------------------------------- the clock --

export interface SchedulerHooks {
  /** Run the prompt in a fresh session. */
  run: (job: Job, prompt: string, reason: JobRun["reason"]) => Promise<{
    session: string;
    done: Promise<{ ok: boolean; error: string | null; reply: string }>;
  }>;
  /** Look at what a watcher watches, as text. */
  observe: (watch: JobWatch) => Promise<string>;
  save: () => void;
  /** A run finished: tell whoever is looking. */
  notify: (job: Job, run: JobRun) => void;
  now?: () => number;
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = new Set<string>();

  constructor(private readonly jobs: Job[], private readonly hooks: SchedulerHooks) {}

  private now(): number {
    return this.hooks.now ? this.hooks.now() : Date.now();
  }

  /** Re-read a job's cron: its error, if any, and its next time from now. */
  plan(job: Job) {
    try {
      const next = nextRun(job.cron, new Date(this.now()));
      job.cron_error = null;
      job.next_run = next ? Math.floor(next.getTime() / 1000) : null;
    } catch (err: any) {
      job.cron_error = err?.message ?? String(err);
      job.next_run = null;
    }
  }

  start(everyMs = 20_000) {
    for (const job of this.jobs) {
      // Missed while down: planned from now, not made up.
      if (job.next_run === null || job.next_run * 1000 < this.now() || job.cron_error !== null) this.plan(job);
    }
    this.hooks.save();
    this.timer = setInterval(() => {
      this.tick().catch((err) => console.warn(`[scheduler] ${err?.message ?? err}`));
    }, everyMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  running(id: string): boolean {
    return this.inFlight.has(id);
  }

  /** Fire whatever is due. Exposed for tests. */
  async tick() {
    const due = this.jobs.filter((j) =>
      j.enabled && !j.cron_error && j.next_run !== null && j.next_run * 1000 <= this.now() &&
      !this.inFlight.has(j.id));
    for (const job of due) {
      // Planned before running, so a slow run cannot be fired twice.
      this.plan(job);
      this.hooks.save();
      if (job.watch) await this.check(job);
      else await this.fire(job, job.prompt, "schedule");
    }
  }

  /** Look at a watcher's target; run its prompt if what is there changed. */
  async check(job: Job, force = false): Promise<"changed" | "same" | "baseline" | "error"> {
    if (!job.watch) return "error";
    let text: string;
    try {
      text = await this.hooks.observe(job.watch);
    } catch (err: any) {
      job.last_error = `Could not look at ${job.watch.target}: ${err?.message ?? err}`;
      this.hooks.save();
      return "error";
    }
    const hash = hashOf(text);
    const before = job.last_seen;
    job.last_seen = { hash, text: text.slice(0, 200_000), at: Math.floor(this.now() / 1000) };
    job.last_error = null;
    this.hooks.save();
    if (!before && !force) return "baseline";
    if (before && before.hash === hash && !force) return "same";

    const what = job.watch.kind === "page" ? "page" : job.watch.kind === "file" ? "file" : "command output";
    const change = before && before.hash !== hash
      ? `The ${what} you are watching (${job.watch.target}) changed since ${
        new Date(before.at * 1000).toISOString()}.\n${describeChange(before.text, text)}`
      : `Checked by hand. The ${what} you are watching (${job.watch.target}) currently reads:\n${text.slice(0, 4000)}`;
    await this.fire(job, `${job.prompt}\n\n[Autora: ${change}]`, force ? "manual" : "change");
    return before && before.hash !== hash ? "changed" : "same";
  }

  /** Run a job's prompt now, in a fresh session. Resolves once it has started. */
  async fire(job: Job, prompt: string, reason: JobRun["reason"]): Promise<string | null> {
    if (this.inFlight.has(job.id)) return null;
    this.inFlight.add(job.id);
    const run: JobRun = {
      at: Math.floor(this.now() / 1000), finished: null, reason, session: null, ok: false, error: null, summary: "",
    };
    job.runs = [...(job.runs ?? []), run].slice(-MAX_RUNS);
    job.last_run = run.at;
    try {
      const { session, done } = await this.hooks.run(job, prompt, reason);
      run.session = session;
      job.last_session = session;
      this.hooks.save();
      void done
        .then((outcome) => {
          run.ok = outcome.ok;
          run.error = outcome.error;
          run.summary = outcome.reply.trim().replace(/\s+/g, " ").slice(0, 280);
        })
        .catch((err: any) => {
          run.error = err?.message ?? String(err);
        })
        .finally(() => {
          run.finished = Math.floor(this.now() / 1000);
          job.last_error = run.error;
          this.inFlight.delete(job.id);
          this.hooks.save();
          this.hooks.notify(job, run);
        });
      return session;
    } catch (err: any) {
      run.error = err?.message ?? String(err);
      run.finished = run.at;
      job.last_error = run.error;
      this.inFlight.delete(job.id);
      this.hooks.save();
      this.hooks.notify(job, run);
      return null;
    }
  }
}
