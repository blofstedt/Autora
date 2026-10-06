/*
 * GenOffice's PowerPoint editor, on top of its real preload (bundled in front of
 * this file, talking to the engine through common.js's ipc). What is set here is
 * only where Autora is the host rather than Electron: which document is open,
 * the theme, where an exported PDF goes.
 */
(() => {
  "use strict";
  const { host, framed, headless } = window.__autora;
  const api = window.slidesApi;
  if (!api) { console.error("autora: the PowerPoint preload did not run"); return; }

  const over = {
    // Every Autora theme is dark; the editor has a dark theme of its own.
    getTheme: async () => "dark",
    getLanguage: async () => "en",
    getAutoSaveDefault: async () => ({ on: true, updatedAt: 1 }),
    // The assistant is Autora's agent: the editor's own AI panel stays shut.
    getAiPanelPrefs: async () => ({ side: "right", fontSize: "medium", customFontSize: 14, spellcheck: true, openInNewDocs: false }),
    setAiPanelPrefs: async (patch) => ({ side: "right", fontSize: "medium", customFontSize: 14, spellcheck: true, openInNewDocs: false, ...(patch || {}) }),
    // The deck the person is to see: the host names the file the engine has open (it is on the server's disk).
    consumePendingOpen: async (fit) => {
      const m = await host("open", {});
      return m && m.path ? api.openPptxPath(m.path, fit) : null;
    },
    consumeHeadlessExport: async () => (window.__autoraHeadless && window.__autoraHeadless.outPath) || null,
    headlessExportDone: (result) => { window.__autoraDone = result; void host("done", result).catch(() => undefined); },
    getPathForFile: () => "",
  };
  // In the window, Export PDF is the same as the agent's: the server draws the deck and the PDF editor opens it.
  if (framed) {
    over.exportPdf = async () => {
      try { await host("export-pdf", {}); return { ok: true, path: "/autora/deck.pdf" }; }
      catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    };
  }
  for (const [k, v] of Object.entries(over)) api[k] = v;

  // ---- the Autora look -----------------------------------------------------------------
  // The interface the person works in should be Autora's, not GenOffice's. The editor keeps
  // its whole chrome in tokens -- @genoffice/ui/tokens.css (surface / text / border / …),
  // the per-app --accent, and slides' own --slides-* shades -- so the interface is re-pointed
  // here in one place instead of restyled selector by selector. Values are Autora's own
  // (src/styles.css: --s1…--s4, --sink, --text/--text-2/--text-3, --accent, --live, --warn,
  // --danger, the shadows and --ease), and the radii need no changing: 6 / 8 / 12 / 16 are
  // already both suites'. Nothing of the deck moves: the slide, its thumbnails and the export
  // draw from their own paper colours, and the headless render keeps the editor's plain
  // chrome, so what is exported is unchanged.
  const AUTORA_UI = `
:root, :root[data-theme='light'], :root[data-theme='dark'] {
  /* surfaces: Autora --s1 --s2 --s3 --s4, --bg, --sink */
  --surface: #0e1016 !important;
  --surface-subtle: #151824 !important;
  --chrome-bg: #0e1016 !important;
  --canvas: #08090d !important;
  --bg-content: #08090d !important;
  --color-bg-page: #0e1016 !important;
  --color-bg-subtle: #151824 !important;
  /* lines */
  --border: #1d2130 !important;
  --border-subtle: #151824 !important;
  --border-strong: #252a3b !important;
  --border-hover: #252a3b !important;
  --color-border-default: #1d2130 !important;
  --color-border-strong: #252a3b !important;
  --slides-statusbar-border: #1d2130 !important;
  --slides-ctl-border: #252a3b !important;
  --slides-att-border: #252a3b !important;
  /* text: --text --text-2 --text-3 */
  --text: #edeff5 !important;
  --text-primary: #edeff5 !important;
  --text-secondary: #98a1b6 !important;
  --text-tertiary: #7a8297 !important;
  --text-muted: #7a8297 !important;
  --text-dim: #98a1b6 !important;
  --icon-muted: #7a8297 !important;
  --color-text-primary: #edeff5 !important;
  --color-text-secondary: #98a1b6 !important;
  --color-text-tertiary: #7a8297 !important;
  --slides-stagebar-ink: #98a1b6 !important;
  --slides-text-disabled: #5a6072 !important;
  /* states */
  --hover: #151824 !important;
  --pressed: #1d2130 !important;
  --active-bg: #252a3b !important;
  --bg-hover: #151824 !important;
  --bg-hover-subtle: #151824 !important;
  --bg-hover-strong: #1d2130 !important;
  --bg-hover-accent: rgba(110, 91, 255, 0.14) !important;
  --slides-statusbar-bg: #0e1016 !important;
  --slides-rail-bg: #0e1016 !important;
  --slides-statusbar-hover: rgba(255, 255, 255, 0.05) !important;
  --slides-statusbar-active: rgba(255, 255, 255, 0.08) !important;
  --slides-chip-bg: #1d2130 !important;
  --slides-comment-bg: #151824 !important;
  --slides-att-bg: #151824 !important;
  /* accent: --accent --accent-light --accent-deep --accent-soft, --accent-2 for the second */
  --accent: #6e5bff !important;
  --accent-dark: #5a48e8 !important;
  --accent-soft: rgba(110, 91, 255, 0.14) !important;
  --slides-hover-wash: rgba(110, 91, 255, 0.15) !important;
  --slides-hover-wash-soft: rgba(110, 91, 255, 0.12) !important;
  --slides-select-border: #6e5bff !important;
  --slides-select-hover-bg: rgba(110, 91, 255, 0.14) !important;
  --slides-select-active-bg: rgba(110, 91, 255, 0.18) !important;
  --slides-cell-focus-bg: rgba(110, 91, 255, 0.16) !important;
  --slides-focus-ring: rgba(110, 91, 255, 0.45) !important;
  --slides-focus-ring-soft: rgba(110, 91, 255, 0.35) !important;
  --slides-focus-ring-strong: rgba(124, 107, 255, 0.7) !important;
  --slides-focus-ring-blue: rgba(34, 211, 238, 0.45) !important;
  --slides-guide: rgba(110, 91, 255, 0.75) !important;
  --color-ai-action: #6e5bff !important;
  --color-ai-action-hover: #7d6bff !important;
  --color-ai-action-text: #ffffff !important;
  --color-btn-primary: #6e5bff !important;
  --color-btn-primary-hover: #5a48e8 !important;
  --color-btn-primary-text: #ffffff !important;
  --color-border-brand: #6e5bff !important;
  --color-brand-secondary: #22d3ee !important;
  /* semantic: --danger --live --warn */
  --danger: #fb7185 !important;
  --danger-bg: rgba(251, 113, 133, 0.12) !important;
  --danger-border: rgba(251, 113, 133, 0.35) !important;
  --color-error: #fb7185 !important;
  --color-error-hover: #f43f5e !important;
  --slides-error: #fb7185 !important;
  --slides-error-bg: rgba(251, 113, 133, 0.12) !important;
  --slides-danger-bg: rgba(251, 113, 133, 0.14) !important;
  --slides-ai-error: #fb7185 !important;
  --slides-ai-error-border: rgba(251, 113, 133, 0.45) !important;
  --slides-ai-error-bg: rgba(251, 113, 133, 0.12) !important;
  --slides-ai-step-error: #fb7185 !important;
  --success: #34d399 !important;
  --success-bg: rgba(52, 211, 153, 0.12) !important;
  --success-border: rgba(52, 211, 153, 0.3) !important;
  --slides-ok: #34d399 !important;
  --slides-anim-entr: #34d399 !important;
  --slides-anim-emph: #fbbf24 !important;
  --slides-anim-exit: #fb7185 !important;
  --slides-anim-path: #22d3ee !important;
  --slides-anim-media: #a78bfa !important;
  /* shadows and motion: --shadow --shadow-lg and --ease */
  --shadow-menu: 0 20px 48px -12px rgba(0, 0, 0, 0.7), 0 2px 8px rgba(0, 0, 0, 0.4) !important;
  --shadow-modal-strong: 0 20px 48px -12px rgba(0, 0, 0, 0.7) !important;
  --shadow-btn-hover: 0 4px 16px -4px rgba(0, 0, 0, 0.5) !important;
  --slides-thumb-shadow: 0 4px 16px -4px rgba(0, 0, 0, 0.5), 0 1px 3px rgba(0, 0, 0, 0.3) !important;
  --color-bg-overlay: rgba(6, 7, 10, 0.66) !important;
  --slides-scroll-thumb: #252a3b !important;
  --slides-shimmer-base: #7a8297 !important;
  --slides-shimmer-hi: #edeff5 !important;
  --slides-swatch-ring: rgba(255, 255, 255, 0.25) !important;
  --slides-swatch-ring-strong: rgba(255, 255, 255, 0.35) !important;
  --transition-fast: 150ms cubic-bezier(0.32, 0.72, 0, 1) !important;
  --transition-medium: 240ms cubic-bezier(0.32, 0.72, 0, 1) !important;
  color-scheme: dark !important;
}
/* Autora's type, everywhere in the chrome; the deck is drawn with its own fonts. */
body, #root, .app { font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif !important; }
::selection { background: rgba(110, 91, 255, 0.35); }
`;
  if (!headless) {
    const ui = document.createElement("style");
    ui.id = "autora-ui";
    ui.textContent = AUTORA_UI;
    document.head.appendChild(ui);
  }

  // The person is in the deck: said to the host every few seconds while they work, so the agent leaves it alone.
  if (framed) {
    let last = 0;
    const touch = () => {
      const now = Date.now();
      if (now - last < 4000) return;
      last = now;
      void host("presence", {}).catch(() => undefined);
    };
    document.addEventListener("input", touch, true);
    document.addEventListener("keydown", touch, true);
    document.addEventListener("pointerdown", touch, true);
  }
})();
