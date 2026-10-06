/*
 * GenOffice's Excel editor, on top of its real preload (bundled in front of this
 * file, talking to the engine through common.js's ipc). What is set here is only
 * where Autora is the host rather than Electron: the theme, the AI panel, where
 * an exported PDF goes.
 */
(() => {
  "use strict";
  const { host, framed } = window.__autora;
  const api = window.desktopApi;
  if (!api) { console.error("autora: the Excel preload did not run"); return; }

  // Printing to PDF takes the cells as the grid shows them, and the grid's formulas settle a moment after the
  // workbook opens (Electron is slow enough that nobody notices). The export is held until the engine has been
  // quiet for a while after the workbook opened.
  let lastIpc = Date.now();
  let opened = false;
  let openedAt = 0;
  const invoke = window.__autora.ipc.invoke;
  window.__autora.ipc.invoke = (channel, ...args) => {
    lastIpc = Date.now();
    if (channel === "workbook:select") { opened = true; openedAt = Date.now(); }
    return invoke(channel, ...args).finally(() => { lastIpc = Date.now(); });
  };
  const consumeHeadlessExport = api.consumeHeadlessExport;

  const over = {
    consumeHeadlessExport: async () => {
      const out = await consumeHeadlessExport();
      if (!out) return out;
      const started = Date.now();
      while ((!opened || Date.now() - lastIpc < 1000 || Date.now() - openedAt < 1700) && Date.now() - started < 120000) await new Promise((r) => setTimeout(r, 250));
      return out;
    },
    // Every Autora theme is dark; the editor has a dark theme of its own.
    getTheme: async () => "dark",
    getLanguage: async () => "en",
    getAutoSaveDefault: async () => ({ on: true, updatedAt: 1 }),
    // The assistant is Autora's agent: the editor's own AI panel stays shut.
    getAiPanelPrefs: async () => ({ side: "right", fontSize: "medium", customFontSize: 14, spellcheck: true, openInNewDocs: false }),
    setAiPanelPrefs: async (patch) => ({ side: "right", fontSize: "medium", customFontSize: 14, spellcheck: true, openInNewDocs: false, ...(patch || {}) }),
    getPathForFile: () => "",
    getAiSettings: async () => ({ provider: "genspark", providers: {}, gskToolsEnabled: false }),
    aiGskStatus: async () => ({ loggedIn: false }),
    headlessExportDone: (result) => {
      window.__autoraDone = result;
      void host("done", result).catch(() => undefined);
      api.__headlessExportDone(result);
    },
  };
  api.__headlessExportDone = api.headlessExportDone;
  // In the window, Export PDF is the same as the agent's: the server draws the workbook and the PDF editor opens it.
  if (framed) {
    over.exportPdf = async () => {
      try { await host("export-pdf", {}); return { canceled: false, path: "/autora/workbook.pdf" }; }
      catch (e) { throw new Error(String((e && e.message) || e)); }
    };
  }
  for (const [k, v] of Object.entries(over)) api[k] = v;

  // ---- the Autora look: this app's own shades -----------------------------------------
  // The chrome tokens every editor shares are re-pointed once, in common.js; what is here is
  // what only the workbook editor has -- the --sheets-* chrome shades and shadows its
  // statusbar, menus, toasts and focus rings are drawn from. The tokens the grid itself is
  // painted with (--sheets-paper, --excel-green, --sheets-chart-*, --sheets-shape-*) are left
  // alone: they sit on the paper-like grid and are the workbook's own colours, not the
  // interface's.
  window.__autora.addStyle("autora-sheets", `
:root, :root[data-theme='light'], :root[data-theme='dark'] {
  /* Autora's accent in place of Excel's green, and Autora's steps for the greys */
  --surface-hover: #151824 !important;
  --ribbon-hover: #151824 !important;
  --ribbon-active: #252a3b !important;
  --focus: rgba(110, 91, 255, 0.35) !important;
  --shadow-panel: 0 20px 48px -12px rgba(0, 0, 0, 0.7), 0 2px 8px rgba(0, 0, 0, 0.4) !important;
  --shadow-modal: 0 20px 48px -12px rgba(0, 0, 0, 0.7) !important;
  --sheets-error: #fb7185 !important;
  --sheets-ai-error: #fb7185 !important;
  --sheets-ai-error-border: rgba(251, 113, 133, 0.45) !important;
  --sheets-ai-error-bg: rgba(251, 113, 133, 0.12) !important;
  --sheets-notice-border: rgba(110, 91, 255, 0.35) !important;
  --sheets-statusbar-bg: #0e1016 !important;
  --sheets-statusbar-border: #1d2130 !important;
  --sheets-statusbar-hover: rgba(255, 255, 255, 0.05) !important;
  --sheets-zoom-slider: #252a3b !important;
  --sheets-focus-ring: rgba(110, 91, 255, 0.45) !important;
  --sheets-shimmer-base: #7a8297 !important;
  --sheets-shimmer-hi: #edeff5 !important;
  --sheets-scroll-thumb: #252a3b !important;
  --sheets-chip-bg: #1d2130 !important;
  --sheets-member-bg: #1d2130 !important;
  --sheets-member-ink: #98a1b6 !important;
  /* the data-validation prompt is chrome, not paper: Autora's violet, not Office's olive */
  --sheets-validation-prompt-bg: #221d3a !important;
  --sheets-validation-prompt-border: #3b3560 !important;
  --sheets-validation-prompt-ink: #edeff5 !important;
  --sheets-validation-prompt-shadow: 0 20px 48px -12px rgba(0, 0, 0, 0.7) !important;
  --sheets-toast-bg: rgba(37, 42, 59, 0.96) !important;
  --sheets-toast-error-bg: rgba(180, 60, 85, 0.96) !important;
  --sheets-toast-ink: #edeff5 !important;
  --sheets-toast-ok: #34d399 !important;
  --sheets-shadow-drop: 0 20px 48px -12px rgba(0, 0, 0, 0.7), 0 2px 8px rgba(0, 0, 0, 0.4) !important;
  --sheets-shadow-menu: 0 20px 48px -12px rgba(0, 0, 0, 0.7), 0 2px 8px rgba(0, 0, 0, 0.4) !important;
  --sheets-shadow-pane: 0 20px 48px -12px rgba(0, 0, 0, 0.7) !important;
  --sheets-shadow-card: 0 1px 3px rgba(0, 0, 0, 0.5) !important;
  --sheets-shadow-chart: 0 4px 16px -4px rgba(0, 0, 0, 0.5) !important;
  --sheets-shadow-copilot: 0 20px 48px -12px rgba(0, 0, 0, 0.7) !important;
  --sheets-shadow-badge: 0 4px 16px -4px rgba(0, 0, 0, 0.5) !important;
  --sheets-shadow-slicer: 0 20px 48px -12px rgba(0, 0, 0, 0.7) !important;
  --sheets-shadow-toast: 0 20px 48px -12px rgba(0, 0, 0, 0.7) !important;
  --sheets-shadow-composer: 0 20px 48px -12px rgba(0, 0, 0, 0.7) !important;
}
`);

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
