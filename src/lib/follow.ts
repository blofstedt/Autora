import { useSyncExternalStore } from "react";

/**
 * Follow: the screen goes where the agent works, between tools, until the person turns it off. A standing order,
 * so it is on to begin with and is kept (per browser) once they say otherwise; the pill beside the tabs on a
 * desktop and the one on a phone are the same switch.
 */
const KEY = "autora.follow";
const listeners = new Set<() => void>();

const read = (): boolean => {
  try { return localStorage.getItem(KEY) !== "off"; } catch { return true; }
};
let on = read();

export function setFollowing(next: boolean) {
  if (next === on) return;
  on = next;
  try { localStorage.setItem(KEY, next ? "on" : "off"); } catch { /* the choice is just not remembered */ }
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export function useFollowing(): boolean {
  return useSyncExternalStore(subscribe, () => on, () => true);
}
