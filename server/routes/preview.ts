/**
 * The app (Creator) window's routes: opening and closing the preview, its size, selecting and styling parts of the page, and the review comments sent to the agent as one message.
 *
 * Moved out of server.ts (docs/REVIEW.md C1); nothing changed in the move.
 * What the routes need from the rest of the server arrives in `deps`.
 */

import type { Express, Request, Response } from "express";
import { saveArtifact } from "../artifacts";
import { type AttachmentRef } from "../attach";
import { getBlob, putBlob } from "../blobs";
import { type ElementInfo, type ReviewComment, type StyleChange, pickExpression, reviewMessage, safeStyle } from "../pick";
import { DEVICES, type Device, isDevice } from "../preview";
import { type PreviewRun, type Session } from "../session-types";
import { toolSettings } from "../tools";
import type { AutoraEvent } from "../session-types";

export function previewRoutes(app: Express, deps: {
  sessions: Map<string, Session>;
  previews: Map<string, PreviewRun>;
  emitEvent: (session: Session, kind: string, actor: string, payload: Record<string, any>) => AutoraEvent;
  broadcastPreview: (session: Session) => void;
  previewState: (session: Session) => unknown;
  previewStart: (
    session: Session,
    args: { command?: string; cwd?: string; dir?: string; url?: string; port?: number },
    span: string | null,
  ) => Promise<{ ok: boolean; summary: string }>;
  previewStop: (session: Session, say?: boolean, keep?: boolean) => Promise<boolean>;
  /** Start a turn with a message (a review of the app goes to the agent as one). */
  startTurn: (session: Session, text: string, attachments: AttachmentRef[], opts: { shown?: string }) => Promise<unknown>;
}) {
  const { sessions, previews, emitEvent, broadcastPreview, previewState, previewStart, previewStop, startTurn } = deps;
  // ---- the app window -------------------------------------------------------
  const withPreview = (req: Request, res: Response): { session: Session; run: PreviewRun } | null => {
    const session = sessions.get(req.params.id);
    if (!session) { res.status(404).json({ error: "Session not found" }); return null; }
    const run = previews.get(session.id);
    if (!run?.opened) { res.status(400).json({ error: "No app preview is open." }); return null; }
    return { session, run };
  };
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number.NaN);
  const asInfo = (v: any): ElementInfo | null => (v && typeof v === "object" && typeof v.selector === "string" ? v as ElementInfo : null);

  app.get("/api/sessions/:id/preview", (req: Request, res: Response) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    res.json(previewState(session));
  });

  app.post("/api/sessions/:id/preview/open", async (req: Request, res: Response) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
    if (!url) return res.status(400).json({ error: "Give an address on this machine, like http://localhost:5173." });
    if (!toolSettings().app.enabled) return res.status(409).json({ error: "The app window is switched off on the Tools page." });
    const r = await previewStart(session, { url }, null);
    res.status(r.ok ? 200 : 400).json(r.ok ? { ok: true } : { error: r.summary });
  });

  app.post("/api/sessions/:id/preview/close", async (req: Request, res: Response) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    await previewStop(session);
    res.json({ ok: true });
  });

  app.post("/api/sessions/:id/preview/device", async (req: Request, res: Response) => {
    const ctx = withPreview(req, res);
    if (!ctx) return;
    if (!isDevice(req.body?.device)) return res.status(400).json({ error: "A device is phone, tablet or desktop." });
    const device: Device = req.body.device;
    ctx.run.device = device;
    await ctx.run.live.resize(DEVICES[device].width, DEVICES[device].height);
    broadcastPreview(ctx.session);
    void ctx.run.live.nudge();
    res.json({ ok: true, viewport: ctx.run.live.viewport() });
  });

  app.post("/api/sessions/:id/preview/reload", async (req: Request, res: Response) => {
    const ctx = withPreview(req, res);
    if (!ctx) return;
    // Cleared first: the reload is what says again what is still wrong.
    ctx.run.live.clearConsole();
    await ctx.run.live.reload().catch(() => undefined);
    broadcastPreview(ctx.session);
    res.json({ ok: true });
  });

  /* What is at a point, or what is beside / inside / around a selected
     element. `light` is the hover's version: a box and a name, nothing else. */
  app.post("/api/sessions/:id/preview/inspect", async (req: Request, res: Response) => {
    const ctx = withPreview(req, res);
    if (!ctx) return;
    const light = req.body?.light === true;
    let request: Record<string, unknown>;
    if (typeof req.body?.selector === "string") {
      const nav = ["parent", "child", "next", "prev"].includes(req.body?.nav) ? req.body.nav : undefined;
      request = { op: "sel", selector: req.body.selector.slice(0, 600), nav, light };
    } else {
      const x = num(req.body?.x), y = num(req.body?.y);
      if (Number.isNaN(x) || Number.isNaN(y)) return res.status(400).json({ error: "Give x and y, or a selector." });
      request = { op: "at", x: Math.round(x), y: Math.round(y), light };
    }
    const info = await ctx.run.live.pickOp(pickExpression(request)).catch(() => null);
    res.json({ info: info && info.ok !== false ? info : null });
  });

  /* Where the things already picked are now: the page scrolls and re-lays
     itself out, and a pin stays on its element. */
  app.post("/api/sessions/:id/preview/rects", async (req: Request, res: Response) => {
    const ctx = withPreview(req, res);
    if (!ctx) return;
    const selectors = Array.isArray(req.body?.selectors)
      ? req.body.selectors.filter((x: unknown) => typeof x === "string").slice(0, 60).map((x: string) => x.slice(0, 600))
      : [];
    const out = await ctx.run.live.pickOp(pickExpression({ op: "rects", selectors })).catch(() => null);
    res.json(Array.isArray(out?.rects) ? out : { scroll: { x: 0, y: 0 }, rects: selectors.map(() => null) });
  });

  /* Trying a change on the page to show what is meant. Only the properties in
     EDITABLE_STYLES, only plain values: the page is not a place to run the
     person's (or anyone's) script. */
  app.post("/api/sessions/:id/preview/style", async (req: Request, res: Response) => {
    const ctx = withPreview(req, res);
    if (!ctx) return;
    const selector = typeof req.body?.selector === "string" ? req.body.selector.slice(0, 600) : "";
    const asked = req.body?.css && typeof req.body.css === "object" ? req.body.css as Record<string, unknown> : {};
    const css: Record<string, string> = {};
    for (const [k, v] of Object.entries(asked)) {
      const value = safeStyle(k, v);
      if (value === null) return res.status(400).json({ error: `${k} cannot be changed here.` });
      css[k] = value;
    }
    if (!selector || Object.keys(css).length === 0) return res.status(400).json({ error: "Give a selector and a style." });
    const out = await ctx.run.live.pickOp(pickExpression({ op: "style", selector, css })).catch(() => null);
    if (!out?.ok) return res.status(400).json({ error: out?.error ?? "That could not be applied." });
    res.json(out);
  });

  app.post("/api/sessions/:id/preview/text", async (req: Request, res: Response) => {
    const ctx = withPreview(req, res);
    if (!ctx) return;
    const selector = typeof req.body?.selector === "string" ? req.body.selector.slice(0, 600) : "";
    const text = typeof req.body?.text === "string" ? req.body.text.slice(0, 2000) : null;
    if (!selector || text === null) return res.status(400).json({ error: "Give a selector and the new text." });
    const out = await ctx.run.live.pickOp(pickExpression({ op: "text", selector, text })).catch(() => null);
    if (!out?.ok) return res.status(400).json({ error: out?.error ?? "That could not be applied." });
    res.json(out);
  });

  app.post("/api/sessions/:id/preview/reset", async (req: Request, res: Response) => {
    const ctx = withPreview(req, res);
    if (!ctx) return;
    const selector = typeof req.body?.selector === "string" ? req.body.selector.slice(0, 600) : "";
    if (!selector) return res.status(400).json({ error: "Give a selector." });
    const out = await ctx.run.live.pickOp(pickExpression({ op: "reset", selector })).catch(() => null);
    res.json(out ?? { ok: false });
  });

  /* A comment joins the review. What it is about is read off the page now,
     and its picture taken now -- the page will have moved on by the time the
     review is sent. */
  app.post("/api/sessions/:id/preview/comments", async (req: Request, res: Response) => {
    const ctx = withPreview(req, res);
    if (!ctx) return;
    const { session, run } = ctx;
    if (run.comments.length >= 30) return res.status(400).json({ error: "That is a lot of comments for one review. Send these first." });
    const body = req.body ?? {};
    const kind = body.kind === "region" ? "region" : "element";
    const text = typeof body.text === "string" ? body.text.trim().slice(0, 2000) : "";
    if (!text && !body.textEdit && !(Array.isArray(body.styleChanges) && body.styleChanges.length)) {
      return res.status(400).json({ error: "Say what to change." });
    }
    const size = run.live.viewport();
    const scroll = await run.live.pickOp(pickExpression({ op: "scroll" })).catch(() => null);
    const elements: ElementInfo[] = [];
    let region: ReviewComment["region"];
    if (kind === "element") {
      const selectors: string[] = Array.isArray(body.selectors) ? body.selectors.filter((x: unknown) => typeof x === "string").slice(0, 12) : [];
      if (selectors.length === 0) return res.status(400).json({ error: "Select an element first." });
      for (const selector of selectors) {
        const info = asInfo(await run.live.pickOp(pickExpression({ op: "sel", selector: selector.slice(0, 600) })).catch(() => null));
        if (info) elements.push(info);
      }
      if (elements.length === 0) return res.status(400).json({ error: "That element is no longer on the page." });
    } else {
      const r = body.region ?? {};
      const x = num(r.x), y = num(r.y), w = num(r.w), h = num(r.h);
      if ([x, y, w, h].some(Number.isNaN) || w < 4 || h < 4) return res.status(400).json({ error: "Drag a rectangle first." });
      region = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
      /* What is in the rectangle, so the agent has more than pixels: the
         element at its centre, which is usually what was meant. */
      const centre = asInfo(await run.live.pickOp(pickExpression({ op: "at", x: Math.round(x + w / 2), y: Math.round(y + h / 2) })).catch(() => null));
      if (centre) elements.push(centre);
    }

    /* The picture: the region as drawn, or the elements together with a
       margin of the page around them, so what they sit among is in it. */
    let box: { x: number; y: number; w: number; h: number } | { selector: string };
    if (region) {
      box = region;
    } else {
      const pad = 16;
      const x0 = Math.max(0, Math.min(...elements.map((e) => e.rect.x)) - pad);
      const y0 = Math.max(0, Math.min(...elements.map((e) => e.rect.y)) - pad);
      const x1 = Math.min(size.width, Math.max(...elements.map((e) => e.rect.x + e.rect.w)) + pad);
      const y1 = Math.min(size.height, Math.max(...elements.map((e) => e.rect.y + e.rect.h)) + pad);
      // Scrolled out of the window since it was picked: a picture of the element itself.
      box = x1 - x0 >= 8 && y1 - y0 >= 8 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : { selector: elements[0].selector };
    }
    const png = await run.live.cropShot(box);
    const blob = png ? putBlob(session.id, png, "image/png") : null;

    const styleChanges: StyleChange[] = Array.isArray(body.styleChanges)
      ? body.styleChanges.slice(0, 20).map((c: any) => ({
        property: String(c?.property ?? "").slice(0, 40), from: String(c?.from ?? "").slice(0, 80), to: String(c?.to ?? "").slice(0, 80),
      })).filter((c: StyleChange) => c.property && c.to)
      : [];
    const textEdit = body.textEdit && typeof body.textEdit === "object"
      ? { from: String(body.textEdit.from ?? "").slice(0, 2000), to: String(body.textEdit.to ?? "").slice(0, 2000) }
      : undefined;
    const comment: ReviewComment = {
      id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      kind, text, elements, ...(region ? { region } : {}),
      ...(textEdit && textEdit.from !== textEdit.to ? { textEdit } : {}),
      styleChanges, blob,
      scroll: { x: scroll?.x ?? 0, y: scroll?.y ?? 0 },
      viewport: size, ts: Date.now(),
    };
    run.comments.push(comment);
    broadcastPreview(session);
    res.json({ ok: true, comment });
  });

  app.post("/api/sessions/:id/preview/comments/:cid", (req: Request, res: Response) => {
    const ctx = withPreview(req, res);
    if (!ctx) return;
    const comment = ctx.run.comments.find((c) => c.id === req.params.cid);
    if (!comment) return res.status(404).json({ error: "No such comment." });
    if (typeof req.body?.text === "string") comment.text = req.body.text.trim().slice(0, 2000);
    broadcastPreview(ctx.session);
    res.json({ ok: true, comment });
  });

  app.delete("/api/sessions/:id/preview/comments/:cid", (req: Request, res: Response) => {
    const ctx = withPreview(req, res);
    if (!ctx) return;
    const before = ctx.run.comments.length;
    ctx.run.comments = ctx.run.comments.filter((c) => c.id !== req.params.cid);
    if (ctx.run.comments.length === before) return res.status(404).json({ error: "No such comment." });
    broadcastPreview(ctx.session);
    res.json({ ok: true });
  });

  /* The review, sent: every comment as one message, each with its picture
     attached, so one turn answers all of them. */
  app.post("/api/sessions/:id/preview/send", (req: Request, res: Response) => {
    const ctx = withPreview(req, res);
    if (!ctx) return;
    const { session, run } = ctx;
    const comments = run.comments;
    const note = typeof req.body?.text === "string" ? req.body.text.trim().slice(0, 2000) : "";
    if (comments.length === 0 && !note) return res.status(400).json({ error: "There is nothing to send yet." });
    const refs: AttachmentRef[] = [];
    comments.forEach((c, i) => {
      const blob = c.blob ? getBlob(c.blob) : null;
      if (!blob) return;
      try {
        const saved = saveArtifact({
          origin: "user", name: `review-${i + 1}.png`, data: blob.data, mime: "image/png", session: session.id,
          note: `A picture from the app review, comment ${i + 1}`,
        });
        refs.push({ id: saved.id, name: saved.name, mime: saved.mime, size: saved.size });
      } catch {
        // A picture that cannot be kept is not worth losing the comment for.
      }
    });
    const errors = run.live.consoleTail(8).filter((e) => e.kind === "error").map((e) => e.text);
    const body = reviewMessage({
      url: run.url ?? "", viewport: run.live.viewport(), device: DEVICES[run.device].label, comments, consoleErrors: errors,
    });
    const text = note ? `${note}\n\n${body}` : body;
    const count = comments.length;
    run.comments = [];
    emitEvent(session, "preview.review", "user", { count });
    broadcastPreview(session);
    res.json({ ok: true, queued: false });
    void startTurn(session, text, refs, {
      shown: count > 0 ? `Reviewed the app: ${count} comment${count === 1 ? "" : "s"}${note ? ` -- ${note}` : ""}` : note,
    });
  });
}
