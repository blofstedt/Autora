import { useCallback, useState, type ReactNode } from "react";

/**
 * The tool rail every Autora app wears (docs/TOOL-RAIL.md): round, coloured tools, a bar that never scrolls, an All tools
 * grid for the rest. This file is what an app hands to `ToolRail` (src/components/ToolRail.tsx): a list of tools, each
 * with the colour of its verb. The PDF window's rail (spectra-editor/src/autora/rail.tsx) is the same design inside
 * Spectra's frame; apps whose editors live in the host page use this one.
 */

/** One colour per verb, the same in every app, so a person learns it once. These are SecurePDF's. */
export const VERB = {
  select: "#2563eb",
  text: "#059669",
  highlight: "#f59e0b",
  draw: "#9333ea",
  shape: "#4f46e5",
  note: "#0284c7",
  stamp: "#d97706",
  remove: "#e11d48",
  insert: "#0891b2",
} as const;

export interface RailTool {
  id: string;
  label: string;
  /** The grid's section for it. */
  group: string;
  icon: ReactNode;
  color: string;
  /** In the phone's bar, and what a desktop's starts with. */
  phone?: boolean;
  /** In the desktop's bar at first, beyond the phone's. */
  desktop?: boolean;
  /** Lit while it is on: the tool whose tray is open, or a switch that is set. */
  on?: boolean;
  disabled?: boolean;
  /** Said under the label in the grid and as the bar's tooltip. */
  about?: string;
  run: () => void;
}

const keyOf = (app: string) => `autora-rail-pins-${app}`;

/** What a desktop's bar shows, in order: the person's pins, or the defaults. A phone never reads this. */
export function usePins(app: string, tools: RailTool[]): {
  pins: string[];
  toggle: (id: string, room: number) => "pinned" | "unpinned" | "full";
  reset: () => void;
} {
  const defaults = tools.filter((t) => t.phone || t.desktop).map((t) => t.id);
  const [pins, setPins] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(keyOf(app)) ?? "null") as unknown;
      if (Array.isArray(saved)) return saved.filter((id): id is string => typeof id === "string");
    } catch { /* no storage: the defaults */ }
    return defaults;
  });
  const save = (next: string[]) => {
    setPins(next);
    try { localStorage.setItem(keyOf(app), JSON.stringify(next)); } catch { /* it still works for this session */ }
  };
  const toggle = useCallback((id: string, room: number) => {
    if (pins.includes(id)) { save(pins.filter((p) => p !== id)); return "unpinned" as const; }
    if (pins.length >= room) return "full" as const;
    save([...pins, id]);
    return "pinned" as const;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `save` only closes over setPins and the app key
  }, [pins, app]);
  const reset = useCallback(() => save(defaults), [defaults.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  return { pins, toggle, reset };
}
