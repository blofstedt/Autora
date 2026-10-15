import { useSyncExternalStore } from "react";

/**
 * How wide the panes are on a desktop, and whether the menu on the left is folded
 * away. Kept in this browser (it is about this screen), and only read where there
 * is room for three panes; a phone has one column.
 */
export const RAIL = {
  min: 48, max: 520,
  /** Icons only, a third of what the menu used to be. */
  fallback: 56,
  /** Below this the labels do not fit, so the menu shows icons only. The
      labels need about 157px uncut, so a menu narrower than this is a strip of
      icons: at 120 the words appeared at a width they could not sit in, and the
      pane was dragged wide by its own content rather than by hand. */
  words: 160,
  /** What "show the whole menu" widens to. */
  whole: 164,
};
export const CHAT = { min: 300, max: 900 };

/* The menu is never folded away on a desktop any more: whole, or a strip of icons. An old `collapsed` in storage is ignored. */
type Panes = { rail: number | null; chat: number | null; /** Folded to a strip of icons. */ mini: boolean };

const KEY = "autora.panes";
function read(): Panes {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Panes>;
    const num = (n: unknown, lo: number, hi: number) => (typeof n === "number" && Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : null);
    return { rail: num(raw.rail, RAIL.min, RAIL.max), chat: num(raw.chat, CHAT.min, CHAT.max), mini: raw.mini === true };
  } catch {
    return { rail: null, chat: null, mini: false };
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
export const setRailMini = (mini: boolean) => set({ mini });

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export function usePanes(): Panes {
  return useSyncExternalStore(subscribe, () => panes, () => panes);
}

