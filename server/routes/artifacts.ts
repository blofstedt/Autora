/**
 * The artifacts routes: what the agent made and what you uploaded, kept on disk
 * -- listing them, opening one, its thumbnail and preview, and deleting it.
 *
 * These were part of server.ts, which held every route in the app alongside the
 * turn loop and the WebSocket stream. Nothing changed in the move: the work was
 * already in server/artifacts.ts, server/thumbs.ts and server/notebooks.ts, and
 * this is only the HTTP in front of it.
 */

import { type Express, type Request, type RequestHandler, type Response } from "express";
import {
  MAX_ARTIFACT_BYTES, deleteArtifact, getArtifact, listArtifacts, readArtifact, saveArtifact,
} from "../artifacts";
import { forgetThumb, previewOf, thumbOf } from "../thumbs";
import { forgetArtifact } from "../notebooks";

export function artifactRoutes(app: Express, deps: {
  /** Accept a file body of any type, up to MAX_ARTIFACT_BYTES. */
  rawBody: RequestHandler;
  /** Record a line in the Logs page. */
  log: (level: "debug" | "info" | "warn" | "error", topic: string, line: string) => void;
}) {
  const { log } = deps;
  app.get("/api/artifacts", (_req: Request, res: Response) => {
    res.json({ artifacts: listArtifacts(), max: MAX_ARTIFACT_BYTES });
  });

  /** The body is the file itself, sent as octet-stream so the JSON parser
      above leaves it alone; its name and type ride in headers, so there is no
      multipart parser to add for the one form that needs one. */
  app.post(
    "/api/artifacts",
    deps.rawBody,
    (req: Request, res: Response) => {
      const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (data.byteLength === 0) return res.status(400).json({ error: "The file is empty." });
      let name = "upload";
      try {
        name = decodeURIComponent(String(req.headers["x-file-name"] || "upload"));
      } catch {
        // A malformed name is not worth refusing the file over.
      }
      try {
        const artifact = saveArtifact({
          origin: "user", name, data, mime: String(req.headers["x-file-type"] || ""),
        });
        log("info", "artifacts", `uploaded ${artifact.name} (${artifact.size} bytes)`);
        res.json({ artifact });
      } catch (err: any) {
        res.status(400).json({ error: err?.message ?? "Could not save the file." });
      }
    },
  );

  app.get("/api/artifacts/:id", (req: Request, res: Response) => {
    const meta = getArtifact(req.params.id);
    const data = meta ? readArtifact(meta.id) : null;
    if (!meta || !data) return res.status(404).json({ error: "No such artifact" });
    const download = req.query.download !== undefined;
    // Uploaded HTML or SVG opened inline would run with this app's origin;
    // only pictures and PDFs are shown in place, everything else downloads.
    const inline = !download && (
      (meta.mime.startsWith("image/") && meta.mime !== "image/svg+xml") ||
      meta.mime === "application/pdf" || meta.mime === "text/plain" ||
      meta.mime.startsWith("audio/") || meta.mime.startsWith("video/"));
    res.setHeader("Content-Type", inline ? meta.mime : "application/octet-stream");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "sandbox");
    res.setHeader(
      "Content-Disposition",
      `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
    );
    res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    res.setHeader("Content-Length", String(data.byteLength));
    res.end(data);
  });

  /** The small picture of a file the page shows on its card. Drawn once and
      kept, so it is immutable like the artifact is. */
  app.get("/api/artifacts/:id/thumb", async (req: Request, res: Response) => {
    const meta = getArtifact(req.params.id);
    if (!meta) return res.status(404).json({ error: "No such artifact" });
    let file: string | null = null;
    try {
      file = await thumbOf(meta);
    } catch {
      file = null;
    }
    if (!file) {
      // Not cached: this kind may become drawable (a renderer can come back).
      res.setHeader("Cache-Control", "no-store");
      return res.status(404).json({ error: "There is no picture of this file." });
    }
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.sendFile(file, (err?: Error) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  });

  /** The first lines of a document that has no picture to draw, for the
      card to show as text instead of a grey tile. */
  app.get("/api/artifacts/:id/preview", (req: Request, res: Response) => {
    const meta = getArtifact(req.params.id);
    if (!meta) return res.status(404).json({ error: "No such artifact" });
    const preview = previewOf(meta);
    if (!preview) {
      res.setHeader("Cache-Control", "no-store");
      return res.status(404).json({ error: "There is nothing to read out of this file." });
    }
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.json(preview);
  });

  app.delete("/api/artifacts/:id", (req: Request, res: Response) => {
    if (!deleteArtifact(req.params.id)) return res.status(404).json({ error: "No such artifact" });
    forgetArtifact(req.params.id);
    forgetThumb(req.params.id);
    res.json({ ok: true });
  });
}
