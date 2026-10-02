/**
 * A document as pictures of its pages, for a phone (and anywhere a full editor is
 * the wrong tool): the same pages the editor lays out and prints (./officerender.ts),
 * drawn once and kept, with where each piece of text sits so a tap can tell which
 * words it landed on.
 *
 * Kept by what the file holds, not by when it changed: the same bytes are the
 * same pages, so going back to an earlier version, or looking again at a file the
 * agent has not touched, costs nothing. Only the last couple per session are kept.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { renderToPdf, type OfficeKind } from "./officerender";
import { withPdf } from "./pdfrender";
import { stateDir } from "./state";

const DIR = path.join(stateDir(), "officepages");
const KEEP = 2;
/** A long document is shown to this page; the editor has the rest. */
export const MAX_PAGES = 60;
/** Wide enough to read on a phone held upright with the page zoomed to twice its width. */
const PAGE_PX = 1100;
const validSession = (id: string) => /^[A-Za-z0-9_-]{1,80}$/.test(id);

export type PageMeta = { w: number; h: number };
export type Manifest = { hash: string; kind: OfficeKind; pages: PageMeta[]; total: number };
export type PageWords = { s: string; box: [number, number, number, number] }[];

type Job = { hash: string; promise: Promise<void>; error: string | null; done: boolean };
const jobs = new Map<string, Job>();

export const hashOf = (kind: OfficeKind, data: Buffer) => createHash("sha1").update(kind).update("\0").update(data).digest("hex").slice(0, 20);

const dirOf = (session: string, hash: string) => path.join(DIR, session, hash);

function readManifest(session: string, hash: string): Manifest | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dirOf(session, hash), "meta.json"), "utf8")) as Manifest;
  } catch {
    return null;
  }
}

/** The pages of this document if they are drawn; otherwise start drawing them. */
export function pagesFor(session: string, kind: OfficeKind, name: string, data: Buffer): { status: "ready"; manifest: Manifest } | { status: "working"; hash: string } | { status: "failed"; hash: string; error: string } {
  if (!validSession(session)) return { status: "failed", hash: "", error: "No such session." };
  const hash = hashOf(kind, data);
  const have = readManifest(session, hash);
  if (have) return { status: "ready", manifest: have };
  const job = jobs.get(`${session}/${hash}`);
  if (job?.error) return { status: "failed", hash, error: job.error };
  if (!job) start(session, hash, kind, name, data);
  return { status: "working", hash };
}

/** The newest drawn pages for a session, whatever the file holds now: shown (as out of date) while the new ones are drawn. */
export function latestPages(session: string): Manifest | null {
  if (!validSession(session)) return null;
  try {
    const dirs = fs.readdirSync(path.join(DIR, session), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => ({ d, at: fs.statSync(path.join(DIR, session, d.name, "meta.json")).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    return dirs.length ? readManifest(session, dirs[0].d.name) : null;
  } catch {
    return null;
  }
}

function start(session: string, hash: string, kind: OfficeKind, name: string, data: Buffer) {
  const key = `${session}/${hash}`;
  const job: Job = { hash, error: null, done: false, promise: Promise.resolve() };
  job.promise = (async () => {
    const pdf = await renderToPdf(kind, data, name);
    const out = dirOf(session, hash);
    const tmp = `${out}.part`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
    const metas: PageMeta[] = [];
    let total = 0;
    await withPdf(pdf, undefined, async (view) => {
      total = view.pages;
      const n = Math.min(view.pages, MAX_PAGES);
      const text = await view.text(1, n).catch(() => []);
      for (let i = 1; i <= n; i += 1) {
        const size = await view.size(i);
        const pic = await view.render(i, { scale: PAGE_PX / Math.max(1, size.width), type: "image/jpeg", quality: 0.82 });
        fs.writeFileSync(path.join(tmp, `${i}.jpg`), pic.data, { mode: 0o600 });
        const words: PageWords = (text.find((t) => t.page === i)?.items ?? [])
          .filter((t) => t.box && t.s.trim())
          // The reader's boxes are x, y, width, height from the page's top-left; a tap is tested against corners.
          .map((t) => { const [x, y, w, h] = t.box as number[]; return { s: t.s, box: [x, y, x + w, y + h] as [number, number, number, number] }; });
        fs.writeFileSync(path.join(tmp, `${i}.json`), JSON.stringify(words), { mode: 0o600 });
        metas.push({ w: size.width, h: size.height });
      }
    });
    fs.writeFileSync(path.join(tmp, "meta.json"), JSON.stringify({ hash, kind, pages: metas, total } satisfies Manifest), { mode: 0o600 });
    fs.rmSync(out, { recursive: true, force: true });
    fs.renameSync(tmp, out);
    prune(session);
  })().then(
    () => { job.done = true; jobs.delete(key); },
    (err: any) => {
      job.error = String(err?.message ?? err).split("\n")[0];
      job.done = true;
      // A failure is remembered a short while, so a phone asking every second does not start it again each time.
      setTimeout(() => jobs.delete(key), 20_000).unref?.();
    },
  );
  jobs.set(key, job);
}

function prune(session: string) {
  try {
    const dirs = fs.readdirSync(path.join(DIR, session), { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.endsWith(".part"))
      .map((d) => ({ name: d.name, at: fs.statSync(path.join(DIR, session, d.name)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    for (const old of dirs.slice(KEEP)) fs.rmSync(path.join(DIR, session, old.name), { recursive: true, force: true });
  } catch {
    // Nothing to tidy.
  }
}

export function dropPages(session: string) {
  if (!validSession(session)) return;
  fs.rmSync(path.join(DIR, session), { recursive: true, force: true });
}

/** One drawn page (picture) or its words, or null. */
export function pageFile(session: string, hash: string, n: number, what: "jpg" | "json"): Buffer | null {
  if (!validSession(session) || !/^[0-9a-f]{20}$/.test(hash) || !Number.isInteger(n) || n < 1 || n > MAX_PAGES) return null;
  try {
    return fs.readFileSync(path.join(dirOf(session, hash), `${n}.${what}`));
  } catch {
    return null;
  }
}
