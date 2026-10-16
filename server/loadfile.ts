/**
 * A saved file, loaded into an app's window -- the person's own way in from Artifacts.
 *
 * Every app's bar has Save, which keeps what is in the window in Artifacts. This is its other half: Load picks a file
 * from Artifacts and puts it in the window beside the chat, with no message and no turn. The agent finds out the way it
 * finds out about anything the person does in a window (the window's news, said with its next result).
 *
 * Each app takes what it can use: Pages, Sheets and Slides their own kind of document, PDF a PDF, Photo a picture (or a
 * PSD), Video media for the project's library (a video, a sound or a picture), Music a song it kept, 3D a model it kept,
 * Games a game it kept or a file for the game's resources (a picture, a sound, a font). The same engines the agent's
 * tools use do the work, so a file loaded here is in the window exactly as one the agent opened would be.
 */
import type { Express, Request, Response } from "express";
import { getArtifact, readArtifact, type Artifact } from "./artifacts";
import { loadModel } from "./caddesk";
import { loadGame, runGameTool } from "./gamedesk";
import { officeHooks } from "./officedesk";
import { runVideoTool } from "./opencut";
import { deskHooks } from "./pdfdesk";
import { runPhotoTool } from "./photodesk";
import { loadSong } from "./studio";
import { terminalDir } from "./tools";
import { LOAD_APPS, loadable, type LoadApp } from "../src/lib/loadable";

export { LOAD_APPS, loadable, type LoadApp };

const NAME: Record<LoadApp, string> = {
  pdf: "Autora PDF", pages: "Autora Pages", sheets: "Autora Sheets", slides: "Autora Slides", photo: "Autora Photo",
  video: "Autora Video", studio: "Autora Music", cad: "Autora 3D", game: "Autora Games",
};

type Done = { ok: boolean; error?: string; said?: string };

async function load(session: string, app: LoadApp, art: Artifact): Promise<Done> {
  const data = readArtifact(art.id);
  if (!data) return { ok: false, error: "That file is no longer there." };
  const quiet = { cwd: terminalDir() };
  const origin = {
    working: art.origin === "agent" ? art.id : null,
    source: art.origin === "user" ? art.id : null,
  };
  switch (app) {
    case "pdf": {
      // A PDF that wants a password nobody has given is not opened here: the window could not show it.
      const { PDFDocument } = await import("@cantoo/pdf-lib");
      try {
        await PDFDocument.load(data);
      } catch (err) {
        return { ok: false, error: /encrypt|password/i.test(String((err as Error)?.message)) ? "That PDF is password-protected. Ask Autora to open it with the password." : "That is not a PDF Autora PDF can read." };
      }
      deskHooks(session).open({ name: art.name, base: data, items: [], ...origin, outName: art.name });
      return { ok: true, said: `${art.name} is open in Autora PDF.` };
    }
    case "pages": case "sheets": case "slides": {
      const win = officeHooks(session);
      // What was just typed in the document that is open reaches its file before another opens over it.
      await win.settle();
      win.open({ name: art.name, data, ...origin, outName: art.name, label: "Opened by you" });
      return { ok: true, said: `${art.name} is open in ${NAME[app]}.` };
    }
    case "photo": {
      const out = await runPhotoTool(session, "photo_open", { file: art.id }, quiet);
      return out.ok ? { ok: true, said: `${art.name} is open in Autora Photo.` } : { ok: false, error: out.summary };
    }
    case "video": {
      const ctx = { session, cwd: terminalDir(), cancelled: () => false };
      const opened = await runVideoTool("video_open", {}, ctx);
      if (!opened.ok) return { ok: false, error: opened.summary };
      const out = await runVideoTool("video_import", { file: art.id }, ctx);
      return out.ok ? { ok: true, said: `${art.name} is in the video project's media.` } : { ok: false, error: out.summary };
    }
    case "studio": {
      const out = loadSong(session, data);
      return out.ok ? { ok: true, said: `${out.name ?? art.name} is open in Autora Music.` } : { ok: false, error: out.error };
    }
    case "cad": {
      const out = await loadModel(session, data);
      return out.ok ? { ok: true, said: `${art.name} is open in Autora 3D (${out.shapes ?? 0} shape${out.shapes === 1 ? "" : "s"}).` } : { ok: false, error: out.error };
    }
    case "game": {
      // A game that was kept replaces the game; any other file (JSON that is not a game too) is added to the game's resources.
      if (/\.json$/i.test(art.name) || art.mime === "application/json") {
        const kept = loadGame(session, data);
        if (kept.ok) return { ok: true, said: `${art.name} is open in Autora Games.` };
      }
      const out = await runGameTool(session, "game_import", { file: art.id }, quiet);
      return out.ok ? { ok: true, said: `${art.name} was added to the game's resources.` } : { ok: false, error: out.summary };
    }
  }
}

/**
 * POST /api/sessions/:session/load -- { app, artifact } puts that file in the app's window beside this chat.
 *
 * Refused where there is no window to open: an incognito chat has none, and an app switched off on the Tools page is
 * not opened from here either.
 */
export function loadFileRoutes(app: Express, opts: {
  exists: (id: string) => boolean;
  incognito: (id: string) => boolean;
  /** Switched off on the Tools page (or not built into this server). */
  off: (app: LoadApp) => boolean;
}): void {
  app.post("/api/sessions/:session/load", async (req: Request, res: Response) => {
    const session = String(req.params.session);
    if (!opts.exists(session)) return res.status(404).json({ error: "There is no such chat." });
    const which = String((req.body ?? {}).app ?? "") as LoadApp;
    if (!LOAD_APPS.includes(which)) return res.status(400).json({ error: "That is not an app that loads files." });
    const art = getArtifact(String((req.body ?? {}).artifact ?? ""));
    if (!art) return res.status(404).json({ error: "That file is no longer in Artifacts." });
    if (opts.incognito(session)) return res.status(403).json({ error: `An incognito chat has no window, so ${NAME[which]} cannot be opened in it.` });
    if (opts.off(which)) return res.status(403).json({ error: `${NAME[which]} is switched off on the Tools page.` });
    if (!loadable(which, art)) return res.status(400).json({ error: `${NAME[which]} cannot open ${art.name}.` });
    try {
      const out = await load(session, which, art);
      if (!out.ok) return res.status(400).json({ error: out.error ?? `${NAME[which]} could not open ${art.name}.` });
      return res.json({ ok: true, name: art.name, said: out.said });
    } catch (err) {
      return res.status(503).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
