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
 * PowerPoint and Excel are drawn the same way, with one more piece: their
 * editors keep the document in an engine (GenOffice's main-process code, run by
 * server/officehost.ts), which the page reaches through the same host function
 * and which prints its own pages in a window of the same Chromium.
 *
 * The page is served to the browser from memory over a made-up address, and
 * everything else is refused: a document cannot reach out from the renderer.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PDFDocument } from "@cantoo/pdf-lib";
import type { Page, Route } from "playwright-core";
import { officeDir } from "./office";
import { OfficeHost, hostBuilt, wire, type HostApp, type HostWindows } from "./officehost";
import { PdfRenderError, withBrowserContext, type Stopper } from "./pdfrender";

export type OfficeApp = "docs" | "slides" | "sheets";

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
export function editorBuilt(app: OfficeApp): boolean {
  const web = webDir();
  if (!web || !fs.existsSync(path.join(web, app, "index.html"))) return false;
  return app === "docs" || hostBuilt(app);
}

/** The editor that draws each kind of document. */
export const APP_OF = { docx: "docs", pptx: "slides", xlsx: "sheets" } as const;
export type OfficeKind = keyof typeof APP_OF;

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
export function renderToPdf(kind: OfficeKind, data: Buffer, name: string, stopper: Stopper = {}): Promise<Buffer> {
  const run = queue.then(() => render(kind, data, name, stopper));
  queue = run.catch(() => undefined);
  return run;
}

export const renderDocxToPdf = (data: Buffer, name: string, stopper: Stopper = {}) => renderToPdf("docx", data, name, stopper);

const EDITOR_NAME = { docs: "Word", slides: "PowerPoint", sheets: "Excel" } as const;

async function render(kind: OfficeKind, data: Buffer, name: string, stopper: Stopper): Promise<Buffer> {
  const app = APP_OF[kind];
  if (!editorBuilt(app)) throw new OfficeRenderError(`The ${EDITOR_NAME[app]} editor is not built on this server (node scripts/build-office.mjs), so pages cannot be drawn.`);
  // The engines keep the document in a file of their own to open and write.
  const work = app === "docs" ? null : fs.mkdtempSync(path.join(os.tmpdir(), "autora-office-render-"));
  const input = work ? path.join(work, `in.${kind}`) : null;
  const output = work ? path.join(work, "out.pdf") : null;
  if (work && input) fs.writeFileSync(input, data);
  let host: OfficeHost | null = null;
  try {
    return await withBrowserContext(async (context, stop) => {
      let pdf: Buffer | null = null;
      let verdict: { ok: boolean; error?: string } | null = null;
      const tmp = fs.realpathSync(os.tmpdir());

      await context.route("**/*", (route: Route) => {
        let url: URL;
        try { url = new URL(route.request().url()); } catch { return route.abort("blockedbyclient"); }
        // The engines print through pages of their own, from files they wrote in a temporary folder.
        if (url.protocol === "file:") {
          let file = "";
          try { file = fs.realpathSync(decodeURIComponent(url.pathname)); } catch { return route.abort("blockedbyclient"); }
          if (!work || !file.startsWith(tmp + path.sep) || !fs.statSync(file).isFile()) return route.abort("blockedbyclient");
          return route.fulfill({ contentType: TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream", body: fs.readFileSync(file) });
        }
        if (url.protocol === "data:" || url.protocol === "blob:") return route.continue();
        if (url.origin !== ORIGIN) return route.abort("blockedbyclient");
        const file = assetPath(url.pathname.replace(/^\//, ""));
        if (!file) return route.fulfill({ status: 404, body: "" });
        return route.fulfill({ contentType: TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream", body: fs.readFileSync(file) });
      });

      const page = await context.newPage();
      if (process.env.AUTORA_OFFICE_DEBUG) {
        page.on("console", (m) => console.error("[page]", m.type(), m.text().slice(0, 300)));
        page.on("pageerror", (e) => console.error("[page error]", String(e).slice(0, 300)));
      } else page.on("pageerror", () => undefined);

      const pdfOptions = (a: { w?: number; h?: number; scale?: number }) => {
        const w = Number(a.w), h = Number(a.h);
        if (!Number.isFinite(w) || !Number.isFinite(h) || w < 720 || h < 720) throw new Error("the page size is not one");
        const scale = Number.isFinite(Number(a.scale)) && Number(a.scale) > 0 ? Math.min(2, Math.max(0.1, Number(a.scale))) : undefined;
        return {
          printBackground: true, width: `${w / 1440}in`, height: `${h / 1440}in`,
          margin: { top: "0", bottom: "0", left: "0", right: "0" }, ...(scale ? { scale } : {}),
        };
      };

      // The engine's own windows: pages in this same browser.
      const wins = new Map<number, Promise<Page>>();
      const windowOf = (id: number) => {
        let p = wins.get(id);
        if (!p) wins.set(id, (p = context.newPage()));
        return p;
      };
      const windows: HostWindows = {
        async rpc(op, p) {
          switch (op) {
            case "win.open": return null;
            case "win.load": {
              const w = await windowOf(p.win);
              if (process.env.AUTORA_OFFICE_DEBUG && p.file) fs.copyFileSync(String(p.file), "/tmp/claude-0/last-print.html");
              await w.goto(p.file ? pathToFileURL(String(p.file)).href : String(p.url), { waitUntil: "load" });
              return null;
            }
            case "win.eval": {
              const w = await windowOf(p.win);
              return (await w.evaluate((code) => (0, eval)(code), String(p.script))) ?? null;
            }
            case "win.pdf": {
              const w = await windowOf(p.win);
              const o = p.options ?? {};
              const size = o.pageSize && typeof o.pageSize === "object" ? o.pageSize : null;
              return await w.pdf({
                printBackground: o.printBackground !== false, margin: { top: "0", bottom: "0", left: "0", right: "0" },
                ...(size ? { width: `${Number(size.width)}in`, height: `${Number(size.height)}in` } : {}),
                preferCSSPageSize: Boolean(o.preferCSSPageSize),
              });
            }
            case "win.shot": return await (await windowOf(p.win)).screenshot({ type: "png" });
            case "win.close": {
              const w = wins.get(p.win);
              wins.delete(p.win);
              await (await w)?.close().catch(() => undefined);
              return null;
            }
            default: throw new Error(`unknown window request: ${op}`);
          }
        },
      };

      /** The id the engine knows this page by: any for a deck, the window it made for a workbook. */
      let wc = 1;
      let engineDone: Promise<unknown> | null = null;
      if (app !== "docs") {
        host = await OfficeHost.start(app as HostApp, windows, { AUTORA_OFFICE_HOME: path.join(work!, "state") });
        if (app === "sheets") {
          // A workbook is opened and exported by the engine, which makes the editor's window and queues the file in it.
          const made = host.expectPage();
          engineDone = host.invoke(0, "autora:headlessExport", [input, output]);
          engineDone.catch((err) => { verdict = { ok: false, error: String(err?.message ?? err) }; });
          wc = await made;
        }
        host.onPush((wc, channel, args) => {
          void page.evaluate(([c, a]) => (globalThis as any).__autoraPush("ipc", { channel: c, args: a }), [channel, wire.enc(args)] as const).catch(() => undefined);
        });
      }

      await page.exposeFunction("__autoraHost", async (op: string, payload: any) => {
        switch (op) {
          case "asset": {
            const file = assetPath(String(payload?.name ?? ""));
            if (!file) throw new Error(`no such file: ${payload?.name}`);
            return { bytes64: fs.readFileSync(file).toString("base64") };
          }
          case "open": return app === "docs" ? { bytes64: data.toString("base64"), name } : { path: input, name };
          case "ipc": {
            if (!host) throw new Error("no engine");
            if (process.env.AUTORA_OFFICE_DEBUG) console.error("[ipc]", payload?.channel);
            const value = await host.invoke(wc, String(payload?.channel), wire.dec(payload?.args ?? []));
            if (process.env.AUTORA_OFFICE_DEBUG && /export|read-range/.test(String(payload?.channel))) console.error("[ipc result]", JSON.stringify(value)?.slice(0, 900));
            return wire.enc(value);
          }
          case "ipc-send": host?.send(wc, String(payload?.channel), wire.dec(payload?.args ?? [])); return null;
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
      await page.addInitScript((out: string) => {
        (globalThis as any).__autoraHeadless = { outPath: out, format: "pdf" };
      }, output ?? "/autora/out.pdf");

      const label = EDITOR_NAME[app];
      const timer = setTimeout(stop, EXPORT_MS);
      try {
        await page.goto(`${ORIGIN}/${app}/index.html`);
        const pageDone = page.waitForFunction(() => Boolean((globalThis as any).__autoraDone), undefined, { timeout: EXPORT_MS });
        // An engine that made its own window (Excel) says when it is finished, or why it could not be.
        await Promise.race([pageDone, ...(engineDone ? [engineDone.then(() => pageDone, (e) => { throw e; })] : [])]);
      } catch (err) {
        if (stopper.cancelled?.()) throw new PdfRenderError("Stopped.", "cancelled");
        throw new OfficeRenderError(`The ${label} editor did not finish laying the document out (${String((err as Error)?.message ?? err).split("\n")[0]}).`);
      } finally {
        clearTimeout(timer);
      }
      const done = verdict as { ok: boolean; error?: string } | null;
      if (!done?.ok) throw new OfficeRenderError(`The ${label} editor could not export it: ${done?.error ?? "no reason given"}.`);
      // The engines write the file themselves.
      if (!pdf && output && fs.existsSync(output)) pdf = fs.readFileSync(output);
      if (!pdf) throw new OfficeRenderError(`The ${label} editor finished without writing a PDF.`);
      return pdf;
    }, stopper);
  } finally {
    (host as OfficeHost | null)?.stop();
    if (work) fs.rmSync(work, { recursive: true, force: true });
  }
}
