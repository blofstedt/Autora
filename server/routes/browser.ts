/**
 * The live browser's routes: scrolling, clicking, typing, navigating, tabs, finding, developer tools, bookmarks, history and extensions, and the app window's version history.
 *
 * Moved out of server.ts (docs/REVIEW.md C1); nothing changed in the move.
 * What the routes need from the rest of the server arrives in `deps`.
 */

import express, { type Express, type Request, type Response } from "express";
import { addBookmark, bookmarks, clearHistory, downloads, history, removeBookmark } from "../browsedata";
import { addressFor } from "../browser";
import { installFromStore, installPackage, listExtensions, removeExtension, setExtensionEnabled } from "../extensions";
import { isLocalUrl, localAddress } from "../preview";
import { versions as folderVersions, restore as restoreVersion } from "../snapshots";
import { terminalDir } from "../tools";
import type { LiveBrowser } from "../browser";
import type { Surface } from "../presence";
import type { Session, PreviewRun, AutoraEvent } from "../session-types";

export function browserRoutes(app: Express, deps: {
  sessions: Map<string, Session>;
  browsers: Map<string, LiveBrowser>;
  previews: Map<string, PreviewRun>;
  /** The session's browser, made on first use. */
  browserFor: (session: Session) => LiveBrowser;
  /** The preview's browser when the request says `?target=preview`, else the session's. */
  targetBrowser: (session: Session, req: Request) => LiveBrowser | undefined;
  isPreview: (req: Request) => boolean;
  /** The agent has the browser in a turn and the person has not taken it. */
  agentDriving: (session: Session) => boolean;
  describeOnPage: (live: LiveBrowser, at: { x: number; y: number } | null) => Promise<{ what: string; secret: boolean }>;
  touchPresence: (
    sessionId: string, surface: Surface, subject: string, kind: string, detail: string,
    opts?: { leaseMs?: number; tell?: boolean },
  ) => void;
  broadcastBrowserState: (session: Session) => void;
  emitEvent: (session: Session, kind: string, actor: string, payload: Record<string, any>) => AutoraEvent;
}) {
  const {
    sessions, browsers, previews, browserFor, targetBrowser, isPreview, agentDriving, describeOnPage,
    touchPresence, broadcastBrowserState, emitEvent,
  } = deps;
  // 6b. Live Browser Direct Interaction & Handoff
  const DRIVING =
    "The agent is using the browser. Take control to use it yourself -- it will carry on with other work -- or stop it.";

  app.post("/api/sessions/:id/browser/scroll", async (req: Request, res: Response) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (!isPreview(req) && agentDriving(session)) return res.status(409).json({ error: DRIVING });
    const live = targetBrowser(session, req);
    if (!live?.status().open) return res.status(400).json({ error: "No page is open." });

    const dx = Number(req.body?.dx ?? 0);
    const dy = Number(req.body?.dy ?? 0);
    try {
      touchPresence(session.id, isPreview(req) ? "app" : "browser", "*", "scroll", "scrolled the page", { tell: false });
      await live.mouseWheel(dx, dy);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Scroll failed" });
    }
  });

  app.post("/api/sessions/:id/browser/reload", async (req: Request, res: Response) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (!isPreview(req) && agentDriving(session)) return res.status(409).json({ error: DRIVING });
    const live = targetBrowser(session, req);
    if (!live?.status().open) return res.status(400).json({ error: "No page is open." });

    try {
      const page = await live.reload();
      res.json({ ok: true, url: page.url, title: page.title });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Reload failed" });
    }
  });

  app.post("/api/sessions/:id/browser/back", async (req: Request, res: Response) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (!isPreview(req) && agentDriving(session)) return res.status(409).json({ error: DRIVING });
    const live = targetBrowser(session, req);
    if (!live?.status().open) return res.status(400).json({ error: "No page is open." });

    try {
      const page = await live.goBack();
      res.json({ ok: true, url: page?.url, title: page?.title });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Back navigation failed" });
    }
  });

  app.post("/api/sessions/:id/browser/click", async (req: Request, res: Response) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (!isPreview(req) && agentDriving(session)) return res.status(409).json({ error: DRIVING });
    const live = targetBrowser(session, req);
    if (!live?.status().open) return res.status(400).json({ error: "No page is open." });

    const x = Number(req.body?.x);
    const y = Number(req.body?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return res.status(400).json({ error: "Invalid click coordinates." });
    }

    try {
      const button = req.body?.button === "right" ? "right" : req.body?.button === "middle" ? "middle" : "left";
      // What the person is about to click, said to the agent as they do it.
      const under = await describeOnPage(live, { x, y });
      touchPresence(session.id, isPreview(req) ? "app" : "browser", "*", "click", `${req.body?.double ? "double-clicked" : "clicked"} ${under.what}`);
      const { editable, select } = await live.userClick(x, y, button, !!req.body?.double);
      // A dropdown answers with its choices: the app shows them itself.
      res.json({ ok: true, editable, select: select ?? null });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Click failed" });
    }
  });

  // A drag from the person's own hand, in three parts, so what they are
  // dragging follows the pointer instead of jumping when they let go.
  app.post("/api/sessions/:id/browser/drag", async (req: Request, res: Response) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (!isPreview(req) && agentDriving(session)) return res.status(409).json({ error: DRIVING });
    const live = targetBrowser(session, req);
    if (!live?.status().open) return res.status(400).json({ error: "No page is open." });

    const phase = req.body?.phase === "start" ? "start" : req.body?.phase === "end" ? "end" : "move";
    const x = Number(req.body?.x);
    const y = Number(req.body?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return res.status(400).json({ error: "Invalid drag coordinates." });
    }

    try {
      touchPresence(session.id, isPreview(req) ? "app" : "browser", "*", "drag", "dragged on the page", { tell: false });
      const out = await live.userDrag(phase, x, y);
      res.json({ ...out, ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Drag failed" });
    }
  });

  // The choice made from a dropdown's list in the app, set on the page.
  app.post("/api/sessions/:id/browser/choose", async (req: Request, res: Response) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (!isPreview(req) && agentDriving(session)) return res.status(409).json({ error: DRIVING });
    const live = targetBrowser(session, req);
    if (!live?.status().open) return res.status(400).json({ error: "No page is open." });

    const x = Number(req.body?.x);
    const y = Number(req.body?.y);
    const index = Number(req.body?.index);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(index)) {
      return res.status(400).json({ error: "Invalid choice." });
    }

    try {
      touchPresence(session.id, isPreview(req) ? "app" : "browser", "*", "choose", "picked an option from a menu", { tell: true });
      const out = await live.chooseOption(x, y, index);
      res.json({ ...out, ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Choosing failed" });
    }
  });

  app.post("/api/sessions/:id/browser/type", async (req: Request, res: Response) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (!isPreview(req) && agentDriving(session)) return res.status(409).json({ error: DRIVING });
    const live = targetBrowser(session, req);
    if (!live?.status().open) return res.status(400).json({ error: "No page is open." });

    const text = String(req.body?.text ?? "");
    try {
      const into = await describeOnPage(live, null);
      touchPresence(
        session.id, isPreview(req) ? "app" : "browser", "*", "type",
        into.secret ? "typed into a password field" : `typed ${JSON.stringify(text.length > 40 ? `${text.slice(0, 37)}...` : text)} into ${into.what}`,
      );
      await live.keyboardType(text);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Type failed" });
    }
  });

  app.post("/api/sessions/:id/browser/key", async (req: Request, res: Response) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (!isPreview(req) && agentDriving(session)) return res.status(409).json({ error: DRIVING });
    const live = targetBrowser(session, req);
    if (!live?.status().open) return res.status(400).json({ error: "No page is open." });

    const key = String(req.body?.key ?? "");
    if (!key) return res.status(400).json({ error: "No key specified." });

    try {
      touchPresence(session.id, isPreview(req) ? "app" : "browser", "*", "key", `pressed ${key}`, { tell: /^(Enter|Escape|Tab|Delete|Backspace)$/i.test(key) });
      await live.keyboardPress(key);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Key press failed" });
    }
  });

  app.post("/api/sessions/:id/browser/navigate", async (req: Request, res: Response) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (!isPreview(req) && agentDriving(session)) return res.status(409).json({ error: DRIVING });
    const live = targetBrowser(session, req);
    if (!live) return res.status(400).json({ error: "No browser active." });

    const url = String(req.body?.url ?? "").trim();
    if (!url) return res.status(400).json({ error: "No URL specified." });
    // The app window shows what is being built here, and nothing else.
    if (isPreview(req) && !isLocalUrl(addressFor(url))) {
      return res.status(400).json({ error: "The app window only opens addresses on this machine." });
    }

    try {
      touchPresence(session.id, isPreview(req) ? "app" : "browser", "*", "navigate", `went to ${url.length > 80 ? `${url.slice(0, 77)}...` : url}`);
      const page = await live.goto(isPreview(req) ? localAddress(addressFor(url)) : url);
      res.json({ ok: true, url: page.url, title: page.title });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Navigation failed" });
    }
  });

  /** Pages visited, bookmarks and downloads: the browser's own lists. */
  app.get("/api/browser/data", (req: Request, res: Response) => {
    res.json({
      history: history(String(req.query.q ?? "")).slice(0, 200),
      bookmarks: bookmarks(),
      downloads: downloads(),
    });
  });

  app.post("/api/browser/bookmarks", (req: Request, res: Response) => {
    const url = String(req.body?.url ?? "");
    if (req.body?.remove) { removeBookmark(url); return res.json({ ok: true }); }
    const mark = addBookmark(url, String(req.body?.title ?? ""));
    if (!mark) return res.status(400).json({ error: "Only web pages can be bookmarked." });
    res.json({ ok: true, bookmark: mark });
  });

  /** Chrome extensions. They see every page, so each is installed by name. */
  app.get("/api/extensions", (_req: Request, res: Response) => {
    res.json({ extensions: listExtensions() });
  });

  app.post("/api/extensions/install", async (req: Request, res: Response) => {
    try {
      res.json({ ok: true, extension: await installFromStore(String(req.body?.source ?? "")) });
    } catch (err: any) {
      res.status(400).json({ error: err?.message ?? "Could not install that." });
    }
  });

  app.post("/api/extensions/upload", express.raw({ type: "*/*", limit: "60mb" }), (req: Request, res: Response) => {
    try {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new Error("Send the extension's .zip or .crx file.");
      const name = String(req.query.name ?? "extension").replace(/\.(zip|crx)$/i, "");
      res.json({ ok: true, extension: installPackage(req.body, "file", name) });
    } catch (err: any) {
      res.status(400).json({ error: err?.message ?? "Could not install that." });
    }
  });

  app.post("/api/extensions/item/:id", (req: Request, res: Response) => {
    const id = String(req.params.id);
    const done = req.body?.remove ? removeExtension(id) : setExtensionEnabled(id, !!req.body?.enabled);
    res.status(done ? 200 : 404).json(done ? { ok: true } : { error: "No such extension." });
  });

  /** Extensions load when the browser starts: close every chat's browser so
      the next page opens with the current set. */
  app.post("/api/extensions/restart", async (_req: Request, res: Response) => {
    for (const [id, live] of [...browsers]) {
      await live.close().catch(() => undefined);
      browsers.delete(id);
      const session = sessions.get(id);
      if (session) broadcastBrowserState(session);
    }
    res.json({ ok: true });
  });

  app.post("/api/browser/history/clear", (_req: Request, res: Response) => {
    clearHistory();
    res.json({ ok: true });
  });

  app.post("/api/sessions/:id/browser/find", async (req: Request, res: Response) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    const live = targetBrowser(session, req);
    if (!live?.status().open) return res.status(400).json({ error: "No page is open." });
    const found = await live.find(String(req.body?.text ?? "").slice(0, 200), !!req.body?.backwards);
    res.json({ ok: true, found });
  });

  /** DevTools' console and network for the open tab (polled by the panel). */
  app.get("/api/sessions/:id/browser/devtools", (req: Request, res: Response) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    const live = isPreview(req) ? previews.get(session.id)?.live : browsers.get(session.id);
    if (!live) return res.json({ entries: [] });
    res.json({
      entries: live.devtools({
        kind: req.query.kind === "request" ? "request" : req.query.kind === "console" ? "console" : undefined,
        since: Number(req.query.since) || 0,
      }),
    });
  });

  app.post("/api/sessions/:id/browser/devtools/clear", (req: Request, res: Response) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    targetBrowser(session, req)?.clearDevtools();
    res.json({ ok: true });
  });

  /** The folder the agent builds in: its saved versions, and going back to one. */
  app.get("/api/versions", async (_req: Request, res: Response) => {
    res.json({ folder: terminalDir(), versions: await folderVersions(terminalDir()) });
  });

  app.post("/api/versions/restore", async (req: Request, res: Response) => {
    const session = req.body?.session ? sessions.get(String(req.body.session)) : undefined;
    if (session && agentDriving(session)) return res.status(409).json({ error: "The agent is working; wait for it to finish or stop it first." });
    try {
      const saved = await restoreVersion(terminalDir(), String(req.body?.id ?? ""));
      if (session) {
        emitEvent(session, "version.restored", "user", { id: String(req.body?.id), label: saved?.label ?? "" });
        const run = previews.get(session.id);
        if (run?.opened) void run.live.reload().catch(() => undefined);
      }
      res.json({ ok: true, versions: await folderVersions(terminalDir()) });
    } catch (err: any) {
      res.status(400).json({ error: err?.message ?? "Could not restore that." });
    }
  });

  app.post("/api/sessions/:id/browser/forward", async (req: Request, res: Response) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (!isPreview(req) && agentDriving(session)) return res.status(409).json({ error: DRIVING });
    const live = targetBrowser(session, req);
    if (!live?.status().open) return res.status(400).json({ error: "No page is open." });
    try {
      const page = await live.goForward();
      res.json({ ok: true, url: page?.url, title: page?.title });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Forward navigation failed" });
    }
  });

  /** The tab strip: open, switch to and close tabs. */
  app.post("/api/sessions/:id/browser/tabs", async (req: Request, res: Response) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (isPreview(req)) return res.status(400).json({ error: "The app window has one page." });
    if (agentDriving(session)) return res.status(409).json({ error: DRIVING });
    const live = targetBrowser(session, req) ?? browserFor(session);
    const action = String(req.body?.action ?? "");
    const id = Number(req.body?.id);
    try {
      touchPresence(session.id, "browser", "*", "tabs", `${action === "new" ? "opened" : action === "close" ? "closed" : "switched"} a tab`);
      if (action === "new") await live.newTab(typeof req.body?.url === "string" ? req.body.url : undefined);
      else if (action === "switch" && Number.isInteger(id)) await live.switchTab(id);
      else if (action === "close" && Number.isInteger(id)) await live.closeTab(id);
      else return res.status(400).json({ error: "Say action new, switch or close, and the tab's id." });
      broadcastBrowserState(session);
      res.json({ ok: true, tabs: live.tabList() });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "That did not work." });
    }
  });
}
