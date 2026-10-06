/**
 * The server's own routes: its version and how to reach it, the certificate
 * authority behind its https listener, its system report, and its log.
 *
 * These were part of server.ts, which held every route in the app alongside the
 * turn loop and the WebSocket stream. Nothing changed in the move. The values
 * that belong to the listener arrive in `deps`, since they are made at startup
 * and change while it runs.
 */

import type { Express, Request, Response } from "express";
import { readLogs, type LogLevel } from "../logs";

export function systemRoutes(app: Express, deps: {
  /** The app's version, reported to the page. */
  version: string;
  /** The https listener's settings, and whether it is up. */
  secure: { enabled: boolean; port: number; listening: boolean };
  /** The authority behind its certificates, when Autora issues its own. */
  caPem: () => string | null;
}) {
  const { version, secure } = deps;

  app.get("/api/logs", (req: Request, res: Response) => {
    const level = ["debug", "info", "warn", "error"].includes(String(req.query.level))
      ? (String(req.query.level) as LogLevel) : undefined;
    res.json(readLogs({
      level,
      component: req.query.component ? String(req.query.component) : undefined,
      q: req.query.q ? String(req.query.q) : undefined,
      after: req.query.after !== undefined ? Number(req.query.after) : undefined,
      limit: req.query.limit !== undefined ? Number(req.query.limit) : undefined,
    }));
  });
  // 1. Origin & Runtime Info
  app.get("/api/origin", (req: Request, res: Response) => {
    res.json({
      secure_port: secure.enabled ? secure.port : null,
      secure_listening: secure.listening,
      // Whether /autora-ca.crt has an authority to hand out: only when the
      // certificates are Autora's own rather than a real one from files.
      certificate: Boolean(deps.caPem()),
      version,
    });
  });

  /** The authority behind the https listener's certificates, to install on a
      device so they are trusted there (Settings -> Trust this server). */
  app.get("/autora-ca.crt", (_req: Request, res: Response) => {
    const pem = deps.caPem();
    if (!pem) return res.status(404).type("text/plain").send("This server is not issuing its own certificates.");
    res.setHeader("Content-Type", "application/x-x509-ca-cert");
    res.setHeader("Content-Disposition", 'attachment; filename="autora-ca.crt"');
    res.setHeader("Cache-Control", "no-store");
    res.send(deps.caPem() ?? "");
  });

}
