import { useSyncExternalStore } from "react";

/**
 * The Office window's state on this page (server/officedesk.ts): whether a
 * Autora Pages, Slides or Sheets document is open beside the conversation, and
 * which version of it. A Pages document is fetched by the window when `loadRev`
 * changes; the others are reached by the window's frame reloading.
 */
export type WordVersion = { n: number; label: string; at: number; by: "agent" | "person"; name: string };

export type OfficeKind = "docx" | "pptx" | "xlsx";

/** One thing the agent did in the document, played as a cursor that goes there and types it (server/officedesk.ts). */
export type OfficeCue = { act: "type" | "point"; text: string; cell?: string; sheet?: string; box?: [number, number, number, number] };

export type WordState = {
  open: boolean;
  kind?: OfficeKind;
  name?: string;
  /** The artifact the document is kept in, once there is one. */
  working?: string | null;
  /** Goes up on every change by anyone. */
  rev?: number;
  /** Goes up when the agent changed the document: the window loads it again. */
  loadRev?: number;
  since?: number;
  problem?: string | null;
  versions?: WordVersion[];
  /** Where the agent just worked, to be played over the editor, once per `cueRev`. */
  cues?: OfficeCue[];
  cueRev?: number;
  /** Milliseconds since they were made: a page that opens the window much later has missed them. */
  cueAge?: number;
};

const CLOSED: WordState = { open: false };
let state: WordState = CLOSED;
const listeners = new Set<() => void>();

export function setWordState(next: unknown) {
  state = next && typeof next === "object" && (next as WordState).open !== undefined ? (next as WordState) : CLOSED;
  for (const l of listeners) l();
}

export function resetWord() {
  setWordState(null);
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export function useWordState(): WordState {
  return useSyncExternalStore(subscribe, () => state, () => CLOSED);
}

/** What a PowerPoint or Excel engine sent its editor page (webContents.send), for the window to pass on. */
export type OfficePush = { rev: number; channel: string; args: unknown };
const pushListeners = new Set<(m: OfficePush) => void>();

export function emitOfficePush(m: unknown) {
  const msg = m as Partial<OfficePush> | null;
  if (!msg || typeof msg.channel !== "string" || typeof msg.rev !== "number") return;
  for (const l of pushListeners) l(msg as OfficePush);
}

export function onOfficePush(fn: (m: OfficePush) => void): () => void {
  pushListeners.add(fn);
  return () => { pushListeners.delete(fn); };
}
