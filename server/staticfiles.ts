/**
 * Static files, sent compressed and cached.
 *
 * `express.static` sends bytes as they are on disk and lets the browser
 * revalidate every one on every load: a 620 KB app script and a 245 KB
 * stylesheet cross the wire whole, each time. Here a page, script, style, font
 * or data file is compressed once (brotli, gzip as a fallback) and kept, and
 * anything Vite has named by its content (`assets/<name>-<hash>.js`) is told
 * it never changes. `index.html` and the other unhashed files are revalidated
 * with an ETag, so an update is seen at once.
 *
 * Files are read from `webDir` only; a path that leaves it falls through.
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import express, { type RequestHandler } from "express";

const SQUEEZE = /\.(html|js|mjs|css|ttf|otf|json|svg|wasm|map)$/i;
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
};
/** Under this, compressing costs more than it saves. */
const MIN_BYTES = 1024;
/** A name Vite made from the file's content: safe to cache for good. */
const HASHED = /(^|\/)assets\/[^/]+-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/;

const kept = new Map<string, { stamp: string; br: Buffer; gz: Buffer }>();

interface SqueezeOptions {
  /** The Cache-Control for files that are not content-hashed. */
  revalidate?: string;
}

/** Middleware: serve `webDir` compressed when the client accepts it, else fall
    through (to `express.static`, which this is meant to sit in front of). */
export function squeezed(webDir: string, opts: SqueezeOptions = {}): RequestHandler {
  const root = path.resolve(webDir);
  return (req, res, next) => {
    if ((req.method !== "GET" && req.method !== "HEAD") || !SQUEEZE.test(req.path)) return next();
    const accepts = String(req.headers["accept-encoding"] ?? "");
    const want = /\bbr\b/.test(accepts) ? "br" : /\bgzip\b/.test(accepts) ? "gz" : null;
    if (!want) return next();
    try {
      const rel = decodeURIComponent(req.path);
      const file = path.resolve(root, "." + path.posix.normalize("/" + rel));
      if (!file.startsWith(root + path.sep)) return next();
      const st = fs.statSync(file);
      if (!st.isFile() || st.size < MIN_BYTES) return next();
      const stamp = `${st.mtimeMs}-${st.size}`;
      let entry = kept.get(file);
      if (!entry || entry.stamp !== stamp) {
        const raw = fs.readFileSync(file);
        entry = {
          stamp,
          // Quality 5: most of the size for a fraction of the time, and it is done once.
          br: zlib.brotliCompressSync(raw, {
            params: {
              [zlib.constants.BROTLI_PARAM_QUALITY]: 5,
              [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
            },
          }),
          gz: zlib.gzipSync(raw, { level: 6 }),
        };
        kept.set(file, entry);
      }
      const etag = `"${stamp}-${want}"`;
      res.setHeader("Vary", "Accept-Encoding");
      res.setHeader("ETag", etag);
      res.setHeader(
        "Cache-Control",
        HASHED.test(rel.replace(/^\/+/, ""))
          ? "public, max-age=31536000, immutable"
          : opts.revalidate ?? "no-cache",
      );
      if (req.headers["if-none-match"] === etag) return void res.status(304).end();
      res.setHeader("Content-Type", TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream");
      res.setHeader("Content-Encoding", want === "br" ? "br" : "gzip");
      res.send(want === "br" ? entry.br : entry.gz);
    } catch {
      next();
    }
  };
}

/** `express.static` with the squeezing in front and long caching for hashed
    files behind it (for the clients that take no compression). */
export function staticDir(webDir: string, opts: SqueezeOptions & { fallthrough?: boolean } = {}): RequestHandler[] {
  return [
    squeezed(webDir, opts),
    express.static(webDir, {
      fallthrough: opts.fallthrough ?? true,
      setHeaders: (res, file) => {
        const rel = path.relative(path.resolve(webDir), file).split(path.sep).join("/");
        if (HASHED.test(rel)) res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      },
    }),
  ];
}
