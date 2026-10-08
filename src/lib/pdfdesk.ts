import { useSyncExternalStore } from "react";

/**
 * The PDF window's state on this page (server/pdfdesk.ts): whether a PDF is
 * open beside the conversation, and the objects on it. The pages themselves
 * are fetched by the window when `baseRev` changes.
 */
type DeskObject = { id: string; type: string; pageNumber: number; [key: string]: unknown };

/** One change by the agent, waiting for the person to accept or decline it. */
type DeskMark = { id: string; kind: "add" | "edit" | "remove" | "page"; itemId?: string; page: number; label: string };

/** Where the agent just worked on a page, to be played in the window. */
export type DeskCue = {
  page: number; x: number; y: number; w: number; h: number; from: string; to: string;
  act?: "retype" | "type" | "place" | "drag" | "draw";
  tool?: string;
  points?: { x: number; y: number }[];
  /** The page's size in points, which is what lets a place on the page be found on the screen. */
  pw?: number; ph?: number;
};

/** An earlier state of the file. */
type DeskVersion = { n: number; label: string; at: number; by: "agent" | "person"; name: string };

type DeskState = {
  open: boolean;
  name?: string;
  /** The artifact the flattened file is in, once there is one. */
  working?: string | null;
  baseRev?: number;
  rev?: number;
  items?: DeskObject[];
  since?: number;
  problem?: string | null;
  marks?: DeskMark[];
  versions?: DeskVersion[];
  /** The agent's last edits, and a number that goes up when there are new ones to play. */
  cues?: DeskCue[];
  cueSeq?: number;
};

const CLOSED: DeskState = { open: false };
let state: DeskState = CLOSED;
const listeners = new Set<() => void>();

export function setDeskState(next: unknown) {
  state = next && typeof next === "object" && (next as DeskState).open !== undefined ? (next as DeskState) : CLOSED;
  for (const l of listeners) l();
}

export function resetDesk() {
  setDeskState(null);
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export function useDeskState(): DeskState {
  return useSyncExternalStore(subscribe, () => state, () => CLOSED);
}
