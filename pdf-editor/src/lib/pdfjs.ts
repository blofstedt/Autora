/**
 * pdf.js, wired up to run inside Autora's PDF window.
 *
 * The editor runs in a sandboxed frame with no origin of its own, where a
 * worker cannot be started from a URL (it would count as another site) and a
 * module worker cannot be started at all. So pdf.js's worker is bundled into
 * the editor as a classic script (vite.config.ts builds workers as IIFE) and
 * started from a blob, which belongs to the frame.
 *
 * The character maps and standard fonts pdf.js needs for some files are
 * copied next to the editor at build time, but the editor does not fetch
 * them itself: a request from a frame without an origin carries no cookies,
 * and behind a login proxy (Umbrel's) it is turned away. The page around the
 * frame fetches them and posts the bytes in (components/PdfWindow.tsx).
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

type DataKind = "cMapUrl" | "standardFontDataUrl";

const DIRS: Record<DataKind, string> = { cMapUrl: "cmaps", standardFontDataUrl: "standard_fonts" };
const waiting = new Map<number, { resolve: (b: Uint8Array) => void; reject: (e: Error) => void }>();
let asked = 0;

window.addEventListener("message", (e) => {
  if (e.source !== window.parent) return;
  const msg = e.data;
  if (!msg || typeof msg !== "object" || msg.type !== "autora:pdfjs-data") return;
  const w = waiting.get(msg.id);
  if (!w) return;
  waiting.delete(msg.id);
  if (msg.bytes instanceof ArrayBuffer) w.resolve(new Uint8Array(msg.bytes));
  else w.reject(new Error(String(msg.error || "not found")));
});

/** pdf.js's data, asked of the page around the frame; fetched directly when opened on its own. */
class RelayedData {
  constructor(_opts: unknown) {}
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const dir = DIRS[kind as DataKind];
    if (!dir) throw new Error(`Not implemented: ${kind}`);
    if (window.parent === window) {
      const res = await fetch(new URL(`./pdfjs/${dir}/${filename}`, document.baseURI));
      if (!res.ok) throw new Error(`Unable to load ${dir}/${filename}`);
      return new Uint8Array(await res.arrayBuffer());
    }
    const id = ++asked;
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      window.parent.postMessage({ type: "autora:pdfjs-data", id, dir, filename }, "*");
    });
  }
}

export const PDFJS_DATA = {
  // pdf.js only checks these are set; RelayedData knows where the files are.
  cMapUrl: "pdfjs/cmaps/",
  standardFontDataUrl: "pdfjs/standard_fonts/",
  BinaryDataFactory: RelayedData,
};
