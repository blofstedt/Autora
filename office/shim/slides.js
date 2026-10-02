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
