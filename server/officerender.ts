/**
 * A Word document, laid out the way Word's editor lays it out, as a PDF.
 *
 * GenOffice's Word editor (built into dist/office/web/docs by
 * scripts/build-office.mjs) is a web page. Here it is opened in the server's
 * Chromium with the same stand-in for Electron that the window uses
 * (office/shim), told to export, and its own pagination and print code run:
 * what comes out is the PDF its File menu would have written, the pages the
 * person would see in the window. Pictures of pages (office_look) and the PDF
 * the PDF editor opens (office_pdf) both come from here, so they cannot
 * disagree with the editor.
 *
 * The page is served to the browser from memory over a made-up address, and
 * everything else is refused: a document cannot reach out from the renderer.
 */

import fs from "node:fs";
import path from "node:path";
import { PDFDocument } from "@cantoo/pdf-lib";
import type { Route } from "playwright-core";
import { officeDir } from "./office";
import { PdfRenderError, withBrowserContext, type Stopper } from "./pdfrender";

const ORIGIN = "https://office.autora.invalid";
/** Opening the document, laying it out and printing it, at most. */
const EXPORT_MS = 120_000;
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".otf": "font/otf", ".png": "image/png", ".svg": "image/svg+xml",
};

export class OfficeRenderError extends PdfRenderError {}

/** Where the built windows are, or null when this server has none. */
export function webDir(): string | null {
  const dir = officeDir();
  return dir && fs.existsSync(path.join(dir, "web")) ? path.join(dir, "web") : null;
}

/** Whether the editor for this kind of document was built. */
export function editorBuilt(app: "docs"): boolean {
  const web = webDir();
  return Boolean(web && fs.existsSync(path.join(web, app, "index.html")));
}

/** A file inside the built windows, by the name the page asks for it by; never outside them. */
function assetPath(name: string): string | null {
  const web = webDir();
  if (!web) return null;
  const full = path.resolve(web, name);
  if (!full.startsWith(web + path.sep)) return null;
  return fs.existsSync(full) && fs.statSync(full).isFile() ? full : null;
}

/** One at a time: an editor page is heavy, and the browser is shared with everything else. */
let queue: Promise<unknown> = Promise.resolve();

/**
 * The document as the PDF the editor writes. Rejects with the editor's own
 * reason when it cannot open the file (damaged, or password-protected).
 */
export function renderDocxToPdf(data: Buffer, name: string, stopper: Stopper = {}): Promise<Buffer> {
  const run = queue.then(() => render(data, name, stopper));
  queue = run.catch(() => undefined);
  return run;
}

async function render(data: Buffer, name: string, stopper: Stopper): Promise<Buffer> {
  if (!editorBuilt("docs")) throw new OfficeRenderError("The Word editor is not built on this server (node scripts/build-office.mjs), so pages cannot be drawn.");
  return await withBrowserContext(async (context, stop) => {
    let pdf: Buffer | null = null;
    let verdict: { ok: boolean; error?: string } | null = null;

    await context.route("**/*", (route: Route) => {
      let url: URL;
      try { url = new URL(route.request().url()); } catch { return route.abort("blockedbyclient"); }
      if (url.origin !== ORIGIN) return route.abort("blockedbyclient");
      const file = assetPath(url.pathname.replace(/^\//, ""));
      if (!file) return route.fulfill({ status: 404, body: "" });
      return route.fulfill({ contentType: TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream", body: fs.readFileSync(file) });
    });

    const page = await context.newPage();
    page.on("pageerror", () => undefined);

    const pdfOptions = (a: { w?: number; h?: number; scale?: number }) => {
      const w = Number(a.w), h = Number(a.h);
      if (!Number.isFinite(w) || !Number.isFinite(h) || w < 720 || h < 720) throw new Error("the page size is not one");
      const scale = Number.isFinite(Number(a.scale)) && Number(a.scale) > 0 ? Math.min(2, Math.max(0.1, Number(a.scale))) : undefined;
      return {
        printBackground: true, width: `${w / 1440}in`, height: `${h / 1440}in`,
        margin: { top: "0", bottom: "0", left: "0", right: "0" }, ...(scale ? { scale } : {}),
      };
    };

    await page.exposeFunction("__autoraHost", async (op: string, payload: any) => {
      switch (op) {
        case "asset": {
          const file = assetPath(String(payload?.name ?? ""));
          if (!file) throw new Error(`no such file: ${payload?.name}`);
          return { bytes64: fs.readFileSync(file).toString("base64") };
        }
        case "open": return { bytes64: data.toString("base64"), name };
        case "pdf": pdf = await page.pdf(pdfOptions(payload ?? {})); return { ok: true };
        case "pdf-part": return { base64: (await page.pdf(pdfOptions(payload ?? {}))).toString("base64") };
        case "pdf-merge": {
          const out = await PDFDocument.create();
          for (const part of Array.isArray(payload?.parts) ? payload.parts : []) {
            const one = await PDFDocument.load(Buffer.from(String(part), "base64"));
            for (const p of await out.copyPages(one, one.getPageIndices())) out.addPage(p);
          }
          pdf = Buffer.from(await out.save());
          return { ok: true };
        }
        case "done": verdict = { ok: payload?.ok === true, error: typeof payload?.error === "string" ? payload.error : undefined }; return null;
        default: return null;
      }
    });
    await page.addInitScript(() => {
      (globalThis as any).__autoraHeadless = { outPath: "/autora/out.pdf", format: "pdf" };
    });

    const timer = setTimeout(stop, EXPORT_MS);
    try {
      await page.goto(`${ORIGIN}/docs/index.html`);
      await page.waitForFunction(() => Boolean((globalThis as any).__autoraDone), undefined, { timeout: EXPORT_MS });
    } catch (err) {
      if (stopper.cancelled?.()) throw new PdfRenderError("Stopped.", "cancelled");
      throw new OfficeRenderError(`The Word editor did not finish laying the document out (${String((err as Error)?.message ?? err).split("\n")[0]}).`);
    } finally {
      clearTimeout(timer);
    }
    const done = verdict as { ok: boolean; error?: string } | null;
    if (!done?.ok) throw new OfficeRenderError(`The Word editor could not export it: ${done?.error ?? "no reason given"}.`);
    if (!pdf) throw new OfficeRenderError("The Word editor finished without writing a PDF.");
    return pdf;
  }, stopper);
}
