/**
 * Small pictures of the files in the workspace, for the Artifacts page.
 *
 * The page used to show the same grey "PDF" tile for every document, which
 * says nothing at all when there are fifty of them. Drawing page one costs a
 * browser, so each picture is drawn once and kept on disk beside the artifact,
 * where a reload can send it straight back. Office files have no picture to
 * draw; instead the first few lines of what they actually say are read out of
 * them for the page to show as text.
 *
 * Nothing here throws at the caller: a file that cannot be drawn answers null
 * and the page falls back to a plain tile. Whatever is wrong with the renderer
 * (no Chromium, no pdf.js) is asked for once and remembered for a while, so a
 * page of a hundred files does not ask a hundred times.
 */
import fs from "node:fs";
import path from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { readArtifact, type Artifact } from "./artifacts";
import { rendererMissing, withBrowserContext, withPdf } from "./pdfrender";
import { stateDir } from "./state";

const DIR = path.join(stateDir(), "thumbs");
/** The card's own box: 4:3, and what every picture is drawn at. */
const W = 480;
const H = 360;
/** Nothing bigger than this is copied into a browser to be drawn. */
const MAX_SOURCE = 16 * 1024 * 1024;
/** How long a "there is no renderer" answer is believed before asking again. */
const RENDERER_TTL = 60_000;
/** How many drawings may run at once; a page of files asks for many. */
const PARALLEL = 2;

/** id -> the file it draws to, or null when it cannot be drawn. */
const drawn = new Map<string, string | null>();
/** id -> the drawing in flight, so two cards for one file draw it once. */
const going = new Map<string, Promise<string | null>>();
/** The last answer to "is there anything here that can draw?". */
let probe: { at: number; why: string | null } | null = null;
let running = 0;
const waiting: (() => void)[] = [];

const fileFor = (id: string) => path.join(DIR, `${id.replace(/[^\w.-]/g, "_")}.jpg`);

/** A file that has been deleted takes its picture with it. */
export function forgetThumb(id: string) {
  drawn.delete(id);
  try {
    fs.unlinkSync(fileFor(id));
  } catch {
    // Nothing drawn yet is the common case.
  }
}

async function slot<T>(run: () => Promise<T>): Promise<T> {
  while (running >= PARALLEL) await new Promise<void>((ok) => waiting.push(ok));
  running++;
  try {
    return await run();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

async function whyNotDrawn(): Promise<string | null> {
  if (probe && Date.now() - probe.at < RENDERER_TTL) return probe.why;
  const why = await rendererMissing().catch((err: unknown) => String(err));
  probe = { at: Date.now(), why };
  return why;
}

/** The picture for an artifact, drawn now if it has not been drawn already.
    Answers with the file on disk, or null when this kind has no picture. */
export function thumbOf(a: Artifact): Promise<string | null> {
  const ready = drawn.get(a.id);
  if (ready !== undefined) return Promise.resolve(ready);
  const flight = going.get(a.id);
  if (flight) return flight;
  const run = slot(() => draw(a)).finally(() => going.delete(a.id));
  going.set(a.id, run);
  return run;
}

async function draw(a: Artifact): Promise<string | null> {
  const file = fileFor(a.id);
  if (fs.existsSync(file) && fs.statSync(file).size > 0) {
    drawn.set(a.id, file);
    return file;
  }
  const picture =
    a.mime.startsWith("image/") ? "picture"
      : a.mime === "application/pdf" ? "pdf"
        : null;
  if (!picture || a.size > MAX_SOURCE) {
    drawn.set(a.id, null);
    return null;
  }
  if (await whyNotDrawn()) {
    // Not remembered as un-drawable: the renderer may come back.
    return null;
  }
  const data = readArtifact(a.id);
  if (!data) {
    drawn.set(a.id, null);
    return null;
  }
  let shot: Buffer;
  try {
    shot = picture === "pdf" ? await drawPdf(data) : await drawPicture(data, a.mime);
  } catch {
    // One bad file, or a browser that died mid-page: the page shows a tile.
    return null;
  }
  if (!shot?.byteLength) return null;
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, shot);
  fs.renameSync(tmp, file);
  drawn.set(a.id, file);
  return file;
}

/** A picture, drawn to fill the card's box exactly (the interesting middle
    of a very tall image is better than its letterboxed whole). */
async function drawPicture(data: Buffer, mime: string): Promise<Buffer> {
  const url = `data:${mime};base64,${data.toString("base64")}`;
  return withBrowserContext(
    async (context) => {
      const page = await context.newPage();
      await page.setContent(
        `<body style="margin:0;background:#0b0b0d">`
        + `<img id="p" src="${url}" style="width:${W}px;height:${H}px;object-fit:cover;display:block">`
        + `</body>`,
      );
      // A string on purpose: this runs in the page, and the server half is
      // compiled without the DOM's types.
      await page
        .waitForFunction(
          `(() => { const i = document.getElementById("p");`
          + ` return !!i && i.complete && i.naturalWidth > 0; })()`,
          undefined,
          { timeout: 15_000 },
        )
        .catch(() => undefined);
      return page.screenshot({ type: "jpeg", quality: 74 });
    },
    {},
    { viewport: { width: W, height: H } },
  );
}

/** Page one, from its top down to the card's own 4:3 shape: for a document
    that is the title and the first lines, which is what tells files apart. */
async function drawPdf(data: Buffer): Promise<Buffer> {
  return withPdf(data, undefined, async (view) => {
    if (!view.pages) throw new Error("The PDF has no pages to draw.");
    const { width, height } = await view.size(1);
    const band = Math.max(1, Math.min(height, width * (H / W)));
    const scale = Math.max(0.3, Math.min(2.5, W / width));
    const shot = await view.render(1, {
      scale, type: "image/jpeg", quality: 72,
      crop: { x: 0, y: 0, w: width, h: band },
    });
    return shot.data;
  });
}

/* ---------------------------------------------------------------- text ---- */

export type Preview = { kind: string; lines: string[] };

/** A word for what a file is, for the badge on a card with no picture. */
export function kindOf(a: Artifact): string {
  const ext = a.name.includes(".") ? a.name.split(".").pop()!.toUpperCase() : "";
  if (ext && ext.length <= 5) return ext;
  return a.mime.split("/")[1]?.toUpperCase().slice(0, 5) || "FILE";
}

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

const isText = (mime: string) =>
  mime.startsWith("text/") || /^(application\/(json|xml|x-yaml|javascript)|image\/svg\+xml)/.test(mime);

/** The first few lines of what an office file or a text file says, or null
    when there is no reading it without the app that wrote it. */
export function previewOf(a: Artifact): Preview | null {
  if (a.size > MAX_SOURCE) return null;
  if (a.mime === DOCX || a.mime === PPTX) {
    const data = readArtifact(a.id);
    if (!data) return null;
    const lines = a.mime === DOCX ? docxLines(data) : pptxLines(data);
    return lines.length ? { kind: kindOf(a), lines } : null;
  }
  if (!isText(a.mime)) return null;
  const data = readArtifact(a.id);
  if (!data) return null;
  const lines = linesOf(data.subarray(0, 24_000).toString("utf8"));
  return lines.length ? { kind: kindOf(a), lines } : null;
}

/** Whole lines out of a text file, with the markup a page would not show. */
function linesOf(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line
      .replace(/^[\s>*#-]+/, "")
      .replace(/[*_`]/g, "")
      .replace(/\s+/g, " ")
      .trim())
    .filter((line) => line.length > 1)
    .slice(0, 6)
    .map((line) => (line.length > 120 ? `${line.slice(0, 119)}…` : line));
}

const entities = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");

/** Paragraphs out of a .docx, from the XML inside it. */
function docxLines(data: Buffer): string[] {
  const xml = entry(data, "word/document.xml");
  if (!xml) return [];
  return textOf(xml.replace(/<\/w:p>/g, "\n"), /<[^>]+>/g);
}

/** The first slide's text out of a .pptx: its title, usually. */
function pptxLines(data: Buffer): string[] {
  const xml = entry(data, "ppt/slides/slide1.xml");
  if (!xml) return [];
  return textOf(xml.replace(/<\/a:p>/g, "\n"), /<[^>]+>/g);
}

function entry(data: Buffer, name: string): string | null {
  try {
    const files = unzipSync(new Uint8Array(data));
    const found = files[name];
    return found ? strFromU8(found) : null;
  } catch {
    return null;
  }
}

function textOf(xml: string, tags: RegExp): string[] {
  return entities(xml.replace(tags, " "))
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 1)
    .slice(0, 6)
    .map((line) => (line.length > 120 ? `${line.slice(0, 119)}…` : line));
}
