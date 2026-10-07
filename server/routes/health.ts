/**
 * How the tools have been going, the machine's vitals, what the workspace keeps, and the tools the agent wrote.
 *
 * Moved out of server.ts (docs/REVIEW.md C1); nothing changed in the move.
 * What the routes need from the rest of the server arrives in `deps`.
 */

import type { Express, Request, Response } from "express";
import { deleteCustomTool, listCustomTools } from "../customtools";
import { hostVitals } from "../host";
import { storageReport } from "../retention";
import { mergeRetention, state } from "../state";
import { toolHealth } from "../toolhealth";

export function healthRoutes(app: Express, deps: {
  /** Apply the retention policy now (server.ts: the same code the nightly sweep runs). */
  sweep: (policy: typeof state.retention) => object;
}) {
  const { sweep } = deps;
  // 9b. How the tools have been going, and the ones the agent wrote.
  app.get("/api/tools/health", (_req: Request, res: Response) => {
    res.json({ health: toolHealth() });
  });

  /* What the workspace is using, and the one button that gives some back.
     Nothing said how much was stored until this: sessions, logs and the
     Artifacts page grew for the life of the install, and the only way to get
     disk back was deleting threads one at a time. */
  /** CPU, memory and disk of the machine, for the sidebar's bars. */
  app.get("/api/host", (_req: Request, res: Response) => {
    res.json(hostVitals());
  });

  app.get("/api/storage", (_req: Request, res: Response) => {
    res.json({ storage: { ...storageReport(), policy: { ...state.retention } } });
  });

  app.post("/api/storage/prune", (req: Request, res: Response) => {
    const policy = { ...state.retention };
    if (req.body && typeof req.body === "object") mergeRetention(policy, req.body);
    const result = sweep(policy);
    res.json({ ok: true, ...result, storage: { ...storageReport(), policy: { ...state.retention } } });
  });

  app.get("/api/custom-tools", (_req: Request, res: Response) => {
    res.json({ tools: listCustomTools() });
  });

  app.delete("/api/custom-tools/:name", (req: Request, res: Response) => {
    if (!deleteCustomTool(req.params.name)) return res.status(404).json({ error: "No such tool" });
    res.json({ ok: true });
  });
}
