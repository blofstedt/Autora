/**
 * Triggers: work that starts because something outside said so (a URL and a secret with a prompt attached), and the URL that fires one.
 *
 * Moved out of server.ts (docs/REVIEW.md C1); nothing changed in the move.
 * What the routes need from the rest of the server arrives in `deps`.
 */

import express, { type Express, type Request, type Response } from "express";
import { overDay, skipReason, type AutomationLedger } from "../automation";
import { log } from "../logs";
import type { PushKind } from "../push";
import type { AutoraEvent, Session } from "../session-types";
import { state } from "../state";
import { type Trigger, newId as newTriggerId, newToken as newTriggerToken, tokenMatches, label as triggerLabel, firePrompt as triggerPrompt, refusal as triggerRefusal, view as triggerView } from "../triggers";

export function triggerRoutes(app: Express, deps: {
  /** Every trigger. Mutated in place. */
  triggers: Trigger[];
  saveTriggers: () => void;
  /** What automated runs have spent today (rolled over if the day changed). */
  todaysLedger: () => AutomationLedger;
  /** Add what a finished session cost to today's automation spend, and keep it. */
  chargeSession: (sessionId: string) => void;
  /** Sessions started by automation and still counted as running. */
  automationSessions: Set<string>;
  newSession: (title: string) => Session;
  emitEvent: (session: Session, kind: string, actor: string, payload: Record<string, any>) => AutoraEvent;
  startTurn: (
    session: Session, text: string, attachments: [], opts: { automated: boolean },
  ) => Promise<{ ok: boolean; reply?: string; error?: string | null }>;
  notify: (
    notice: { tone: "ok" | "info" | "error"; title: string; detail: string; session: string | null },
    phone?: PushKind,
  ) => void;
}) {
  const {
    triggers, saveTriggers, todaysLedger, chargeSession, automationSessions, newSession, emitEvent, startTurn, notify,
  } = deps;
  /* ---- triggers: work that starts because something outside said so -------
     See server/triggers.ts for what a trigger is and the rules it keeps. A
     firing is a turn in a session of its own, billed against the same day's
     automation budget as a scheduled run -- it is the same kind of spending,
     and a URL that could spend without limit would be the wrong shape of
     feature. */

  /** Start a trigger's turn. Resolves with the session's id, or null. */
  async function fireTrigger(t: Trigger, why: string, body: string): Promise<string | null> {
    if (overDay(state.automation, todaysLedger())) {
      const held = skipReason(triggerLabel(t), state.automation);
      t.last_error = held;
      t.last_fired = Math.floor(Date.now() / 1000);
      saveTriggers();
      notify({ tone: "info", title: "Automation budget spent for today", detail: held, session: null }, "jobs");
      return null;
    }
    const session = newSession(triggerLabel(t));
    automationSessions.add(session.id);
    t.fires += 1;
    t.last_fired = Math.floor(Date.now() / 1000);
    t.last_session = session.id;
    t.last_error = null;
    t.last_body = body.trim().slice(0, 600) || null;
    saveTriggers();
    emitEvent(session, "system.log", "system", {
      event: "trigger.fired",
      trigger: t.id,
      name: triggerLabel(t),
      message: why,
    });
    log("info", "triggers", `${t.id} fired -> ${session.id}`);
    const done = startTurn(session, triggerPrompt(t, body), [], { automated: true }).then((r) => {
      t.last_error = r.error ?? null;
      saveTriggers();
      chargeSession(session.id);
      notify({
        tone: r.ok ? "ok" : "error",
        title: r.ok ? `${triggerLabel(t)} was triggered` : `${triggerLabel(t)} failed`,
        detail: r.ok ? (r.reply || "").trim().slice(0, 200) || "Done." : r.error || "It did not finish.",
        session: session.id,
      }, "jobs");
      return r;
    });
    void done.catch(() => undefined);
    return session.id;
  }

  app.get("/api/triggers", (req: Request, res: Response) => {
    const origin = `${req.protocol}://${req.get("host") ?? "localhost"}`;
    res.json(triggers.map((t) => triggerView(t, origin)));
  });

  app.post("/api/triggers", (req: Request, res: Response) => {
    const name = String(req.body?.name ?? "").trim().slice(0, 80);
    const prompt = String(req.body?.prompt ?? "").trim().slice(0, 2000);
    if (!name) return res.status(400).json({ error: "A trigger needs a name." });
    if (!prompt) return res.status(400).json({ error: "Say what the turn should do when it fires." });
    const made: Trigger = {
      id: newTriggerId(),
      name,
      prompt,
      /* Made here and shown once: whatever is going to call this needs the
         secret, and there is nowhere better to put it than the answer. */
      token: newTriggerToken(),
      enabled: true,
      created: Math.floor(Date.now() / 1000),
      fires: 0,
      last_fired: null,
      last_session: null,
      last_error: null,
    };
    triggers.push(made);
    saveTriggers();
    log("info", "triggers", `${made.id} created (${name})`);
    const origin = `${req.protocol}://${req.get("host") ?? "localhost"}`;
    res.json({ trigger: { ...triggerView(made, origin), token: made.token } });
  });

  app.patch("/api/triggers/:id", (req: Request, res: Response) => {
    const t = triggers.find((x) => x.id === req.params.id);
    if (!t) return res.status(404).json({ error: "No such trigger." });
    if (typeof req.body?.enabled === "boolean") t.enabled = req.body.enabled;
    if (typeof req.body?.name === "string" && req.body.name.trim()) t.name = req.body.name.trim().slice(0, 80);
    if (typeof req.body?.prompt === "string" && req.body.prompt.trim()) t.prompt = req.body.prompt.trim().slice(0, 2000);
    /* Rotated on request, and the only time the secret is shown again: a
       secret that has been pasted somewhere it should not have been is worth
       being able to replace without losing the trigger's history. */
    let token: string | undefined;
    if (req.body?.rotate === true) {
      t.token = newTriggerToken();
      token = t.token;
    }
    saveTriggers();
    const origin = `${req.protocol}://${req.get("host") ?? "localhost"}`;
    res.json({ trigger: { ...triggerView(t, origin), ...(token ? { token } : {}) } });
  });

  app.delete("/api/triggers/:id", (req: Request, res: Response) => {
    const at = triggers.findIndex((x) => x.id === req.params.id);
    if (at < 0) return res.status(404).json({ error: "No such trigger." });
    const [gone] = triggers.splice(at, 1);
    saveTriggers();
    log("info", "triggers", `${gone.id} deleted`);
    res.json({ ok: true });
  });

  /** The URL the rest of the world calls. A plain text body is accepted as
      well as JSON, because that is what a shell script sends. */
  app.post(
    "/api/triggers/:id/fire",
    express.text({ type: ["text/*", "application/x-www-form-urlencoded"], limit: "1mb" }),
    async (req: Request, res: Response) => {
      const t = triggers.find((x) => x.id === req.params.id);
      const refused = triggerRefusal(t);
      if (refused || !t) return res.status(404).json({ error: refused ?? "No such trigger." });
      const header = String(req.get("x-autora-token") ?? "");
      const bearer = String(req.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
      const given = header || bearer || String(req.query.token ?? "");
      if (!tokenMatches(t, given)) {
        log("info", "triggers", `${t.id} refused: the secret did not match`);
        return res.status(401).json({ error: "That token is not this trigger's." });
      }
      const raw = typeof req.body === "string" ? req.body : req.body ? JSON.stringify(req.body) : "";
      const session = await fireTrigger(
        t,
        `Triggered from outside the console by a request to ${t.id}.`,
        raw,
      );
      if (!session) return res.status(429).json({ error: t.last_error ?? "It could not start." });
      res.json({ ok: true, session });
    },
  );
}
