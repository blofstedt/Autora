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

/* The live browser is showing in its own window beside the chat. The thread's
   newest browser card then keeps the record and leaves the feed to that window,
   so the page is live in one place rather than two. */
let paneOwnsTheFeed = false;

export function setLivePaneOwns(on: boolean) {
  if (paneOwnsTheFeed === on) return;
  paneOwnsTheFeed = on;
  for (const listener of listeners) listener();
}

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
    that is not following never re-renders when a frame lands. When the browser
    has its own window, only that window takes the feed (owns = true): the
    thread's card would otherwise play the same page a second time. */
export function useLiveFrame(following: boolean, owns = false): LiveFrame | null {
  return useSyncExternalStore(subscribe, () => (following && (!paneOwnsTheFeed || owns) ? current : null));
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
