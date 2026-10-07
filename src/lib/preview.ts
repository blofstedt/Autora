import { useSyncExternalStore } from "react";

/**
 * The app window's state on this page: whether a preview is open, its
 * comments, and the newest frame of it. Kept outside React state for the same
 * reason as the browser's frames (lib/liveFrame.ts): they arrive a dozen times
 * a second and only the window showing them should redraw.
 */

export type Rect = { x: number; y: number; w: number; h: number };
export type Device = "phone" | "tablet" | "desktop";
export type PathStep = { tag: string; id: string; classes: string[]; selector: string };

/** What the server read off the page about one element (server/pick.ts). */
export type ElementInfo = {
  selector: string;
  tag: string;
  id: string;
  classes: string[];
  text: string;
  fullText: string;
  editableText: boolean;
  attrs: Record<string, string>;
  rect: Rect;
  styles: Record<string, string>;
  html: string;
  path: PathStep[];
  children: number;
  source: string | null;
  component: string | null;
  visible: boolean;
};

/** The hover's version: a box and a name. */
export type LightInfo = { selector: string; tag: string; rect: Rect; label: string };

export type StyleChange = { property: string; from: string; to: string };

export type ReviewComment = {
  id: string;
  kind: "element" | "region";
  text: string;
  elements: ElementInfo[];
  region?: Rect;
  textEdit?: { from: string; to: string };
  styleChanges: StyleChange[];
  blob: string | null;
  scroll: { x: number; y: number };
  viewport: { width: number; height: number };
  ts: number;
};

export type PreviewState = {
  open: boolean;
  url?: string | null;
  title?: string | null;
  device?: Device;
  viewport?: { width: number; height: number };
  since?: number;
  how?: "url" | "folder" | "command" | null;
  comments: ReviewComment[];
  /** Errors in the page's console, and the newest few of them. */
  errors?: number;
  consoleErrors?: string[];
  /** The dev server the window was started with has exited. */
  serverDown?: { exit: number | null; last: string } | null;
  /** Where the page's typeable fields are, in page pixels. */
  fields?: Array<[number, number, number, number]>;
};

type PreviewFrame = { data: string; mime: string; w: number; h: number; ts: number };

const CLOSED: PreviewState = { open: false, comments: [] };
let state: PreviewState = CLOSED;
let frame: PreviewFrame | null = null;
const stateListeners = new Set<() => void>();
const frameListeners = new Set<() => void>();

export function setPreviewState(next: PreviewState | null | undefined) {
  const value = next && typeof next === "object" ? { ...next, comments: Array.isArray(next.comments) ? next.comments : [] } : CLOSED;
  state = value;
  if (!value.open) frame = null;
  for (const l of stateListeners) l();
  if (!value.open) for (const l of frameListeners) l();
}

export function setPreviewFrame(next: PreviewFrame | null) {
  frame = next;
  for (const l of frameListeners) l();
}

export function resetPreview() {
  state = CLOSED;
  frame = null;
  for (const l of stateListeners) l();
  for (const l of frameListeners) l();
}

const sub = (set: Set<() => void>) => (l: () => void) => { set.add(l); return () => { set.delete(l); }; };
const subState = sub(stateListeners);
const subFrame = sub(frameListeners);

export function usePreviewState(): PreviewState {
  return useSyncExternalStore(subState, () => state, () => CLOSED);
}

export function usePreviewFrame(): PreviewFrame | null {
  return useSyncExternalStore(subFrame, () => frame, () => null);
}
