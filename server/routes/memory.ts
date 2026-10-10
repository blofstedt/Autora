/**
 * The memory graph's routes, and the three small switches the Mind page keeps beside it (learning, grounding, collaboration remarks, the agent's cursor).
 *
 * Moved out of server.ts (docs/REVIEW.md C1); nothing changed in the move.
 * What the routes need from the rest of the server arrives in `deps`.
 */

import type { Express, Request, Response } from "express";
import { MEMORY_KINDS, type MemoryGraph, type MemoryRecord } from "../memory";
import { tidyRecords } from "../mindrules";
import { save, state } from "../state";

export function memoryRoutes(app: Express, deps: { mind: MemoryGraph }) {
  const { mind } = deps;
  // 8. Memory / Knowledge Web
  app.get("/api/memory", (req: Request, res: Response) => {
    const q = ((req.query.q as string) || "").toLowerCase().trim();

    let records = mind.records;
    if (q) {
      records = records.filter(
        (r) =>
          r.title.toLowerCase().includes(q) ||
          r.body.toLowerCase().includes(q) ||
          r.tags.some((t) => t.toLowerCase().includes(q)),
      );
    }

    res.json({
      records,
      links: mind.links,
      enabled: true,
      learning: state.learning,
      groundFirst: state.groundFirst,
    });
  });

  /** Whether the agent says a word about what the person does in the windows they share. */
  app.get("/api/collaboration", (_req: Request, res: Response) => {
    res.json({ remarks: state.collabRemarks, threads: state.threadsAlive, news: state.threadsNews });
  });
  app.patch("/api/collaboration", (req: Request, res: Response) => {
    if (typeof req.body?.remarks === "boolean") state.collabRemarks = req.body.remarks;
    if (typeof req.body?.threads === "boolean") state.threadsAlive = req.body.threads;
    if (typeof req.body?.news === "boolean") state.threadsNews = req.body.news;
    if (["remarks", "threads", "news"].some((k) => typeof req.body?.[k] === "boolean")) save();
    res.json({ remarks: state.collabRemarks, threads: state.threadsAlive, news: state.threadsNews });
  });

  /** Whether the agent's work is shown as it is done (the cursor, the typed code). */
  app.get("/api/agent-cursor", (_req: Request, res: Response) => {
    res.json({ on: state.agentCursor });
  });
  app.patch("/api/agent-cursor", (req: Request, res: Response) => {
    if (typeof req.body?.on === "boolean") {
      state.agentCursor = req.body.on;
      save();
    }
    res.json({ on: state.agentCursor });
  });

  /** Whether the agent writes down what it learns after a turn. */
  app.patch("/api/memory-settings", (req: Request, res: Response) => {
    if (typeof req.body?.learning === "boolean") {
      state.learning = req.body.learning;
      save();
    }
    if (typeof req.body?.groundFirst === "boolean") {
      state.groundFirst = req.body.groundFirst;
      save();
    }
    res.json({ learning: state.learning, groundFirst: state.groundFirst });
  });

  /**
   * Bring the existing memories up to the mind's rules (server/mindrules.ts): filed under a
   * subject, tidy titles. What needs judgment is listed, not rewritten. `dry` only reports.
   * A POST because it changes records.
   */
  app.post("/api/memory/tidy", (req: Request, res: Response) => {
    if (req.body?.dry === true) {
      const copy = structuredClone(mind.records) as MemoryRecord[];
      return res.json({ dry: true, ...tidyRecords(copy) });
    }
    const report = tidyRecords(mind.records);
    if (report.fixed.length > 0) mind.save();
    res.json({ dry: false, ...report });
  });

  app.post("/api/memory", (req: Request, res: Response) => {
    const title = (req.body?.title || "").trim();
    if (!title) return res.status(400).json({ error: "Title is required" });
    const { record } = mind.write({
      title,
      body: req.body?.body || "",
      kind: MEMORY_KINDS.includes(req.body?.kind) ? req.body.kind : "skill",
      tags: Array.isArray(req.body?.tags) ? req.body.tags : [],
      status: "confirmed",
      source_session: req.body?.source_session || null,
      ...(typeof req.body?.subject === "string" && req.body.subject.trim() ? { subject: req.body.subject.trim().toLowerCase().slice(0, 60) } : {}),
    });
    if (typeof req.body?.pinned === "boolean") mind.update(record.id, { pinned: req.body.pinned });
    res.json(record);
  });

  app.get("/api/memory/:id", (req: Request, res: Response) => {
    const record = mind.get(req.params.id);
    if (!record) return res.status(404).json({ error: "Record not found" });
    res.json(record);
  });

  app.patch("/api/memory/:id", (req: Request, res: Response) => {
    const record = mind.get(req.params.id);
    if (!record) return res.status(404).json({ error: "Record not found" });
    mind.update(record.id, {
      title: req.body.title,
      body: req.body.body,
      kind: req.body.kind,
      tags: Array.isArray(req.body.tags) ? req.body.tags : undefined,
      pinned: req.body.pinned !== undefined ? Boolean(req.body.pinned) : undefined,
      subject: typeof req.body.subject === "string" ? req.body.subject : undefined,
    });
    // Confirming is more than a field: a confirmed rewrite retires what it
    // rewrote.
    if (req.body.status === "confirmed") mind.confirm(record.id);
    else if (req.body.status === "provisional") record.status = "provisional";
    res.json(record);
  });

  /** Keep something the agent learned: it is known from now on. */
  app.post("/api/memory/:id/confirm", (req: Request, res: Response) => {
    const record = mind.confirm(req.params.id);
    if (!record) return res.status(404).json({ error: "Record not found" });
    res.json(record);
  });

  app.delete("/api/memory/:id", (req: Request, res: Response) => {
    if (!mind.forget(req.params.id)) return res.status(404).json({ error: "Record not found" });
    res.json({ ok: true });
  });
}
