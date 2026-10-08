import { useSyncExternalStore } from "react";

/**
 * How wide the panes are on a desktop, and whether the menu on the left is folded
 * away. Kept in this browser (it is about this screen), and only read where there
 * is room for three panes; a phone has one column.
 */
export const RAIL = { min: 140, max: 520, fallback: 164 };
export const CHAT = { min: 300, max: 900 };

type Panes = { rail: number | null; chat: number | null; collapsed: boolean; /** Folded to a strip of icons rather than away. */ mini: boolean };

const KEY = "autora.panes";
function read(): Panes {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Panes>;
    const num = (n: unknown, lo: number, hi: number) => (typeof n === "number" && Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : null);
    return { rail: num(raw.rail, RAIL.min, RAIL.max), chat: num(raw.chat, CHAT.min, CHAT.max), collapsed: raw.collapsed === true, mini: raw.mini === true };
  } catch {
    return { rail: null, chat: null, collapsed: false, mini: false };
  }
}

let panes: Panes = read();
const listeners = new Set<() => void>();

function set(next: Partial<Panes>) {
  panes = { ...panes, ...next };
  try { localStorage.setItem(KEY, JSON.stringify(panes)); } catch { /* this browser keeps nothing */ }
  for (const l of listeners) l();
}

export const setRailWidth = (px: number | null) => set({ rail: px === null ? null : Math.min(RAIL.max, Math.max(RAIL.min, Math.round(px))) });
export const setChatWidth = (px: number | null) => set({ chat: px === null ? null : Math.min(CHAT.max, Math.max(CHAT.min, Math.round(px))) });
export const setRailCollapsed = (collapsed: boolean) => set({ collapsed });
export const setRailMini = (mini: boolean) => set({ mini });

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export function usePanes(): Panes {
  return useSyncExternalStore(subscribe, () => panes, () => panes);
}

/** Wide enough for the menu to sit in the margin (the same width the stylesheet uses). */
export const wideScreen = () => typeof matchMedia === "function" && matchMedia("(min-width: 1180px)").matches;
