/*
 * GenOffice Docs' preload API (apps/docs/src/shared/ipc.ts), answered by Autora.
 * Everything the editor calls that is not listed here gets a harmless answer:
 * subscriptions return an unsubscribe that does nothing, everything else
 * resolves to null. The ones that matter are below.
 */
(() => {
  "use strict";
  const { host, onPush, framed, headless } = window.__autora;
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
    // Every Autora theme is dark; the editor has a dark theme of its own.
    getTheme: async () => "dark",
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

    // ---- pictures the person brings in: chosen here, in the frame, where the click is
    pickImage: () => new Promise((resolve) => {
      if (!framed) { resolve(null); return; }
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/png,image/jpeg,image/gif";
      input.onchange = async () => {
        const file = input.files && input.files[0];
        if (!file) { resolve(null); return; }
        const mime = file.type === "image/jpeg" || file.type === "image/gif" ? file.type : "image/png";
        resolve({ base64: window.__autora.b64(await file.arrayBuffer()), mime, name: file.name });
      };
      input.addEventListener("cancel", () => resolve(null));
      input.click();
    }),

    // ---- pages out: PDF is printed by Chromium, by the host
    print: async () => ({ ok: false }),
    exportPdf: async (name, w, h, outPath, scale) => {
      try {
        // In the window the server draws it, the same pages office_pdf makes, and opens it in the PDF editor.
        if (framed) { await host("export-pdf", {}); return { ok: true, path: `/autora/${String(name || "document").replace(/\.docx$/i, "")}.pdf` }; }
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

  // ---- the Autora look: this app's own shades -----------------------------------------
  // The chrome tokens every editor shares are re-pointed once, in common.js; what is here is
  // what only the Word editor has -- the --docs-* shades its ribbon, ruler, statusbar, print
  // view and menus are drawn from, and the Word-blue family the ribbon accents it with. The
  // --docs-paper-* family is deliberately untouched: that is the document's own paper, ink and
  // markup, which stays the same whatever the interface does.
  window.__autora.addStyle("autora-docs", `
:root, :root[data-theme='light'], :root[data-theme='dark'] {
  /* Word's blue is Autora's violet, in the ribbon and everywhere it leads */
  --word-blue: #6e5bff !important;
  --word-blue-dark: #5a48e8 !important;
  --word-heading: #a99cff !important;
  --docs-heading-3: #a99cff !important;
  --docs-accent-ghost: rgba(110, 91, 255, 0.18) !important;
  --docs-brand-ghost: rgba(110, 91, 255, 0.14) !important;
  --docs-brand-ghost-weak: rgba(110, 91, 255, 0.10) !important;
  --docs-brand-ring: rgba(110, 91, 255, 0.45) !important;
  --docs-input-focus: #6e5bff !important;
  --docs-input-ring: rgba(110, 91, 255, 0.20) !important;
  --docs-focus-ring: rgba(110, 91, 255, 0.45) !important;
  --docs-focus-ring-blue: rgba(34, 211, 238, 0.40) !important;
  --docs-error-ring: rgba(251, 113, 133, 0.20) !important;
  /* Autora's semantic colours, so an error or a saved badge reads the same here as anywhere */
  --docs-ins-ink: #34d399 !important;
  --docs-ins-bg: rgba(52, 211, 153, 0.10) !important;
  --docs-del-ink: #fb7185 !important;
  --docs-del-bg: rgba(251, 113, 133, 0.10) !important;
  --docs-ai-error: #fb7185 !important;
  --docs-ai-error-border: rgba(251, 113, 133, 0.45) !important;
  --docs-ai-error-bg: rgba(251, 113, 133, 0.12) !important;
  --docs-ok-ink: #34d399 !important;
  --docs-ok-bg: rgba(52, 211, 153, 0.12) !important;
  --docs-ok-border: rgba(52, 211, 153, 0.30) !important;
  --docs-ok-dot: #34d399 !important;
  /* surfaces and lines, in Autora's steps */
  --docs-chip-bg: #1d2130 !important;
  --docs-copilot-bg-a: #221d3a !important;
  --docs-copilot-bg-b: #1a1d33 !important;
  --docs-swatch-outline: rgba(255, 255, 255, 0.25) !important;
  --docs-swatch-outline-strong: rgba(255, 255, 255, 0.35) !important;
  --docs-swatch-border: #252a3b !important;
  --docs-scroll-thumb: #252a3b !important;
  --docs-tooltip-bg: #252a3b !important;
  --docs-tooltip-ink: #edeff5 !important;
  --docs-shimmer-base: #7a8297 !important;
  --docs-shimmer-hi: #edeff5 !important;
  --docs-statusbar-bg: #0e1016 !important;
  --docs-statusbar-border: #1d2130 !important;
  --docs-statusbar-hover: rgba(255, 255, 255, 0.05) !important;
  --docs-zoom-slider: #252a3b !important;
  --docs-ruler-bg: #151824 !important;
  --docs-ruler-tick: #7a8297 !important;
  --docs-ruler-border: #1d2130 !important;
  --docs-ruler-ink: #98a1b6 !important;
  --docs-ruler-btn-bg: #1d2130 !important;
  --docs-ruler-btn-hover: #252a3b !important;
  --docs-ruler-btn-border: #252a3b !important;
  --docs-ruler-btn-ink: #edeff5 !important;
  --docs-ruler-tab-guide: #7a8297 !important;
  --docs-ruler-zone: rgba(255, 255, 255, 0.10) !important;
  --docs-tstyle-border: #252a3b !important;
  --docs-tstyle-header: #98a1b6 !important;
  --docs-tstyle-row: #1d2130 !important;
  --docs-gap-cut: #7a8297 !important;
  --docs-pv-canvas: #08090d !important;
  --docs-overlay: rgba(6, 7, 10, 0.66) !important;
  /* one shadow scale and one easing, the same as the rest of Autora */
  --docs-page-shadow: 0 1px 3px rgba(0, 0, 0, 0.6), 0 4px 16px rgba(0, 0, 0, 0.4) !important;
  --docs-gap-inset: inset 0 8px 8px -8px rgba(0, 0, 0, 0.65), inset 0 -3px 3px -3px rgba(0, 0, 0, 0.4) !important;
  --docs-shadow-menu: 0 20px 48px -12px rgba(0, 0, 0, 0.7), 0 2px 8px rgba(0, 0, 0, 0.4) !important;
  --docs-shadow-ctx: 0 20px 48px -12px rgba(0, 0, 0, 0.7), 0 2px 8px rgba(0, 0, 0, 0.4) !important;
  --docs-shadow-modal: 0 20px 48px -12px rgba(0, 0, 0, 0.7) !important;
  --docs-shadow-modal-gs: 0 20px 48px -12px rgba(0, 0, 0, 0.7) !important;
  --docs-shadow-chip: 0 4px 16px -4px rgba(0, 0, 0, 0.5) !important;
  --docs-shadow-badge: 0 4px 16px -4px rgba(0, 0, 0, 0.5) !important;
  --docs-shadow-badge-strong: 0 20px 48px -12px rgba(0, 0, 0, 0.7) !important;
  --docs-shadow-tooltip: 0 4px 16px -4px rgba(0, 0, 0, 0.5) !important;
  --docs-shadow-composer: 0 20px 48px -12px rgba(0, 0, 0, 0.7) !important;
  --docs-shadow-toast: 0 20px 48px -12px rgba(0, 0, 0, 0.7) !important;
  --shadow-modal: 0 20px 48px -12px rgba(0, 0, 0, 0.7) !important;
}
`);

  // The person is in the document: said to the host every few seconds while they type, so the agent leaves it alone.
  if (framed && !headless) {
    let last = 0;
    const typing = () => {
      const now = Date.now();
      if (now - last < 4000) return;
      last = now;
      void host("presence", {}).catch(() => undefined);
    };
    document.addEventListener("input", typing, true);
    document.addEventListener("keydown", typing, true);
  }

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
