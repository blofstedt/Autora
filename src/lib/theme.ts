import { useEffect, useState } from "react";

/**
 * Themes, fonts, sizes and the corner widgets.
 *
 * A theme is a set of CSS custom properties keyed off `data-theme` on <html>
 * (see the "Themes" section of styles.css); a font is `data-font`. Two more
 * things are here because they are the same kind of choice:
 *
 *   - text size and icon size, as multipliers -- `--ts` and `--is` on <html>,
 *     which every font-size in styles.css and every icon in Icons.tsx read.
 *     Two controls rather than one because a phone wants bigger text without
 *     cartoon icons, and a desktop often wants the opposite.
 *   - how wide the text column runs (`data-col`), and which of the app's
 *     pages are pinned to the four corners of the conversation pane (`dock`).
 *
 * The whole lot is saved on the server so it follows you between devices, and
 * cached in this browser so the right sizes are there on the very first paint
 * rather than after a fetch.
 */

export type ThemeId =
  | "violet" | "teal" | "nous-blue" | "midnight" | "ember" | "mono" | "cyberpunk" | "rose";
export type FontId = "inter" | "system" | "rounded" | "mono";
export type TextSizeId = "small" | "default" | "large" | "largest";
export type IconSizeId = TextSizeId;
/** How wide the conversation runs inside its pane. `comfort` is the default
    the stylesheet already picks per window width. */
export type ColumnId = "comfort" | "wide" | "fill";

export const THEMES: { id: ThemeId; label: string; swatch: [string, string, string] }[] = [
  { id: "violet", label: "Autora Violet", swatch: ["#6e5bff", "#22d3ee", "#0e1016"] },
  { id: "teal", label: "Hermes Teal", swatch: ["#14b8a6", "#38bdf8", "#0b1214"] },
  { id: "nous-blue", label: "Nous Blue", swatch: ["#3b82f6", "#a78bfa", "#0c111a"] },
  { id: "midnight", label: "Midnight", swatch: ["#818cf8", "#f472b6", "#080a12"] },
  { id: "ember", label: "Ember", swatch: ["#f97316", "#facc15", "#140e0c"] },
  { id: "mono", label: "Mono", swatch: ["#e5e5e7", "#a1a1aa", "#0f0f11"] },
  { id: "cyberpunk", label: "Cyberpunk", swatch: ["#ec4899", "#22d3ee", "#0d0816"] },
  { id: "rose", label: "Rosé", swatch: ["#eb91a4", "#9ccfd8", "#15121c"] },
];

export const FONTS: { id: FontId; label: string; family: string }[] = [
  { id: "inter", label: "Inter", family: "Inter" },
  { id: "system", label: "System", family: "system-ui" },
  { id: "rounded", label: "Rounded", family: "Nunito" },
  { id: "mono", label: "Mono", family: "JetBrains Mono" },
];

/** Modest steps on purpose: past about 1.25 the fixed-height rows in the
    sidebar and the cards start to clip rather than grow. */
export const TEXT_SIZES: { id: TextSizeId; label: string; scale: number }[] = [
  { id: "small", label: "Small", scale: 0.9 },
  { id: "default", label: "Default", scale: 1 },
  { id: "large", label: "Large", scale: 1.12 },
  { id: "largest", label: "Largest", scale: 1.25 },
];

export const ICON_SIZES: { id: IconSizeId; label: string; scale: number }[] = [
  { id: "small", label: "Small", scale: 0.85 },
  { id: "default", label: "Default", scale: 1 },
  { id: "large", label: "Large", scale: 1.18 },
  { id: "largest", label: "Largest", scale: 1.35 },
];

export const COLUMNS: { id: ColumnId; label: string; hint: string }[] = [
  { id: "comfort", label: "Comfort", hint: "Around 900-1220px, following the window" },
  { id: "wide", label: "Wide", hint: "Up to 1400px, less empty margin on a big screen" },
  { id: "fill", label: "Fill", hint: "As wide as the pane allows" },
];

/** The four corners of the conversation pane a widget can be pinned to. */
export type DockSlot = "tl" | "tr" | "bl" | "br";

export const DOCK_SLOTS: { id: DockSlot; label: string; where: string }[] = [
  { id: "tl", label: "Top left", where: "top left" },
  { id: "tr", label: "Top right", where: "top right" },
  { id: "bl", label: "Bottom left", where: "bottom left" },
  { id: "br", label: "Bottom right", where: "bottom right" },
];

export type DockWidgetId =
  | "none" | "system" | "usage" | "schedules" | "mind"
  | "artifacts" | "sessions" | "integrations" | "settings";

/** Each widget is a small version of a page in the rail, and clicking it opens
    that page -- so the corner is a shortcut as well as a glance. */
export const DOCK_WIDGETS: { id: DockWidgetId; label: string; hint: string }[] = [
  { id: "none", label: "Empty", hint: "Nothing pinned" },
  { id: "system", label: "System", hint: "Processor, memory and disk" },
  { id: "usage", label: "Usage", hint: "What this month has cost" },
  { id: "schedules", label: "Schedules", hint: "What is running, and what is next" },
  { id: "mind", label: "Mind", hint: "The last thing it remembered" },
  { id: "artifacts", label: "Artifacts", hint: "How many files, newest first" },
  { id: "sessions", label: "Sessions", hint: "Recent conversations" },
  { id: "integrations", label: "Integrations", hint: "MCP servers and their health" },
  { id: "settings", label: "Settings", hint: "Shortcuts to Appearance, keys and voice" },
];

export type DockConfig = Record<DockSlot, DockWidgetId>;

export type Appearance = {
  theme: ThemeId;
  font: FontId;
  text: TextSizeId;
  icons: IconSizeId;
  column: ColumnId;
  dock: DockConfig;
};

export const DEFAULT_APPEARANCE: Appearance = {
  theme: "violet",
  font: "inter",
  text: "default",
  icons: "default",
  column: "comfort",
  dock: { tl: "none", tr: "none", bl: "none", br: "none" },
};

const KEY = "autora.appearance";

const idIn = <T extends string>(list: { id: T }[], v: unknown, fallback: T): T =>
  (list.some((x) => x.id === v) ? (v as T) : fallback);

const one = <T extends string>(list: { id: T }[], v: unknown): T | null =>
  (list.some((x) => x.id === v) ? (v as T) : null);

const scaleOf = (list: { id: string; scale: number }[], id: string) =>
  list.find((x) => x.id === id)?.scale ?? 1;

export const textScale = (id: TextSizeId) => scaleOf(TEXT_SIZES, id);
export const iconScale = (id: IconSizeId) => scaleOf(ICON_SIZES, id);

/** How many corners hold something -- the stylesheet narrows the text column
    to make room when this is more than none. */
export const dockCount = (dock: DockConfig) =>
  DOCK_SLOTS.filter((s) => dock[s.id] !== "none").length;

/**
 * Anything at all as a usable Appearance: what the server sent, an older
 * cached copy with fields this version does not have, or a hand-edited file.
 */
export function saneAppearance(raw: unknown): Appearance {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = (r.dock && typeof r.dock === "object" ? r.dock : {}) as Record<string, unknown>;
  const dock = { ...DEFAULT_APPEARANCE.dock };
  for (const slot of DOCK_SLOTS) {
    const pick = one(DOCK_WIDGETS, d[slot.id]);
    if (pick) dock[slot.id] = pick;
  }
  return {
    theme: idIn(THEMES, r.theme, DEFAULT_APPEARANCE.theme),
    font: idIn(FONTS, r.font, DEFAULT_APPEARANCE.font),
    text: idIn(TEXT_SIZES, r.text, DEFAULT_APPEARANCE.text),
    icons: idIn(ICON_SIZES, r.icons, DEFAULT_APPEARANCE.icons),
    column: idIn(COLUMNS, r.column, DEFAULT_APPEARANCE.column),
    dock,
  };
}

export function cachedAppearance(): Appearance {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return saneAppearance(JSON.parse(raw));
  } catch { /* storage blocked or garbled: defaults */ }
  return { ...DEFAULT_APPEARANCE, dock: { ...DEFAULT_APPEARANCE.dock } };
}

/**
 * Put the appearance on the page, and remember it in this browser.
 *
 * Sizes go on as custom properties rather than data attributes so the one
 * place that has to know -- the stylesheet, and the icon grid -- reads a
 * number, and calc() can do the arithmetic.
 */
export function applyAppearance(next: Appearance) {
  const html = document.documentElement;
  html.dataset.theme = next.theme;
  html.dataset.font = next.font;
  html.dataset.col = next.column;
  html.style.setProperty("--ts", String(textScale(next.text)));
  html.style.setProperty("--is", String(iconScale(next.icons)));
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* fine */ }
  // The phone's status bar and the installed app's frame follow the theme.
  const bg = getComputedStyle(html).getPropertyValue("--bg").trim();
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta && bg) meta.setAttribute("content", bg);
  window.dispatchEvent(new CustomEvent("autora-theme"));
}

/** Save to the server so the choice follows you; the page already shows it. */
export async function saveAppearance(next: Appearance) {
  applyAppearance(next);
  await fetch("/api/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appearance: next }),
  }).catch(() => undefined);
}

export type ThemeColors = {
  accent: string; accent2: string; glow: string; glowDeep: string;
  glowLight: string; glowText: string;
};

function readColors(): ThemeColors {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    accent: v("--accent", "#6e5bff"),
    accent2: v("--accent-2", "#22d3ee"),
    glow: v("--glow", "#a855f7"),
    glowDeep: v("--glow-deep", "#8b5cf6"),
    glowLight: v("--glow-light", "#c084fc"),
    glowText: v("--glow-text", "#e9d5ff"),
  };
}

/**
 * The current theme's colours as plain values, for the few places CSS
 * variables cannot reach: SVG gradient stops and SMIL animation values.
 */
export function useThemeColors(): ThemeColors {
  const [colors, setColors] = useState<ThemeColors>(readColors);
  useEffect(() => {
    const update = () => setColors(readColors());
    window.addEventListener("autora-theme", update);
    return () => window.removeEventListener("autora-theme", update);
  }, []);
  return colors;
}
