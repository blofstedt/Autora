/**
 * pdf.js, wired up to run inside Autora's PDF window.
 *
 * The editor runs in a sandboxed frame with no origin of its own, where a
 * worker cannot be started from a URL (it would count as another site) and a
 * module worker cannot be started at all. So pdf.js's worker is bundled into
 * the editor as a classic script (vite.config.ts builds workers as IIFE) and
 * started from a blob, which belongs to the frame. The character maps and
 * standard fonts pdf.js fetches for some files are copied next to the editor
 * at build time and fetched from there; the server lets the frame read them.
 */
import PdfWorker from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?worker&inline";

type PdfJs = {
  GlobalWorkerOptions: { workerPort: Worker | null };
  // pdf.js's typings say a port must be null; the code takes a Worker.
  PDFWorker: new (params: any) => { destroy(): void };
};

let port: Worker | null = null;

/** A worker shared by whatever opens a document without its own. */
export function setupPdfJs(lib: PdfJs) {
  if (!port) port = new PdfWorker();
  lib.GlobalWorkerOptions.workerPort = port;
}

/**
 * A worker of its own, for a document that is replaced as a whole when the
 * file changes: destroying a document that shares the worker tears the worker
 * down under the next one being opened ("the worker is being destroyed").
 */
export function ownWorker(lib: PdfJs) {
  const own = new PdfWorker();
  const worker = new lib.PDFWorker({ port: own });
  return {
    worker,
    close() {
      try { worker.destroy(); } catch {}
      own.terminate();
    },
  };
}

const here = (path: string) => new URL(path, document.baseURI).href;

export const PDFJS_DATA = {
  cMapUrl: here("./pdfjs/cmaps/"),
  standardFontDataUrl: here("./pdfjs/standard_fonts/"),
};
