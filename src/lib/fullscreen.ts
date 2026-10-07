import { useSyncExternalStore } from "react";

/**
 * Whether a tool is full screen on a phone. One flag for all of them (the
 * browser, the app window, the PDF, the three office apps, a widget) rather
 * than one per window, so that when "follow" moves the stage from one tool to
 * the next, the next opens full screen too instead of dropping the person
 * back to the thread. Each pinned window reads it; the thread draws the
 * messaging-lite layer over whichever one is up (components/ImmersiveChat.tsx).
 */
let on = false;
const listeners = new Set<() => void>();

export function setFullscreen(next: boolean) {
  if (on === next) return;
  on = next;
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => { listeners.delete(l); };
};

export function useFullscreen(): [boolean, (next: boolean) => void] {
  return [useSyncExternalStore(subscribe, () => on, () => false), setFullscreen];
}
