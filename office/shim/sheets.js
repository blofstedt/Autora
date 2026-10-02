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
  const invoke = window.__autora.ipc.invoke;
  window.__autora.ipc.invoke = (channel, ...args) => {
    lastIpc = Date.now();
    if (channel === "workbook:select") opened = true;
    return invoke(channel, ...args).finally(() => { lastIpc = Date.now(); });
  };
  const consumeHeadlessExport = api.consumeHeadlessExport;

  const over = {
    consumeHeadlessExport: async () => {
      const out = await consumeHeadlessExport();
      if (!out) return out;
      const started = Date.now();
      while ((!opened || Date.now() - lastIpc < 2500) && Date.now() - started < 120000) await new Promise((r) => setTimeout(r, 250));
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
