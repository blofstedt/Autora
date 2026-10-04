/**
 * A blank file, opened in its window -- the person's own way in.
 *
 * The agent starts a document by asking for one; this is how the person starts
 * one themselves, from the toolbox beside the message box. Tapping a tool there
 * makes a real, empty file and puts it in the window beside the conversation:
 * no message, no turn, and nothing asked of the model. The file is saved as an
 * artifact the moment it opens, so what they type has somewhere to go, it is
 * theirs to keep, and the agent finds it in the chat when they next say
 * something.
 *
 * The files come from the same engines the tools use -- GenOffice's command
 * line for a document, a workbook or a deck (./office.ts), and the PDF library
 * for a blank page -- so a file opened here is the same kind of file the agent
 * would have made, and one blank of each kind is kept once made.
 */
import { PDFDocument } from "@cantoo/pdf-lib";
import type { Express, Request, Response } from "express";
import { listArtifacts, saveArtifact } from "./artifacts";
import { blankOffice } from "./office";
import { deskHooks } from "./pdfdesk";
import { officeHooks } from "./officedesk";

/** What the toolbox can open a window on, by itself. */
export type NewKind = "pdf" | "docx" | "xlsx" | "pptx";

export const NEW_KINDS: NewKind[] = ["pdf", "docx", "xlsx", "pptx"];
export const isNewKind = (v: unknown): v is NewKind => typeof v === "string" && (NEW_KINDS as string[]).includes(v);

/** What each kind of file is called, as an app -- the names the tools use. */
export const APP_OF: Record<NewKind, string> = {
  pdf: "Autora PDF", docx: "Autora Pages", xlsx: "Autora Sheets", pptx: "Autora Slides",
};

const EXT: Record<NewKind, string> = { pdf: "pdf", docx: "docx", xlsx: "xlsx", pptx: "pptx" };
const MIME: Record<NewKind, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** A4 in points, which is what the PDF tools and the window both work in. */
export const A4: [number, number] = [595.28, 841.89];

/** A blank A4 page, made once and copied out each time it is asked for. */
let page: Buffer | null = null;
export async function blankPdf(): Promise<Buffer> {
  if (!page) {
    const doc = await PDFDocument.create();
    doc.addPage(A4);
    page = Buffer.from(await doc.save());
  }
  return Buffer.from(page);
}

/** A blank file of this kind, from the engine that knows what blank means. */
export async function blankBytes(kind: NewKind): Promise<Buffer> {
  return kind === "pdf" ? await blankPdf() : await blankOffice(kind);
}

/** A name of its own: "Untitled.docx", then "Untitled 2.docx" and so on. */
export function freeName(kind: NewKind, names: readonly string[] = listArtifacts().map((a) => a.name)): string {
  const used = new Set(names.map((n) => n.trim().toLowerCase()));
  for (let n = 1; n <= 200; n++) {
    const name = `Untitled${n === 1 ? "" : ` ${n}`}.${EXT[kind]}`;
    if (!used.has(name.toLowerCase())) return name;
  }
  return `Untitled ${Date.now()}.${EXT[kind]}`;
}

export type Opened = { name: string; id: string; kind: NewKind; window: "pdf" | "word" };

/**
 * Make the blank file, save it, and put it in the window beside the chat.
 *
 * One window is shown at a time (the app's own rule: the last one opened takes
 * the place), so opening a new file while another is open replaces what is
 * showing -- the person's typing in it is already in its file, the window saves
 * as they go, and its artifact keeps it.
 */
export async function openNewFile(session: string, kind: NewKind): Promise<Opened> {
  const win = kind === "pdf" ? null : officeHooks(session);
  // Whatever was just typed in an open document has reached its file before another opens over it.
  if (win) await win.settle();
  const name = freeName(kind);
  const data = await blankBytes(kind);
  const art = saveArtifact({
    origin: "agent",
    name,
    data,
    mime: MIME[kind],
    session,
    note: `A new blank ${kind} file, opened from the toolbox`,
  });
  if (kind === "pdf") {
    deskHooks(session).open({ name, base: data, items: [], working: art.id, source: null, outName: name });
    return { name, id: art.id, kind, window: "pdf" };
  }
  // A label of the person's own, so the window's history says where this file came from.
  win!.open({ name, data, working: art.id, source: null, outName: name, label: "Started by you" });
  return { name, id: art.id, kind, window: "word" };
}

/**
 * POST /api/sessions/:session/new -- { kind } opens a blank file of that kind
 * in this chat's window, and answers with what it is called.
 *
 * Refused where there is no window to open: an incognito chat has none, and a
 * window switched off on the Tools page is not opened from here either.
 */
export function newFileRoutes(app: Express, opts: {
  exists: (id: string) => boolean;
  incognito: (id: string) => boolean;
  /** Switched off on the Tools page (or, for the Office kinds, not installed). */
  off: (kind: NewKind) => boolean;
}): void {
  app.post("/api/sessions/:session/new", async (req: Request, res: Response) => {
    const session = String(req.params.session);
    if (!opts.exists(session)) return res.status(404).json({ error: "There is no such chat." });
    const kind = String((req.body ?? {}).kind ?? "").trim().toLowerCase();
    if (!isNewKind(kind)) return res.status(400).json({ error: "A new file is a pdf, docx, xlsx or pptx." });
    if (opts.incognito(session)) {
      return res.status(403).json({ error: `An incognito chat has no window, so ${APP_OF[kind]} cannot be opened in it.` });
    }
    if (opts.off(kind)) {
      return res.status(403).json({ error: `${APP_OF[kind]} is switched off on the Tools page, so its window is not opened here.` });
    }
    try {
      return res.json({ ok: true, ...(await openNewFile(session, kind)) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return res.status(503).json({ error: message || `A new ${APP_OF[kind]} file could not be made on this server.` });
    }
  });
}
