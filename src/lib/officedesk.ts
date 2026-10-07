import { useSyncExternalStore } from "react";

/**
 * The Office windows' state on this page (server/officedesk.ts): the Autora Pages, Slides and Sheets documents open
 * beside the conversation -- one window and one tab each, all of them at once -- and which version of each. A Pages
 * document is fetched by its window when `loadRev` changes; the others are reached by the window's frame reloading.
 */
type WordVersion = { n: number; label: string; at: number; by: "agent" | "person"; name: string };

export type OfficeKind = "docx" | "pptx" | "xlsx";

/** What each app is called, on its tab and in the editor: a window says which app it is, never the file's name. */
export const APP_NAME: Record<OfficeKind, string> = { docx: "Pages", pptx: "Slides", xlsx: "Sheets" };

/** One thing the agent did in the document, played as a cursor that goes there and types it (server/officedesk.ts). */
export type OfficeCue = { act: "type" | "point"; text: string; cell?: string; sheet?: string; box?: [number, number, number, number] };

type OfficeWindowState = {
  open: boolean;
  kind: OfficeKind;
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

type OfficeState = { open: boolean; windows: OfficeWindowState[] };

const NONE: OfficeState = { open: false, windows: [] };
let state: OfficeState = NONE;
const listeners = new Set<() => void>();

export function setOfficeState(next: unknown) {
  const said = next as Partial<OfficeState> | null;
  state = said && typeof said === "object" && Array.isArray(said.windows)
    ? { open: said.windows.length > 0, windows: said.windows as OfficeWindowState[] }
    : NONE;
  for (const l of listeners) l();
}

export function resetOffice() {
  setOfficeState(null);
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** Every window open beside the conversation, oldest first. */
export function useOfficeState(): OfficeState {
  return useSyncExternalStore(subscribe, () => state, () => NONE);
}

/** The window for one app -- what a page that shows Autora Pages, Slides or Sheets reads -- or null when it is shut. */
export function useOfficeWindow(kind: OfficeKind): OfficeWindowState | null {
  const all = useOfficeState();
  return all.windows.find((w) => w.kind === kind) ?? null;
}

/** What a PowerPoint or Excel engine sent its editor page (webContents.send), for the window to pass on. */
type OfficePush = { rev: number; channel: string; args: unknown };
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
