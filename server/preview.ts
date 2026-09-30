/**
 * The pieces of the app preview that need no browser: the device sizes, the
 * little static server for a site that is only files, and the two waits -- for
 * a port a dev server announced, and for it to start answering.
 *
 * A preview is the agent's own work shown back to the person while it is made,
 * so the two ways of making one are both here: a command (a dev server the
 * agent starts, which says which port it took) or a folder of files (served
 * from here, so a plain HTML site needs no tooling at all). Both end in a URL
 * on this machine, which the session's browser then opens.
 */

import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";

export type Device = "phone" | "tablet" | "desktop";

export const DEVICES: Record<Device, { width: number; height: number; label: string }> = {
  phone: { width: 390, height: 844, label: "Phone" },
  tablet: { width: 820, height: 1100, label: "Tablet" },
  desktop: { width: 1280, height: 800, label: "Desktop" },
};

export const DEVICE_LIST: Device[] = ["phone", "tablet", "desktop"];

export function isDevice(value: unknown): value is Device {
  return value === "phone" || value === "tablet" || value === "desktop";
}

/** The device a window size is nearest to, for telling the agent. */
export function deviceFor(width: number): Device {
  if (width <= 560) return "phone";
  if (width <= 1024) return "tablet";
  return "desktop";
}

/** Only this machine: a preview is the agent's scratch work, not a service. */
export function isLocalUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1" || host === "0.0.0.0" ||
      host.endsWith(".localhost");
  } catch {
    return false;
  }
}

/** The address a dev server printed, from whatever it said while starting.
    Vite, Next, webpack, CRA, Astro, http-server and Python all say it
    differently; all of them put a port after a host. */
export function addressIn(output: string): string | null {
  const plain = output.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
  const full = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})[^\s"')]*/i.exec(plain);
  if (full) return `http://localhost:${full[1]}/`;
  const bare = /(?:listening|running|started|serving|ready)[^\n]{0,60}?(?:port\s*|:)(\d{2,5})\b/i.exec(plain);
  /* "listening on http://192.168.1.4:3000" names a host, and not this one:
     that is a reason to ask for the port, not to guess it. */
  return bare && !/https?:\/\//i.test(bare[0]) ? `http://localhost:${bare[1]}/` : null;
}

/** Whether something answers HTTP at this address. Any status counts: a 404
    from the root is a server, which is all this asks. */
export function answers(url: string, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => { if (!settled) { settled = true; resolve(ok); } };
    try {
      const u = new URL(url);
      const req = http.request(
        { host: u.hostname === "localhost" ? "127.0.0.1" : u.hostname, port: Number(u.port || 80), path: "/", method: "GET", timeout: timeoutMs },
        (res) => { res.resume(); done(true); },
      );
      req.on("timeout", () => { req.destroy(); done(false); });
      req.on("error", () => done(false));
      req.end();
    } catch {
      done(false);
    }
  });
}

export async function waitForServer(url: string, ms: number, stopped: () => boolean = () => false): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end && !stopped()) {
    if (await answers(url)) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8", ".map": "application/json", ".wasm": "application/wasm", ".mp4": "video/mp4",
  ".webm": "video/webm", ".mp3": "audio/mpeg", ".xml": "application/xml",
};

export interface StaticServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

/**
 * A folder, served. Files as they are on disk at each request -- no caching,
 * so an edit shows on reload -- with a folder's index.html, and the root's
 * index.html for a path that is not a file (a single-page app's routes).
 * Nothing above the folder can be reached.
 */
export function serveFolder(dir: string): Promise<StaticServer> {
  const root = path.resolve(dir);
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const rel = decodeURIComponent(url.pathname);
      let file = path.resolve(root, `.${rel}`);
      if (file !== root && !file.startsWith(root + path.sep)) {
        res.writeHead(403).end("Outside the folder.");
        return;
      }
      let stat = fs.existsSync(file) ? fs.statSync(file) : null;
      if (stat?.isDirectory()) { file = path.join(file, "index.html"); stat = fs.existsSync(file) ? fs.statSync(file) : null; }
      if (!stat && !path.extname(rel)) { file = path.join(root, "index.html"); stat = fs.existsSync(file) ? fs.statSync(file) : null; }
      if (!stat || !stat.isFile()) { res.writeHead(404, { "content-type": "text/plain" }).end("Not found."); return; }
      res.writeHead(200, {
        "content-type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
        "cache-control": "no-store",
      });
      if (req.method === "HEAD") { res.end(); return; }
      fs.createReadStream(file).pipe(res);
    } catch {
      res.writeHead(400).end("Bad request.");
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({
        url: `http://localhost:${port}/`,
        port,
        close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()); }),
      });
    });
  });
}
