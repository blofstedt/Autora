/*
 * GenOffice's PowerPoint editor, on top of its real preload (bundled in front of
 * this file, talking to the engine through common.js's ipc). What is set here is
 * only where Autora is the host rather than Electron: which document is open,
 * the theme, where an exported PDF goes.
 */
(() => {
  "use strict";
  const { host, framed } = window.__autora;
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

  // ---- the Autora look: this app's own shades -----------------------------------------
  // The chrome tokens every editor shares are re-pointed once, in common.js; what is left
  // here is what only the deck editor has -- the --slides-* shades its stage, rail,
  // statusbar, selection and animation colours are drawn from.
  window.__autora.addStyle("autora-slides", `
:root, :root[data-theme='light'], :root[data-theme='dark'] {
  --slides-statusbar-border: #1d2130 !important;
  --slides-ctl-border: #252a3b !important;
  --slides-att-border: #252a3b !important;
  --slides-stagebar-ink: #98a1b6 !important;
  --slides-text-disabled: #5a6072 !important;
  --slides-statusbar-bg: #0e1016 !important;
  --slides-rail-bg: #0e1016 !important;
  --slides-statusbar-hover: rgba(255, 255, 255, 0.05) !important;
  --slides-statusbar-active: rgba(255, 255, 255, 0.08) !important;
  --slides-chip-bg: #1d2130 !important;
  --slides-comment-bg: #151824 !important;
  --slides-att-bg: #151824 !important;
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
  --slides-error: #fb7185 !important;
  --slides-error-bg: rgba(251, 113, 133, 0.12) !important;
  --slides-danger-bg: rgba(251, 113, 133, 0.14) !important;
  --slides-ai-error: #fb7185 !important;
  --slides-ai-error-border: rgba(251, 113, 133, 0.45) !important;
  --slides-ai-error-bg: rgba(251, 113, 133, 0.12) !important;
  --slides-ai-step-error: #fb7185 !important;
  --slides-ok: #34d399 !important;
  --slides-anim-entr: #34d399 !important;
  --slides-anim-emph: #fbbf24 !important;
  --slides-anim-exit: #fb7185 !important;
  --slides-anim-path: #22d3ee !important;
  --slides-anim-media: #a78bfa !important;
  --slides-thumb-shadow: 0 4px 16px -4px rgba(0, 0, 0, 0.5), 0 1px 3px rgba(0, 0, 0, 0.3) !important;
  --slides-scroll-thumb: #252a3b !important;
  --slides-shimmer-base: #7a8297 !important;
  --slides-shimmer-hi: #edeff5 !important;
  --slides-swatch-ring: rgba(255, 255, 255, 0.25) !important;
  --slides-swatch-ring-strong: rgba(255, 255, 255, 0.35) !important;
}
`);
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
