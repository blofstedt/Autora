/**
 * The page an explainer widget runs in.
 *
 * The agent writes the widget -- a gravity well you can drop planets into, a
 * water cycle you can heat up -- as HTML with inline CSS and JavaScript. This
 * wraps that in the document it actually runs as: the thread's colours as CSS
 * variables, Three.js under an import map when the widget uses it, and a few
 * lines that tell the thread how tall the content is.
 *
 * Shared by both halves on purpose, and so written without DOM or Node types:
 * the thread builds the frame it shows (with Three.js inlined, see
 * src/widget/three.ts), and the server builds the copy it keeps as an
 * artifact (with Three.js from a CDN, so the file works on its own once
 * downloaded).
 */

/** What a widget is allowed to be. Enough for a detailed 3D scene; not
    enough for a data dump pasted in as markup. */
export const MAX_WIDGET_CHARS = 200_000;

/** The heights the thread will draw a widget at, in CSS pixels. */
export const WIDGET_MIN_HEIGHT = 160;
export const WIDGET_MAX_HEIGHT = 1400;
export const WIDGET_DEFAULT_HEIGHT = 440;

/** The version of Three.js a standalone copy loads from the CDN. Kept in
    step with the one bundled into the app by package.json. */
export const THREE_VERSION = "0.186.1";
export const THREE_CDN = `https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}`;

/** Colours and type, so a widget looks like it belongs in the thread. */
export type WidgetPalette = {
  bg: string; surface: string; text: string; muted: string;
  accent: string; accent2: string; border: string; font: string;
};

/** Autora Violet, for the standalone copy that has no thread to ask. */
export const DEFAULT_PALETTE: WidgetPalette = {
  bg: "#0e1016", surface: "#151824", text: "#edeff5", muted: "#98a1b6",
  accent: "#6e5bff", accent2: "#22d3ee", border: "rgba(255,255,255,0.11)",
  font: `"Inter", system-ui, -apple-system, "Segoe UI", sans-serif`,
};

/** Does this widget import Three.js? Only then is the 750 KB bundle added. */
export function usesThree(html: string): boolean {
  return /(?:from\s*|import\s*\(\s*|import\s+)["']three(?:\/[^"']*)?["']/.test(html);
}

/**
 * Every name a widget might import Three.js or its addons by, pointing at
 * one module. With the bundled runtime that is the same data: URL for all of
 * them, so they share one copy of Three.js; with the CDN each is its own file.
 */
function importMap(three: { bundled: string } | { cdn: string }): string {
  const imports: Record<string, string> = {};
  if ("bundled" in three) {
    for (const name of [
      "three",
      "three/addons/controls/OrbitControls.js",
      "three/addons/renderers/CSS2DRenderer.js",
      "three/examples/jsm/controls/OrbitControls.js",
      "three/examples/jsm/renderers/CSS2DRenderer.js",
    ]) imports[name] = three.bundled;
  } else {
    imports.three = `${three.cdn}/build/three.module.js`;
    imports["three/addons/"] = `${three.cdn}/examples/jsm/`;
    imports["three/examples/jsm/"] = `${three.cdn}/examples/jsm/`;
  }
  return `<script type="importmap">${JSON.stringify({ imports })}</script>`;
}

/** Text safe to put between <title> tags. */
function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The widget as a whole document.
 *
 * `frame` is set when the thread shows it: the content then reports its
 * height to the thread under that id, so the card fits what is drawn.
 */
export function widgetDocument(opts: {
  title: string;
  html: string;
  palette?: WidgetPalette;
  /** A data: URL of src/widget/three.ts, or nothing to load it from the CDN. */
  threeBundle?: string | null;
  frame?: string;
}): string {
  const p = opts.palette ?? DEFAULT_PALETTE;
  const three = usesThree(opts.html)
    ? importMap(opts.threeBundle ? { bundled: opts.threeBundle } : { cdn: THREE_CDN })
    : "";
  const head = [
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<style>
:root {
  color-scheme: dark;
  --bg: ${p.bg}; --surface: ${p.surface}; --text: ${p.text}; --muted: ${p.muted};
  --accent: ${p.accent}; --accent-2: ${p.accent2}; --border: ${p.border};
  --font: ${p.font};
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 var(--font); }
button, input, select { font: inherit; color: inherit; }
button {
  background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
  padding: 5px 11px; cursor: pointer;
}
button:hover { border-color: var(--accent); }
input[type=range] { accent-color: var(--accent); }
canvas { display: block; }
</style>`,
    three,
    opts.frame ? frameScript(opts.frame) : "",
  ].filter(Boolean).join("\n");

  // A whole document from the agent keeps its own shape; the head goes in
  // first so its own styles still win.
  if (/<html[\s>]/i.test(opts.html)) {
    const withHead = opts.html.replace(/<head[^>]*>/i, (tag) => `${tag}\n${head}`);
    return withHead !== opts.html
      ? withHead
      : opts.html.replace(/<html[^>]*>/i, (tag) => `${tag}\n<head>${head}</head>`);
  }
  return `<!doctype html>
<html lang="en">
<head>
<title>${escapeText(opts.title)}</title>
${head}
</head>
<body>
${opts.html}
</body>
</html>`;
}

/**
 * Tells the thread how tall the content is, and reports errors: a widget
 * that throws draws nothing, and a blank card with no reason is worse than
 * one that says what broke.
 */
function frameScript(frame: string): string {
  const id = JSON.stringify(frame);
  return `<script>
(() => {
  const post = (msg) => { try { parent.postMessage(Object.assign({ autoraWidget: ${id} }, msg), "*"); } catch {} };
  let last = 0;
  const measure = () => {
    const h = Math.ceil(Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0));
    if (Math.abs(h - last) > 2) { last = h; post({ height: h }); }
  };
  addEventListener("load", measure);
  addEventListener("DOMContentLoaded", () => {
    measure();
    new ResizeObserver(measure).observe(document.body);
  });
  addEventListener("error", (e) => post({ error: String(e.message || e.error || "Script error") }));
  addEventListener("unhandledrejection", (e) => post({ error: String((e.reason && e.reason.message) || e.reason) }));
})();
</script>`;
}
