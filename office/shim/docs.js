/*
 * GenOffice Docs' preload API (apps/docs/src/shared/ipc.ts), answered by Autora.
 * Everything the editor calls that is not listed here gets a harmless answer:
 * subscriptions return an unsubscribe that does nothing, everything else
 * resolves to null. The ones that matter are below.
 */
(() => {
  "use strict";
  const { host, onPush } = window.__autora;
  const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

  /** The document the host has for this window, as the editor's "opened" result. */
  const opened = (m) => {
    const blob = new Blob([m.bytes], { type: DOCX });
    return { path: m.path || `/autora/${m.name}`, name: m.name, dataUrl: URL.createObjectURL(blob), hash: m.hash || "autora" };
  };

  const openHandlers = new Set();
  onPush("load", (m) => {
    if (!m || !m.bytes) return;
    const result = opened(m);
    for (const fn of openHandlers) fn(result);
  });

  const saved = async (name, data) => {
    try {
      await host("save", { name, bytes: data });
      return { ok: true, path: `/autora/${name}` };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  };

  const explicit = {
    // ---- how it looks and speaks
    getLanguage: async () => "en",
    getSystemLocale: async () => "en-US",
    getTheme: async () => "light",
    getAutoSaveDefault: async () => ({ on: true, updatedAt: 1 }),
    // Autora's agent is the assistant: the editor's own AI panel stays shut.
    getAiPanelPrefs: async () => ({ side: "right", fontSize: "medium", customFontSize: 14, spellcheck: true, openInNewDocs: false }),
    setAiPanelPrefs: async (patch) => ({ side: "right", fontSize: "medium", customFontSize: 14, spellcheck: true, openInNewDocs: false, ...(patch || {}) }),
    getAiSettings: async () => ({ providers: [], active: null }),

    // ---- the document
    consumePendingOpenDocx: async () => {
      const m = window.__autoraDoc || (await host("open", {}));
      return m && m.bytes ? opened(m) : null;
    },
    consumeNewBlankDoc: async () => false,
    consumeAiDocContent: async () => null,
    consumeHeadlessExport: async () => window.__autoraHeadless ?? null,
    headlessExportDone: (result) => { window.__autoraDone = result; void host("done", result).catch(() => undefined); },
    openDocx: async () => null,
    openDocxPath: async () => null,
    confirmDocumentReplace: async () => true,
    onOpenDocx: (fn) => { openHandlers.add(fn); return () => openHandlers.delete(fn); },
    saveDocx: (path, data) => saved(String(path || "").split("/").pop() || "document.docx", data),
    saveDocxAs: (name, data) => saved(name, data),
    saveDocxNew: (name, data) => saved(name, data),
    saveDocxTo: async (path, data) => ({ ...(await saved(String(path).split("/").pop() || "document.docx", data)), path }),
    writeRecoveryCopy: async () => ({ ok: true }),
    setDocPassword: async () => ({ ok: true }),
    docPasswordIntentRevision: async () => 0,
    discardDocPasswordIntents: async () => ({ ok: true }),
    getRecentFiles: async () => [],
    listDocsTabs: async () => [],
    fontMetrics: async () => null,
    getPathForFile: () => "",

    // ---- pictures the person brings in
    pickImage: async () => {
      const r = await host("pick-image", {}).catch(() => null);
      return r && r.base64 ? r : null;
    },

    // ---- pages out: PDF is printed by Chromium, by the host
    print: async () => ({ ok: false }),
    exportPdf: async (name, w, h, outPath, scale) => {
      try {
        await host("pdf", { w, h, scale });
        return { ok: true, path: outPath || `/autora/${String(name || "document").replace(/\.docx$/i, "")}.pdf` };
      } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    },
    printPdfBuffer: async (w, h, scale) => {
      try { const r = await host("pdf-part", { w, h, scale }); return { ok: true, base64: r.base64 }; }
      catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    },
    saveMergedPdf: async (name, parts, outPath) => {
      try { await host("pdf-merge", { parts }); return { ok: true, path: outPath || `/autora/${name}` }; }
      catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    },
    pickExportImagesTarget: async () => null,
    exportHtml: async (name, html) => {
      try { await host("html", { name, html }); return { ok: true, path: `/autora/${name}` }; }
      catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    },
  };

  const answer = {
    get(target, prop) {
      if (typeof prop !== "string") return undefined;
      if (prop in target) return target[prop];
      if (/^on[A-Z]/.test(prop)) return () => () => undefined;
      return async () => null;
    },
  };
  window.desktop = new Proxy(explicit, answer);
  window.projectApi = new Proxy({}, { get: () => async () => null });
})();
