import { useEffect, useState } from "react";

/**
 * Themes and fonts.
 *
 * A theme is a set of CSS custom properties keyed off `data-theme` on <html>
 * (see the "Themes" section of styles.css); a font is `data-font`. The choice
 * is saved on the server so it follows you between devices, and cached in
 * this browser so the right colours are there on the very first paint rather
 * than after a fetch.
 */

export type ThemeId =
  | "violet" | "teal" | "nous-blue" | "midnight" | "ember" | "mono" | "cyberpunk" | "rose";
export type FontId = "inter" | "system" | "rounded" | "mono";

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

export type Appearance = { theme: ThemeId; font: FontId };

const KEY = "autora.appearance";

export function cachedAppearance(): Appearance {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "null");
    if (raw && THEMES.some((t) => t.id === raw.theme) && FONTS.some((f) => f.id === raw.font)) {
      return raw;
    }
  } catch { /* storage blocked or garbled: defaults */ }
  return { theme: "violet", font: "inter" };
}

/** Put a theme and font on the page, and remember them in this browser. */
export function applyAppearance(next: Appearance) {
  const html = document.documentElement;
  html.dataset.theme = next.theme;
  html.dataset.font = next.font;
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
