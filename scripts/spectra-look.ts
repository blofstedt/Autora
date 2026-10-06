/**
 * Look at the ported PDF editor on its own, without the app around it.
 *
 *   AUTORA_SPECTRA_HOME=$PWD/dist/spectra-engine npx tsx scripts/spectra-look.ts
 *
 * Then open http://127.0.0.1:8944/spectra-editor/index.html?session=look --
 * the session is a made-up one, and the document is the PDF named below. This
 * is the development page the editor's own transport falls back to (see
 * spectra-editor/src/autora/transport.ts): no parent window, so its commands
 * come straight to these routes and its events over the standalone socket.
 *
 * Useful when something about the editor is wrong and the question is whether
 * it is the editor or the window that holds it: this is the editor with no
 * window at all. It logs every command and the answer to it.
 *
 * Not part of the app, and not built into it.
 */
import express from "express";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spectraRoutes, spectraUpgrade, serveSpectra } from "../server/spectra";

const PORT = Number(process.env.LOOK_PORT ?? 8944);
const SESSION = "look";
/** The document to open: any PDF on this machine. */
const PDF = process.env.LOOK_PDF ?? "/tmp/spectra-look/doc.pdf";
const WORK = process.env.LOOK_WORK ?? "/tmp/spectra-look/work";

const opts = {
  exists: (s: string) => s === SESSION,
  cwd: () => WORK,
  version: () => "look",
  document: async () => ({ name: path.basename(PDF), bytes: fs.readFileSync(PDF) }),
  saved: (session: string, file: string) => console.log("saved", session, file),
  push: (session: string, event: string, payload: unknown) =>
    console.log("push", session, event, JSON.stringify(payload).slice(0, 120)),
};

const app = express();
const raw = express.raw({ type: () => true, limit: 1024 * 1024 * 1024 });
app.use("/api/spectra/invoke", raw, (req, _res, next) => {
  const text = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
  try {
    const payload = JSON.parse(text);
    console.log("call", payload?.command, JSON.stringify(payload?.args ?? {}).slice(0, 120));
  } catch {
    // No body: the preflight.
  }
  next();
});
app.use("/api/spectra/invoke", (req, res, next) => {
  const json = res.json.bind(res);
  res.json = (body: unknown) => {
    if (req.method !== "OPTIONS") console.log("  back", res.statusCode, JSON.stringify(body).slice(0, 160));
    return json(body);
  };
  next();
});
spectraRoutes(app, opts as never);
serveSpectra(app, path.join(process.cwd(), "dist"));

const server = http.createServer(app);
server.on("upgrade", (req, socket, head) => {
  if (!spectraUpgrade(req, socket, head)) socket.destroy();
});
server.listen(PORT, "127.0.0.1", () =>
  console.log(`look on http://127.0.0.1:${PORT}/spectra-editor/index.html?session=${SESSION}`));
