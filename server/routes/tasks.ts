/**
 * What a task costs, and how it went: the read for the Usage page, and the one
 * write -- the person's own mark on a task. See ../taskledger.
 */

import type { Express, Request, Response } from "express";
import { markTask, taskSummary } from "../taskledger";

export function taskRoutes(app: Express, deps: {
  /** The build that is running, so the page can ask for this harness alone. */
  version: string;
}) {
  /** Read-only. `?version=current` is this build only; `?version=1.2.3` that one; none, every build. */
  app.get("/api/tasks", (req: Request, res: Response) => {
    const asked = typeof req.query.version === "string" ? req.query.version : "";
    const version = asked === "current" ? deps.version : asked || null;
    res.json({ ...taskSummary({ version }), current: deps.version });
  });

  /** The person's word on one task: "good", "poor", or null to take it back. A write, so a POST. */
  app.post("/api/tasks/:id/mark", (req: Request, res: Response) => {
    const raw = req.body?.mark;
    if (raw !== "good" && raw !== "poor" && raw !== null) {
      return res.status(400).json({ detail: "Mark it good, poor, or null to take the mark back." });
    }
    if (!markTask(String(req.params.id), raw)) return res.status(404).json({ detail: "No such task." });
    res.json({ ...taskSummary({}), current: deps.version });
  });
}
