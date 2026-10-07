/**
 * Scheduled jobs and watchers: listing, making, changing, removing and running them, and what automated runs have spent.
 *
 * Moved out of server.ts (docs/REVIEW.md C1); nothing changed in the move.
 * What the routes need from the rest of the server arrives in `deps`.
 */

import type { Express, Request, Response } from "express";
import { budgetLine, type AutomationLedger } from "../automation";
import type { Job, JobWatch, Scheduler } from "../scheduler";
import { state } from "../state";

export function jobRoutes(app: Express, deps: {
  /** Every scheduled job, in the order they were made. Mutated in place. */
  jobs: Job[];
  scheduler: Scheduler;
  saveJobs: () => void;
  jobView: (job: Job) => unknown;
  saneWatch: (raw: unknown) => JobWatch | null;
  createJob: (input: { name?: string; cron?: string; prompt: string; enabled?: boolean; watch?: unknown }) => Job;
  /** What automated runs have spent today (rolled over if the day changed). */
  todaysLedger: () => AutomationLedger;
  /** How many automated turns are running now. */
  automationRunning: () => number;
}) {
  const { jobs, scheduler, saveJobs, jobView, saneWatch, createJob, todaysLedger, automationRunning } = deps;
  // 9. Scheduled jobs and watchers (see server/scheduler.ts)
  /* What automated runs have spent today, what the guard did about it, and
     what is left. The Schedule page and the Settings card both read this. */
  app.get("/api/automation", (_req: Request, res: Response) => {
    const ledger = todaysLedger();
    res.json({
      budget: { ...state.automation },
      ledger: { ...ledger },
      line: budgetLine(state.automation, ledger),
      running: automationRunning(),
    });
  });

  app.get("/api/jobs", (_req: Request, res: Response) => {
    res.json(jobs.map(jobView));
  });

  app.post("/api/jobs", (req: Request, res: Response) => {
    const prompt = (req.body?.prompt || "").trim();
    if (!prompt) return res.status(400).json({ error: "A task needs a prompt" });
    const newJob = createJob({
      name: String(req.body?.name ?? ""),
      cron: String(req.body?.cron ?? ""),
      prompt,
      enabled: req.body?.enabled,
      watch: req.body?.watch,
    });
    res.json({ id: newJob.id, cron_error: newJob.cron_error });
  });

  app.patch("/api/jobs/:id", (req: Request, res: Response) => {
    const job = jobs.find((j) => j.id === req.params.id);
    if (!job) return res.status(404).json({ error: "Job not found" });

    if (typeof req.body.name === "string") job.name = req.body.name;
    if (typeof req.body.prompt === "string") job.prompt = req.body.prompt;
    if (req.body.enabled !== undefined) job.enabled = Boolean(req.body.enabled);
    if (typeof req.body.cron === "string") job.cron = req.body.cron.trim();
    let rewatch = false;
    if (req.body.watch !== undefined) {
      const watch = saneWatch(req.body.watch);
      rewatch = JSON.stringify(watch) !== JSON.stringify(job.watch ?? null);
      job.watch = watch;
      if (rewatch) job.last_seen = null;
    }
    scheduler.plan(job);
    saveJobs();
    if (rewatch && job.watch) void scheduler.check(job);
    res.json({ ok: true, cron_error: job.cron_error });
  });

  app.delete("/api/jobs/:id", (req: Request, res: Response) => {
    const idx = jobs.findIndex((j) => j.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: "Job not found" });
    jobs.splice(idx, 1);
    saveJobs();
    res.json({ ok: true });
  });

  /** Run it now: a schedule runs its prompt, a watcher looks and runs with
      what it saw, changed or not. */
  app.post("/api/jobs/:id/run", async (req: Request, res: Response) => {
    const job = jobs.find((j) => j.id === req.params.id);
    if (!job) return res.status(404).json({ error: "Job not found" });
    if (scheduler.running(job.id)) return res.status(409).json({ error: "It is already running." });
    if (job.watch) {
      const outcome = await scheduler.check(job, true);
      if (outcome === "error") return res.status(400).json({ error: job.last_error });
      return res.json({ session: job.last_session });
    }
    const session = await scheduler.fire(job, job.prompt, "manual");
    if (!session) return res.status(400).json({ error: job.last_error ?? "It could not start." });
    res.json({ session });
  });
}
