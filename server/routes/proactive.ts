/**
 * The proactive console's routes: what this install could do for the person and what it has noticed, offers, push notifications for the installed app, and the notices the page polls.
 *
 * Moved out of server.ts (docs/REVIEW.md C1); nothing changed in the move.
 * What the routes need from the rest of the server arrives in `deps`.
 */

import type { Express, Request, Response } from "express";
import { log } from "../logs";
import type { Noticer } from "../noticer";
import { deliver, readyChannels } from "../push";
import { state } from "../state";
import { DISCOVER, type Signals, offers as offersFor, starters as startersFor } from "../suggest";
import { cleanSubscription, type WebPush } from "../webpush";
import type { Job } from "../scheduler";
import type { Notice } from "../session-types";

export function proactiveRoutes(app: Express, deps: {
  /** What the suggestions are worked out from (read from the install each time). */
  gatherSignals: () => Promise<Signals>;
  /** Offers already answered, by key. Mutated in place. */
  answeredOffers: Record<string, string>;
  saveProactive: () => void;
  noticer: Noticer;
  createJob: (input: { name?: string; cron?: string; prompt: string; enabled?: boolean; watch?: unknown }) => Job;
  webPush: WebPush;
  /** The app's own address, for a link in a notification. */
  appLink: (session?: string | null) => string | null;
  /** The notices the page polls, oldest first, and the last one's number. */
  notices: Notice[];
  latestNotice: () => number;
}) {
  const { gatherSignals, answeredOffers, saveProactive, noticer, createJob, webPush, appLink, notices, latestNotice } = deps;
  /**
   * What this install could do for the person, and what it has noticed:
   * one-tap tasks for a new chat, the one schedule worth offering, and the
   * conditions still true. Read from the install each time; no model is
   * asked. See server/suggest.ts and server/noticer.ts.
   */
  app.get("/api/proactive", async (_req: Request, res: Response) => {
    const signals = await gatherSignals();
    res.json({
      starters: startersFor(signals),
      discover: DISCOVER,
      offer: offersFor(signals, answeredOffers, state.proactivity)[0] ?? null,
      notices: noticer.list(),
    });
  });

  /** Only what has been noticed, for the sidebar's poll: no Docker, no disk,
      nothing worked out -- the list the last look left. */
  app.get("/api/proactive/notices", (_req: Request, res: Response) => {
    res.json({ notices: noticer.list() });
  });

  /** Yes or no to an offer. Yes sets the schedule up; either way it is not
      asked again. The offer is worked out afresh here rather than taken from
      the request, so this route can only ever create a job it offered. */
  app.post("/api/proactive/offers/:key", async (req: Request, res: Response) => {
    const answer = req.body?.answer === "yes" ? "yes" : req.body?.answer === "no" ? "no" : null;
    if (!answer) return res.status(400).json({ error: "Answer yes or no." });
    const offer = offersFor(await gatherSignals(), answeredOffers, state.proactivity)
      .find((o) => o.key === req.params.key);
    if (!offer) return res.status(404).json({ error: "That offer is no longer open." });
    answeredOffers[offer.key] = answer;
    saveProactive();
    if (answer === "no") return res.json({ ok: true });
    const job = createJob(offer.job);
    log("info", "schedule", `offer accepted: "${job.name}" (${job.cron})`);
    res.json({ ok: true, job: job.id, name: job.name, next_run: job.next_run });
  });

  /** "Not now" on something noticed: quiet until it clears. */
  app.post("/api/proactive/notices/:key/dismiss", (req: Request, res: Response) => {
    if (!noticer.dismiss(req.params.key)) return res.status(404).json({ error: "That is no longer true." });
    res.json({ ok: true });
  });

  /** A message to every device that has asked, to see it arrive. */
  app.post("/api/push/test", async (_req: Request, res: Response) => {
    if (readyChannels(webPush).length === 0) {
      return res.status(400).json({ error: "No device is set up to be notified yet: turn on notifications on this device first." });
    }
    const results = await deliver({
      title: "Autora can reach you here",
      body: "This is where it will tell you when a schedule runs, when it notices something, and when it needs you.",
      url: appLink(),
    }, webPush);
    for (const d of results) log(d.ok ? "info" : "warn", "push", `test to ${d.channel}: ${d.ok ? "sent" : d.error}`);
    res.json({ results });
  });

  /** This device asks to be told things. The subscription is the browser's
      own; only a well-formed one, to a real https push service, is kept. */
  app.post("/api/push/web/subscribe", (req: Request, res: Response) => {
    const sub = cleanSubscription(req.body?.subscription, req.body?.label);
    if (!sub) return res.status(400).json({ error: "That is not a subscription this can send to." });
    webPush.add(sub);
    res.json({ ok: true, devices: webPush.list() });
  });

  app.post("/api/push/web/unsubscribe", (req: Request, res: Response) => {
    const endpoint = String(req.body?.endpoint ?? "");
    res.json({ ok: true, removed: webPush.remove(endpoint), devices: webPush.list() });
  });

  app.get("/api/notices", (req: Request, res: Response) => {
    const after = Number(req.query.after) || 0;
    res.json({ notices: notices.filter((n) => n.id > after), latest: latestNotice() });
  });
}
