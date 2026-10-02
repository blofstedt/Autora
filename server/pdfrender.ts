/**
 * PDF pages as they look: pdf.js, run in a headless Chromium of its own.
 *
 * Everything that needs a PDF's pixels or where its words sit -- pictures of
 * pages, text with positions, the redrawn pages behind a redaction or a
 * compression, a typed signature in a handwriting font -- is done here, by
 * the same pdf.js a browser's own viewer uses, so a page is drawn the way the
 * person would see it (XFA forms included, which most viewers only say
 * "please wait" to). Editing the file itself is ./pdf.ts, with pdf-lib.
 *
 * pdf.js runs in the browser rather than in Node on purpose: its Node build
 * wants a native canvas package, and the image this ships in carries no
 * native code. The page it runs in is served from a made-up origin by
 * Playwright's router -- pdf.js, its fonts and character maps, and the one
 * document -- and every other request is refused, so a PDF can reach
 * nothing. This is not the browser in ./browser.ts: that one holds the
 * person's sign-ins, and a document has no business near them. It starts on
 * first use and closes itself when it has been idle for a minute.
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { Browser, BrowserContext, Page, Route } from "playwright-core";
import { probeBrowser, systemBrowser } from "./browser";

const ORIGIN = "https://pdf.autora.invalid";
const IDLE_CLOSE_MS = 60_000;
/** Opening a document or drawing one page, at most. A PDF that takes longer
    is one pdf.js has got stuck in, and waiting longer will not help. */
const STEP_MS = 90_000;

/** Where a text item sits: x, y, width, height in points from the page's
    top-left corner, as the page is shown. */
export type Box = [number, number, number, number];
/**
 * `dir`: which way the run reads on the page as shown -- right, down, left or
 * up -- or null when it is slanted. `o`, when asked for: where each character
 * boundary falls along the run, 0 to 1, measured from the glyphs' widths.
 */
export type TextItem = { s: string; eol: boolean; box: Box | null; dir: "r" | "d" | "l" | "u" | null; o?: number[] };
export type PageText = { page: number; width: number; height: number; items: TextItem[] };
export type Rect = { x: number; y: number; w: number; h: number };
export type Picture = { data: Buffer; mime: string; width: number; height: number };

export class PdfRenderError extends Error {
  constructor(message: string, readonly code: "password-needed" | "password-wrong" | "no-browser" | "broken" | "cancelled" = "broken") {
    super(message);
  }
}

// -------------------------------------------------------------- assets --

let pdfjsRoot: string | null | undefined;

/** node_modules/pdfjs-dist beside the app, found the same way in development
    (ESM) and in the container (a CJS bundle). */
function pdfjsDir(): string | null {
  if (pdfjsRoot !== undefined) return pdfjsRoot;
  try {
    const require = createRequire(path.join(process.cwd(), "package.json"));
    pdfjsRoot = path.dirname(require.resolve("pdfjs-dist/package.json"));
  } catch {
    pdfjsRoot = null;
  }
  return pdfjsRoot;
}

/** The handwriting font for typed signatures: in dist/ once built, public/ before. */
function fontFile(name: string): string | null {
  for (const dir of [path.join(process.cwd(), "dist", "fonts"), path.join(process.cwd(), "public", "fonts")]) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/* The legacy build: the modern one leans on JavaScript newer than the
   Chromium a distribution ships (Map.prototype.getOrInsertComputed, missing
   from Chromium 141), and fails to draw a single page there. */
const FOLDERS: Record<string, string> = {
  "/build/": "legacy/build",
  "/cmaps/": "cmaps",
  "/standard_fonts/": "standard_fonts",
  "/wasm/": "wasm",
  "/iccs/": "iccs",
};

const TYPES: Record<string, string> = {
  ".mjs": "text/javascript", ".js": "text/javascript", ".css": "text/css",
  ".wasm": "application/wasm", ".woff2": "font/woff2",
};

/** The file behind a path on the made-up origin, or null. One name inside a
    known folder and nothing else, so no path reaches outside pdf.js. */
function assetFor(pathname: string): string | null {
  // Great Vibes, for typed signatures. SIL OFL 1.1 (via Fontsource).
  if (pathname === "/sig.woff2") return fontFile("great-vibes-latin.woff2");
  if (pathname === "/sig-ext.woff2") return fontFile("great-vibes-latin-ext.woff2");
  const root = pdfjsDir();
  if (!root) return null;
  if (pathname === "/viewer.css") return path.join(root, "web", "pdf_viewer.css");
  for (const [prefix, folder] of Object.entries(FOLDERS)) {
    if (!pathname.startsWith(prefix)) continue;
    const name = pathname.slice(prefix.length);
    if (!/^[\w-][\w.-]*$/.test(name)) return null;
    const file = path.join(root, folder, name);
    return fs.existsSync(file) ? file : null;
  }
  return null;
}

const cache = new Map<string, Buffer>();

function readAsset(file: string): Buffer {
  let data = cache.get(file);
  if (!data) {
    data = fs.readFileSync(file);
    cache.set(file, data);
  }
  return data;
}

// ----------------------------------------------------------- the page --

/** The script the page runs, as text: the server is not typed against the DOM. */
const SCRIPT = `
import * as pdfjs from "/build/pdf.min.mjs";
pdfjs.GlobalWorkerOptions.workerSrc = "/build/pdf.worker.min.mjs";
const OPTIONS = {
  cMapUrl: "/cmaps/", cMapPacked: true, standardFontDataUrl: "/standard_fonts/",
  wasmUrl: "/wasm/", iccUrl: "/iccs/", isEvalSupported: false, enableXfa: true,
  disableRange: true, disableStream: true, disableAutoFetch: true, verbosity: 0,
  // Fetched by this page, which the server answers, rather than by the worker.
  useWorkerFetch: false,
};
const LINKS = {
  externalLinkTarget: 0, externalLinkRel: "noopener noreferrer", externalLinkEnabled: false,
  addLinkAttributes() {}, getDestinationHash() { return "#"; }, getAnchorUrl() { return "#"; },
  navigateTo() {}, goToDestination() {}, executeNamedAction() {}, executeSetOCGState() {},
};
let doc = null;
const r1 = (v) => Math.round(v * 10) / 10;

/* Where a run of text sits on the page as shown: its baseline, run along
   its direction for its width, from a little under the baseline to the top
   of its capitals, turned into the page's own view. */
function boxOf(item, vp) {
  if (!item.transform || !item.str) return { box: null, dir: null };
  const [a, b, c, d, e, f] = item.transform;
  const size = Math.hypot(c, d) || item.height || 0;
  if (!size) return { box: null, dir: null };
  const run = Math.hypot(a, b) || 1;
  const ux = a / run, uy = b / run, nx = -uy, ny = ux;
  const w = item.width || 0, up = size * 0.9, down = size * 0.25;
  const pts = [
    [e - nx * down, f - ny * down], [e + ux * w - nx * down, f + uy * w - ny * down],
    [e + nx * up, f + ny * up], [e + ux * w + nx * up, f + uy * w + ny * up],
  ].map(([x, y]) => vp.convertToViewportPoint(x, y));
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs), y0 = Math.min(...ys);
  const [sx, sy] = vp.convertToViewportPoint(e, f);
  const [ex, ey] = vp.convertToViewportPoint(e + ux * w, f + uy * w);
  const dx = ex - sx, dy = ey - sy, len = Math.hypot(dx, dy);
  const dir = len < 0.01 ? null
    : Math.abs(dy) <= 0.02 * len ? (dx > 0 ? "r" : "l")
    : Math.abs(dx) <= 0.02 * len ? (dy > 0 ? "d" : "u")
    : null;
  return { box: [r1(x0), r1(y0), r1(Math.max(...xs) - x0), r1(Math.max(...ys) - y0)], dir };
}

/* Character boundaries along a run, 0 to 1, from the widths of its glyphs in
   the kind of font pdf.js lays its own text layer out with. */
const ruler = document.createElement("canvas").getContext("2d");
const glyphs = new Map();
function offsets(str, family) {
  ruler.font = "100px " + (family || "sans-serif");
  const widths = [];
  for (const ch of str) {
    const key = ruler.font + "|" + ch;
    let w = glyphs.get(key);
    if (w === undefined) { w = ruler.measureText(ch).width; glyphs.set(key, w); }
    widths.push(w);
    if (ch.length === 2) widths.push(0);
  }
  const total = widths.reduce((s, w) => s + w, 0) || 1;
  const out = [0];
  let at = 0;
  for (const w of widths) { at += w; out.push(Math.round((at / total) * 1000) / 1000); }
  return out;
}

/* Black boxes, then the grid, over what was drawn: in points from the
   page's top-left, scaled to the picture, shifted by the crop. */
function overlay(ctx, o, crop, page) {
  const s = o.scale;
  ctx.save();
  ctx.translate(-crop.x * s, -crop.y * s);
  ctx.fillStyle = "#000";
  for (const b of o.boxes || []) ctx.fillRect(b.x * s, b.y * s, b.w * s, b.h * s);
  if (o.grid) {
    const step = o.grid;
    const line = (x0, y0, x1, y1, major) => {
      ctx.strokeStyle = major ? "rgba(37, 99, 235, 0.5)" : "rgba(37, 99, 235, 0.22)";
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    };
    for (let x = 0; x <= page.width + 0.01; x += step) line(Math.round(x * s) + 0.5, 0, Math.round(x * s) + 0.5, page.height * s, Math.round(x / step) % 2 === 0);
    for (let y = 0; y <= page.height + 0.01; y += step) line(0, Math.round(y * s) + 0.5, page.width * s, Math.round(y * s) + 0.5, Math.round(y / step) % 2 === 0);
    const px = Math.round(Math.max(10, Math.min(15, 11 * Math.sqrt(s))));
    ctx.font = px + "px sans-serif";
    ctx.textBaseline = "top";
    const label = (text, x, y) => {
      const w = ctx.measureText(text).width + 4;
      ctx.fillStyle = "rgba(255, 255, 255, 0.85)"; ctx.fillRect(x, y, w, px + 3);
      ctx.fillStyle = "#1d4ed8"; ctx.fillText(text, x + 2, y + 2);
    };
    const top = crop.y * s + 2, left = crop.x * s + 2;
    for (let x = 0; x <= page.width + 0.01; x += step * 2) {
      if (x >= crop.x && x < crop.x + crop.w) label(String(Math.round(x)), x * s + 2, top);
    }
    for (let y = step * 2; y <= page.height + 0.01; y += step * 2) {
      if (y >= crop.y && y < crop.y + crop.h) label(String(Math.round(y)), left, y * s + 2);
    }
  }
  ctx.restore();
}

window.pdfApi = {
  async open(password) {
    try {
      doc = await pdfjs.getDocument({ url: "/doc.pdf", password: password || undefined, ...OPTIONS }).promise;
    } catch (e) {
      if (e && e.name === "PasswordException") return { error: e.code === 2 ? "password-wrong" : "password-needed" };
      return { error: String((e && e.message) || e) };
    }
    return { pages: doc.numPages, xfa: !!doc.isPureXfa };
  },
  async text(from, to, measure) {
    const out = [];
    for (let n = from; n <= to; n++) {
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items = [];
      for (const item of content.items) {
        if (typeof item.str !== "string") continue;
        const placed = boxOf(item, vp);
        const entry = { s: item.str, eol: !!item.hasEOL, ...placed };
        if (measure && placed.dir && item.str.length > 1) {
          entry.o = offsets(item.str, content.styles[item.fontName]?.fontFamily);
        }
        items.push(entry);
      }
      out.push({ page: n, width: r1(vp.width), height: r1(vp.height), items });
      page.cleanup();
    }
    return out;
  },
  async size(n) {
    const vp = (await doc.getPage(n)).getViewport({ scale: 1 });
    return { width: vp.width, height: vp.height };
  },
  async render(n, o) {
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const crop = o.crop || { x: 0, y: 0, w: base.width, h: base.height };
    if (doc.isPureXfa) return this.xfa(page, base, crop, o);
    const vp = page.getViewport({ scale: o.scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(crop.w * o.scale));
    canvas.height = Math.max(1, Math.round(crop.h * o.scale));
    await page.render({
      canvas, viewport: vp, background: "#ffffff",
      transform: [1, 0, 0, 1, -crop.x * o.scale, -crop.y * o.scale],
      annotationMode: pdfjs.AnnotationMode.ENABLE_STORAGE,
    }).promise;
    overlay(canvas.getContext("2d"), o, crop, base);
    page.cleanup();
    return { data: canvas.toDataURL(o.type, o.quality), width: canvas.width, height: canvas.height };
  },
  /* An XFA page is HTML, not a drawing: it is laid out in the page, and the
     server takes a screenshot of it. */
  async xfa(page, base, crop, o) {
    const host = document.getElementById("xfa");
    host.replaceChildren();
    const vp = page.getViewport({ scale: o.scale });
    host.style.width = Math.ceil(vp.width) + "px";
    host.style.height = Math.ceil(vp.height) + "px";
    const layer = document.createElement("div");
    host.append(layer);
    pdfjs.XfaLayer.render({
      viewport: vp.clone({ dontFlip: true }), div: layer, xfaHtml: await page.getXfa(),
      annotationStorage: doc.annotationStorage, linkService: LINKS, intent: "print",
    });
    const cover = document.createElement("canvas");
    cover.width = Math.ceil(vp.width); cover.height = Math.ceil(vp.height);
    cover.style.cssText = "position:absolute;left:0;top:0;pointer-events:none";
    overlay(cover.getContext("2d"), o, { x: 0, y: 0, w: base.width, h: base.height }, base);
    host.append(cover);
    await document.fonts.ready;
    return {
      xfa: true,
      clip: { x: crop.x * o.scale, y: crop.y * o.scale, width: crop.w * o.scale, height: crop.h * o.scale },
      page: { width: Math.ceil(vp.width), height: Math.ceil(vp.height) },
    };
  },
  async signature(text, px, color) {
    const font = px + "px Sig, SigExt, cursive";
    await document.fonts.load(font, text);
    const canvas = document.createElement("canvas");
    let ctx = canvas.getContext("2d");
    ctx.font = font;
    const m = ctx.measureText(text);
    const pad = Math.ceil(px * 0.1);
    const left = Math.ceil(m.actualBoundingBoxLeft), right = Math.ceil(m.actualBoundingBoxRight);
    const up = Math.ceil(m.actualBoundingBoxAscent), down = Math.ceil(m.actualBoundingBoxDescent);
    canvas.width = Math.max(1, left + right + pad * 2);
    canvas.height = Math.max(1, up + down + pad * 2);
    ctx = canvas.getContext("2d");
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.fillText(text, pad + left, pad + up);
    return { data: canvas.toDataURL("image/png"), width: canvas.width, height: canvas.height };
  },
  async toPng(url) {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth || 1024; canvas.height = img.naturalHeight || 1024;
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    return { data: canvas.toDataURL("image/png"), width: canvas.width, height: canvas.height };
  },
};
window.ready = true;
`;

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/viewer.css">
<style>
@font-face { font-family: Sig; src: url(/sig.woff2) format("woff2"); }
@font-face { font-family: SigExt; src: url(/sig-ext.woff2) format("woff2"); }
html, body { margin: 0; background: #fff; }
#xfa { position: relative; overflow: hidden; background: #fff; }
/* As printed: without the tint a viewer puts behind fields to fill. */
#xfa .xfaTextfield, #xfa .xfaSelect { background-image: none !important; }
</style></head><body><div id="xfa"></div><script type="module">${SCRIPT}</script></body></html>`;

// ------------------------------------------------------------ browser --

let browser: Promise<Browser> | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let busy = 0;

async function launch(): Promise<Browser> {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  browser ??= (async () => {
    const { chromium } = await import("playwright-core");
    const executablePath = systemBrowser();
    const launched = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
    launched.on("disconnected", () => { browser = null; });
    return launched;
  })().catch((err) => {
    browser = null;
    throw err;
  });
  return browser;
}

function release() {
  if (busy > 0) return;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    const closing = browser;
    browser = null;
    void closing?.then((b) => b.close()).catch(() => undefined);
  }, IDLE_CLOSE_MS);
  idleTimer.unref?.();
}

/**
 * A fresh, isolated browser context in the same Chromium, for the other things
 * on this server that need a page drawn (the Office editors, server/officerender.ts).
 * Shares the browser's launch and its idle close with the PDF renderer.
 */
export async function withBrowserContext<T>(
  use: (context: BrowserContext, stop: () => void) => Promise<T>,
  stopper: Stopper = {},
  options: { viewport?: { width: number; height: number } } = {},
): Promise<T> {
  const probe = await probeBrowser();
  if (!probe.ok) throw new PdfRenderError(`There is no browser to draw it with: ${lowerFirst(probe.detail ?? "no Chromium on this server")}`, "no-browser");
  busy++;
  let context: BrowserContext | null = null;
  const stop = () => { void context?.close().catch(() => undefined); };
  try {
    const b = await launch();
    context = await b.newContext({
      viewport: options.viewport ?? { width: 1360, height: 900 }, deviceScaleFactor: 1,
      serviceWorkers: "block", acceptDownloads: false,
    });
    stopper.onCancel?.(stop);
    return await use(context, stop);
  } catch (err) {
    if (stopper.cancelled?.()) throw new PdfRenderError("Stopped.", "cancelled");
    throw err;
  } finally {
    stop();
    busy--;
    release();
  }
}

/** A step that gives up: pdf.js stuck on a hostile file must not hold a tool call for ever. */
async function within<T>(work: Promise<T>, what: string, stop: () => void): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      stop();
      reject(new PdfRenderError(`${what} took more than ${STEP_MS / 1000} s, so it was stopped.`));
    }, STEP_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Something a caller can stop: a turn that was interrupted. */
export type Stopper = { cancelled?: () => boolean; onCancel?: (stop: () => void) => void };

/** One document, open in the renderer. */
export class PdfView {
  constructor(
    private readonly page: Page,
    private readonly stop: () => void,
    private readonly stopper: Stopper,
    /** Pages in the document; 0 when no document was opened. */
    readonly pages: number,
    /** Drawn from XFA rather than from page content. */
    readonly xfa: boolean,
  ) {}

  private async step<T>(what: string, run: () => Promise<T>): Promise<T> {
    if (this.stopper.cancelled?.()) throw new PdfRenderError("Stopped.", "cancelled");
    try {
      return await within(run(), what, this.stop);
    } catch (err) {
      if (err instanceof PdfRenderError) throw err;
      if (this.stopper.cancelled?.()) throw new PdfRenderError("Stopped.", "cancelled");
      throw new PdfRenderError(`${what} failed: ${String((err as Error)?.message ?? err).split("\n")[0]}`);
    }
  }

  /** Every run of text on pages `from` to `to` (1-based), with where it
      sits; `measure` adds where each character falls, for boxing matches. */
  text(from: number, to: number, measure = false): Promise<PageText[]> {
    return this.step("Reading the text", () =>
      this.page.evaluate(([a, b, m]) => (globalThis as any).pdfApi.text(a, b, m), [from, to, measure] as const));
  }

  /** The page's size as shown, in points. */
  size(page: number): Promise<{ width: number; height: number }> {
    return this.step("Measuring a page", () =>
      this.page.evaluate((n) => (globalThis as any).pdfApi.size(n), page));
  }

  /**
   * One page as a picture. `crop` and `boxes` are in points from the page's
   * top-left; boxes are filled black, and `grid` rules the page every that
   * many points.
   */
  render(page: number, o: {
    scale: number; type?: "image/jpeg" | "image/png"; quality?: number;
    crop?: Rect; boxes?: Rect[]; grid?: number;
  }): Promise<Picture> {
    const type = o.type ?? "image/jpeg";
    const quality = o.quality ?? 0.85;
    return this.step(`Drawing page ${page}`, async () => {
      const out = await this.page.evaluate(([n, opts]) => (globalThis as any).pdfApi.render(n, opts),
        [page, { scale: o.scale, type, quality, crop: o.crop, boxes: o.boxes, grid: o.grid }] as const);
      if (out.xfa) {
        await this.page.setViewportSize({ width: Math.max(1, out.page.width), height: Math.max(1, out.page.height) });
        const clip = {
          x: Math.max(0, out.clip.x), y: Math.max(0, out.clip.y),
          width: Math.max(1, Math.round(out.clip.width)), height: Math.max(1, Math.round(out.clip.height)),
        };
        const shot = await this.page.screenshot(type === "image/png"
          ? { type: "png", clip }
          : { type: "jpeg", quality: Math.round(quality * 100), clip });
        return { data: shot, mime: type, width: clip.width, height: clip.height };
      }
      return { data: fromDataUrl(out.data), mime: type, width: out.width, height: out.height };
    });
  }

  /** A name written in a handwriting font, as a transparent PNG. */
  signature(text: string, px: number, color: string): Promise<Picture> {
    return this.step("Writing the signature", async () => {
      const out = await this.page.evaluate(([t, p, c]) => (globalThis as any).pdfApi.signature(t, p, c), [text, px, color] as const);
      return { data: fromDataUrl(out.data), mime: "image/png", width: out.width, height: out.height };
    });
  }

  /** Any picture a browser can open (WebP, GIF, SVG...), as PNG. */
  toPng(data: Buffer, mime: string): Promise<Picture> {
    return this.step("Converting the picture", async () => {
      const url = `data:${mime};base64,${data.toString("base64")}`;
      const out = await this.page.evaluate((u) => (globalThis as any).pdfApi.toPng(u), url);
      return { data: fromDataUrl(out.data), mime: "image/png", width: out.width, height: out.height };
    });
  }
}

function fromDataUrl(url: string): Buffer {
  return Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
}

/** Why there is no renderer here, or null when there is one. */
export async function rendererMissing(): Promise<string | null> {
  if (!pdfjsDir()) return "pdf.js (the pdfjs-dist package) is not installed beside the app.";
  const probe = await probeBrowser();
  return probe.ok ? null : (probe.detail ?? "There is no Chromium on this server.");
}

/**
 * Open `pdf` in the renderer, hand it to `use`, and close it again. With no
 * document (null), the page is still there for signatures and pictures.
 */
export async function withPdf<T>(
  pdf: Buffer | null,
  password: string | undefined,
  use: (view: PdfView) => Promise<T>,
  stopper: Stopper = {},
): Promise<T> {
  const missing = await rendererMissing();
  if (missing) throw new PdfRenderError(`Seeing a PDF's pages needs a browser, and ${lowerFirst(missing)}`, "no-browser");
  busy++;
  let context: BrowserContext | null = null;
  const stop = () => { void context?.close().catch(() => undefined); };
  try {
    let view: PdfView;
    try {
      const b = await launch();
      context = await b.newContext({
        viewport: { width: 800, height: 600 }, deviceScaleFactor: 1,
        serviceWorkers: "block", acceptDownloads: false,
      });
      await context.route("**/*", (route: Route) => serve(route, pdf));
      stopper.onCancel?.(stop);
      const page = await context.newPage();
      await within((async () => {
        await page.goto(`${ORIGIN}/`);
        await page.waitForFunction(() => (globalThis as any).ready === true);
      })(), "Starting the PDF renderer", stop);
      let pages = 0;
      let xfa = false;
      if (pdf) {
        const opened = await within(
          page.evaluate((pw) => (globalThis as any).pdfApi.open(pw), password ?? ""),
          "Opening the PDF", stop,
        ) as { pages?: number; xfa?: boolean; error?: string };
        if (opened.error === "password-needed") throw new PdfRenderError("It is password-protected: give its password.", "password-needed");
        if (opened.error === "password-wrong") throw new PdfRenderError("That password is not the right one for this PDF.", "password-wrong");
        if (opened.error) throw new PdfRenderError(`pdf.js could not open it: ${opened.error}`);
        pages = opened.pages ?? 0;
        xfa = Boolean(opened.xfa);
      }
      view = new PdfView(page, stop, stopper, pages, xfa);
    } catch (err) {
      if (stopper.cancelled?.()) throw new PdfRenderError("Stopped.", "cancelled");
      if (err instanceof PdfRenderError) throw err;
      throw new PdfRenderError(`The PDF renderer did not start: ${String((err as Error)?.message ?? err).split("\n")[0]}`);
    }
    return await use(view);
  } finally {
    stop();
    busy--;
    release();
  }
}

function serve(route: Route, pdf: Buffer | null) {
  let url: URL;
  try {
    url = new URL(route.request().url());
  } catch {
    return route.abort("blockedbyclient");
  }
  if (url.origin !== ORIGIN) return route.abort("blockedbyclient");
  if (url.pathname === "/") return route.fulfill({ contentType: "text/html; charset=utf-8", body: PAGE });
  if (url.pathname === "/doc.pdf" && pdf) return route.fulfill({ contentType: "application/pdf", body: pdf });
  const file = assetFor(url.pathname);
  if (!file) return route.fulfill({ status: 404, body: "" });
  const type = TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  try {
    return route.fulfill({ contentType: type, body: readAsset(file) });
  } catch {
    return route.fulfill({ status: 404, body: "" });
  }
}

function lowerFirst(text: string): string {
  return text ? text[0].toLowerCase() + text.slice(1) : text;
}
