/**
 * The notebooks routes: listing, making, editing, exporting and deleting them,
 * and moving their entries about.
 *
 * These were part of server.ts, which held every route in the app alongside the
 * turn loop and the WebSocket stream. Nothing changed in the move: the work was
 * already in server/notebooks.ts, and this is only the HTTP in front of it.
 */

import type { Express, Request, Response } from "express";
import {
  NotebookError, addEntries, createNotebook, deleteNotebook, getNotebook, listNotebooks,
  moveEntry, notebookMarkdown, removeEntry, updateEntry, updateNotebook,
} from "../notebooks";
import { cleanName } from "../artifacts";

/** What a notebook route answers when the notebook module refuses. */
function notebookFailed(res: Response, err: unknown) {
  if (err instanceof NotebookError) {
    return res.status(/^There is no/.test(err.message) ? 404 : 400).json({ error: err.message });
  }
  throw err;
}

export function notebookRoutes(app: Express) {
  app.get("/api/notebooks", (_req: Request, res: Response) => {
    res.json({ notebooks: listNotebooks() });
  });

  app.post("/api/notebooks", (req: Request, res: Response) => {
    try {
      res.json({ notebook: createNotebook({ title: req.body?.title, purpose: req.body?.purpose, by: "user" }) });
    } catch (err) {
      notebookFailed(res, err);
    }
  });

  app.get("/api/notebooks/:id", (req: Request, res: Response) => {
    const notebook = getNotebook(req.params.id);
    if (!notebook) return res.status(404).json({ error: "No such notebook" });
    res.json({ notebook });
  });

  app.get("/api/notebooks/:id/export", (req: Request, res: Response) => {
    const notebook = getNotebook(req.params.id);
    if (!notebook) return res.status(404).json({ error: "No such notebook" });
    const body = Buffer.from(notebookMarkdown(notebook), "utf8");
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "sandbox");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(`${cleanName(notebook.title, "notebook")}.md`)}`);
    res.end(body);
  });

  app.patch("/api/notebooks/:id", (req: Request, res: Response) => {
    try {
      res.json({ notebook: updateNotebook(req.params.id, { title: req.body?.title, purpose: req.body?.purpose }) });
    } catch (err) {
      notebookFailed(res, err);
    }
  });

  app.delete("/api/notebooks/:id", (req: Request, res: Response) => {
    if (!deleteNotebook(req.params.id)) return res.status(404).json({ error: "No such notebook" });
    res.json({ ok: true });
  });

  app.post("/api/notebooks/:id/entries", (req: Request, res: Response) => {
    try {
      const body = req.body ?? {};
      const files: unknown[] = Array.isArray(body.artifacts) ? body.artifacts : [];
      const inputs = files.length
        ? files.map((artifact) => ({ artifact, text: body.text }))
        : [{ title: body.title, text: body.text, cites: body.cites }];
      const r = addEntries(req.params.id, inputs, "user", Number(body.position) || undefined);
      res.json({ notebook: r.notebook, unknown: r.unknown });
    } catch (err) {
      notebookFailed(res, err);
    }
  });

  app.patch("/api/notebooks/:id/entries/:entry", (req: Request, res: Response) => {
    try {
      const body = req.body ?? {};
      if (body.title !== undefined || body.text !== undefined || body.cites !== undefined) {
        updateEntry(req.params.id, req.params.entry, { title: body.title, text: body.text, cites: body.cites });
      }
      if (body.position !== undefined) moveEntry(req.params.id, req.params.entry, Number(body.position));
      res.json({ notebook: getNotebook(req.params.id) });
    } catch (err) {
      notebookFailed(res, err);
    }
  });

  app.delete("/api/notebooks/:id/entries/:entry", (req: Request, res: Response) => {
    try {
      if (!removeEntry(req.params.id, req.params.entry)) return res.status(404).json({ error: "No such entry" });
      res.json({ notebook: getNotebook(req.params.id) });
    } catch (err) {
      notebookFailed(res, err);
    }
  });
}
