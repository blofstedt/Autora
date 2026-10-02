import { useSyncExternalStore } from "react";
import { inField } from "./pageInput";
import type { LiveFrame } from "./types";

/**
 * The newest frame off the session's browser, kept outside React state.
 *
 * Frames arrive ten times a second. Held in the app's state, every one of
 * them re-rendered the whole app -- the thread, its markdown, the memory
 * graph -- and on a phone that left no time to handle the keys you were
 * typing into the page. Here only the card showing the page listens.
 */
let current: LiveFrame | null = null;
const listeners = new Set<() => void>();

export function setLiveFrame(frame: LiveFrame | null) {
  if (frame === current) return;
  current = frame;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The live frame, or null for a card the feed does not belong to. A card
    that is not following never re-renders when a frame lands. */
export function useLiveFrame(following: boolean): LiveFrame | null {
  return useSyncExternalStore(subscribe, () => (following ? current : null));
}

/** The browser's tabs, kept the same way: they change with the page. */
export type LiveTab = { id: number; url: string; title: string; active: boolean };
let tabs: LiveTab[] = [];
const tabListeners = new Set<() => void>();

export function setLiveTabs(next: LiveTab[] | undefined) {
  const value = next ?? [];
  if (JSON.stringify(value) === JSON.stringify(tabs)) return;
  tabs = value;
  for (const listener of tabListeners) listener();
}

export function useLiveTabs(on: boolean): LiveTab[] {
  return useSyncExternalStore(
    (listener) => { tabListeners.add(listener); return () => { tabListeners.delete(listener); }; },
    () => (on ? tabs : NO_TABS),
  );
}
const NO_TABS: LiveTab[] = [];

/**
 * Where the open page's typeable fields are, in page pixels. Read at the
 * moment of a tap rather than rendered from, so it lives here too.
 */
let fields: Array<[number, number, number, number]> = [];

export function setLiveFields(next: Array<[number, number, number, number]> | undefined) {
  fields = next ?? [];
}

/** Whether a point on the page lands in a field, with a little slack for a
    fingertip. */
export function onField(x: number, y: number, slack = 6): boolean {
  return inField(fields, x, y, slack);
}
