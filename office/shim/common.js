/*
 * What GenOffice's editors expect from the Electron app around them, supplied
 * by Autora instead. Runs first, as a plain script, in the editor's page.
 *
 * The page runs in one of two places and this file hides which:
 *   - in a sandboxed frame inside Autora (no origin of its own, so no network
 *     for its own files, no storage): the host is the page around the frame,
 *     reached by postMessage;
 *   - in headless Chromium on the server, which renders it to pictures and PDF:
 *     the host is a function the server exposes (window.__autoraHost).
 * Either way the editor sees one thing: `window.__autora.host(op, payload)`.
 */
(() => {
  "use strict";

  // ---- storage: a frame with no origin has none, and throws when asked ----
  for (const name of ["localStorage", "sessionStorage"]) {
    let works = true;
    try { void window[name].length; } catch { works = false; }
    if (works) continue;
    const data = new Map();
    const store = {
      get length() { return data.size; },
      key: (i) => [...data.keys()][i] ?? null,
      getItem: (k) => (data.has(String(k)) ? data.get(String(k)) : null),
      setItem: (k, v) => { data.set(String(k), String(v)); },
      removeItem: (k) => { data.delete(String(k)); },
      clear: () => { data.clear(); },
    };
    try { Object.defineProperty(window, name, { value: store, configurable: true }); } catch { /* nothing more to do */ }
  }

  // Some of the editors' libraries ask for Node's `process`.
  if (typeof window.process === "undefined") window.process = { env: {}, platform: "linux", versions: {}, browser: true, nextTick: (f, ...a) => queueMicrotask(() => f(...a)) };

  // ---- the host ----
  const headless = typeof window.__autoraHeadless !== "undefined" || typeof window.__autoraHost === "function";
  const framed = !headless && window.parent !== window;
  const waiting = new Map();
  const pushes = new Map();
  let nextId = 1;

  function b64(buf) {
    const bytes = new Uint8Array(buf);
    let out = "";
    for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(out);
  }
  function unb64(text) {
    const bin = atob(text);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }

  /** Ask the host for something. `bytes` in the payload is an ArrayBuffer; a reply's `bytes` is one too. */
  async function host(op, payload) {
    const body = { ...(payload || {}) };
    if (headless) {
      if (body.bytes instanceof ArrayBuffer) { body.bytes64 = b64(body.bytes); delete body.bytes; }
      const reply = await window.__autoraHost(op, body);
      if (reply && typeof reply.bytes64 === "string") { reply.bytes = unb64(reply.bytes64); delete reply.bytes64; }
      return reply;
    }
    if (!framed) throw new Error("no host to ask");
    return await new Promise((resolve, reject) => {
      const id = nextId++;
      waiting.set(id, { resolve, reject });
      const transfer = body.bytes instanceof ArrayBuffer ? [body.bytes] : [];
      window.parent.postMessage({ type: "autora:office", id, op, payload: body }, "*", transfer);
    });
  }

  // ---- the editor's ipc, carried to the engine that holds its document ----
  // Arguments and answers hold buffers (pictures, workbooks); they travel as JSON with the bytes tagged.
  const TYPED = { Uint8Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array, Uint8ClampedArray };
  function enc(v) {
    if (v instanceof ArrayBuffer) return { $b: b64(v), t: "ArrayBuffer" };
    if (ArrayBuffer.isView(v)) return { $b: b64(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)), t: v.constructor.name };
    if (Array.isArray(v)) return v.map(enc);
    if (v && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v)) out[k] = enc(v[k]);
      return out;
    }
    return v;
  }
  function dec(v) {
    if (Array.isArray(v)) return v.map(dec);
    if (v && typeof v === "object") {
      if (typeof v.$b === "string") {
        const buf = unb64(v.$b);
        const T = TYPED[v.t];
        return T ? new T(buf) : buf;
      }
      const out = {};
      for (const k of Object.keys(v)) out[k] = dec(v[k]);
      return out;
    }
    return v;
  }
  const ipc = {
    invoke: async (channel, ...args) => dec(await host("ipc", { channel, args: enc(args) })),
    send: (channel, ...args) => { void host("ipc-send", { channel, args: enc(args) }).catch(() => undefined); },
    /** Pushes from the engine (webContents.send) arrive as host pushes named "ipc". */
    on: (channel, fn) => onPush("ipc", (m) => { if (m && m.channel === channel) fn({}, ...dec(m.args)); }),
  };

  /** Be told when the host pushes something (a new version of the document, the person's choice...). */
  function onPush(op, fn) {
    let set = pushes.get(op);
    if (!set) pushes.set(op, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }

  // The headless host has no postMessage: the server calls this to push.
  window.__autoraPush = (op, payload) => { for (const fn of pushes.get(op) ?? []) { try { fn(payload); } catch (e) { console.error(e); } } };

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const m = event.data;
    if (!m || typeof m !== "object") return;
    if (m.type === "autora:office-result") {
      const w = waiting.get(m.id);
      if (!w) return;
      waiting.delete(m.id);
      if (m.ok) w.resolve(m.value); else w.reject(new Error(String(m.error ?? "the host refused")));
    } else if (m.type === "autora:office-push") {
      for (const fn of pushes.get(m.op) ?? []) { try { fn(m.payload); } catch (e) { console.error(e); } }
    }
  });

  // ---- fonts: the page cannot fetch its own files, so the host sends them ----
  async function loadFonts() {
    const node = document.getElementById("autora-fonts");
    if (!node) return;
    let faces = [];
    try { faces = JSON.parse(node.textContent || "[]"); } catch { return; }
    // Many families name the same file (Arial, Helvetica and Liberation Sans): fetched once.
    const files = new Map();
    const bytesOf = (file) => {
      if (!files.has(file)) files.set(file, host("asset", { name: file }).then((r) => (r && r.bytes) || null).catch(() => null));
      return files.get(file);
    };
    await Promise.all(faces.map(async (f) => {
      try {
        const bytes = await bytesOf(f.file);
        if (!bytes) return;
        const face = new FontFace(f.family, bytes.slice(0), {
          weight: f.weight, style: f.style, ...(f.range ? { unicodeRange: f.range } : {}),
        });
        await face.load();
        document.fonts.add(face);
      } catch (e) { console.warn("font", f.file, String(e)); }
    }));
  }

  // Autora's agent is the assistant: the editor's own AI panel, its one-click AI actions and the AI
  // group on the Home tab are left out. The chat beside the document is where to ask.
  const style = document.createElement("style");
  // The panel, its edge button, and the bar over a slide; the Home tab's AI group goes with them.
  style.textContent = ".ai-dock, .ai-rail, .stage-ai-bar, .expand-copilot { display: none !important; } .ai-entry { display: none !important; } [data-autora-hidden] { display: none !important; }";
  document.head.appendChild(style);
  // The ribbon's other AI buttons (Editor, Translate, Spelling, Resolve Comments, Revision Summary, the AI
  // panel's toggle) all send their prompt to the panel hidden above, so they would do nothing: they go too,
  // and a group left with nothing in it goes with them (and the divider before it). Matched by the tip each
  // one carries. The pinned GenOffice never changes (office/PIN.json), so these strings are stable.
  const DEAD_AI = '[data-tip*="Uses AI and consumes credits"], [data-tip^="AI "], [data-tip="Show/hide the AI panel"], [data-tip*="with AI"], .ai-entry';
  const dropDeadAi = () => {
    for (const el of document.querySelectorAll(DEAD_AI)) {
      (el.closest(".rb-split-wrap") || el).setAttribute("data-autora-hidden", "");
    }
    for (const group of document.querySelectorAll(".ribbon-group:not([data-autora-hidden])")) {
      const controls = group.querySelectorAll("button, select, input, [role=button]");
      if (!controls.length || ![...controls].every((c) => c.closest("[data-autora-hidden]"))) continue;
      group.setAttribute("data-autora-hidden", "");
      const before = group.previousElementSibling;
      if (before && before.classList.contains("ribbon-sep")) before.setAttribute("data-autora-hidden", "");
    }
  };
  /* The ribbon's own AI group (Word's, Excel's and PowerPoint's first group on Home) is gone altogether: Autora is the
     chat beside the document, not a button in the ribbon, and a document tool does not begin with an assistant's name. */
  const adopt = dropDeadAi;
  new MutationObserver(adopt).observe(document.documentElement, { childList: true, subtree: true });

  // ---- the Autora look ------------------------------------------------------------------
  // The interface the person works in should be Autora's, not GenOffice's. Each editor keeps
  // its whole chrome in tokens -- packages/ui/src/tokens.css (surface / text / border / …),
  // the per-app --accent, and the app's own --docs-* / --sheets-* / --slides-* shades -- so
  // the chrome is re-pointed here, once, for all three editors, instead of restyled selector
  // by selector. The values are Autora's own (src/styles.css: --s1…--s4, --sink, --text /
  // --text-2 / --text-3, --accent, --live, --warn, --danger, the shadows and --ease), and
  // the radii need no changing: 6 / 8 / 12 / 16 are already both suites'.
  //
  // Nothing of the document moves: the page, the grid, the slide and any export draw from
  // their own paper colours, and a headless render keeps the editor's plain chrome, so what is
  // exported is unchanged. Each app's shim adds its own --<app>-* shades through addStyle().
  const AUTORA_TOKENS = `
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
  /* states */
  --hover: #151824 !important;
  --pressed: #1d2130 !important;
  --active-bg: #252a3b !important;
  --bg-hover: #151824 !important;
  --bg-hover-subtle: #151824 !important;
  --bg-hover-strong: #1d2130 !important;
  --bg-hover-accent: rgba(110, 91, 255, 0.14) !important;
  /* accent: Autora's violet, in place of Word's blue / Excel's green / PowerPoint's orange */
  --accent: #6e5bff !important;
  --accent-dark: #5a48e8 !important;
  --accent-soft: rgba(110, 91, 255, 0.14) !important;
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
  --success: #34d399 !important;
  --success-bg: rgba(52, 211, 153, 0.12) !important;
  --success-border: rgba(52, 211, 153, 0.3) !important;
  /* shadows and motion: --shadow --shadow-lg and --ease */
  --shadow-menu: 0 20px 48px -12px rgba(0, 0, 0, 0.7), 0 2px 8px rgba(0, 0, 0, 0.4) !important;
  --shadow-modal-strong: 0 20px 48px -12px rgba(0, 0, 0, 0.7) !important;
  --shadow-btn-hover: 0 4px 16px -4px rgba(0, 0, 0, 0.5) !important;
  --color-bg-overlay: rgba(6, 7, 10, 0.66) !important;
  --transition-fast: 150ms cubic-bezier(0.32, 0.72, 0, 1) !important;
  --transition-medium: 240ms cubic-bezier(0.32, 0.72, 0, 1) !important;
  color-scheme: dark !important;
}
/* Autora's type, everywhere in the chrome; the document is drawn with its own fonts. */
body, #root, .app { font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif !important; }
::selection { background: rgba(110, 91, 255, 0.35); }
`;

  /** Add (or replace) a stylesheet in the editor's page. A headless render gets none, so an
   *  export is drawn with the editor's plain chrome. */
  function addStyle(id, css) {
    if (headless) return;
    const have = document.getElementById(id);
    if (have) { have.textContent = css; return; }
    const node = document.createElement("style");
    node.id = id;
    node.textContent = css;
    document.head.appendChild(node);
  }
  addStyle("autora-tokens", AUTORA_TOKENS);

  window.__autora = { host, onPush, headless, framed, b64, unb64, ipc, enc, dec, addStyle };
  // The editor's own script waits for this before it starts (see office/vite).
  window.__autoraReady = (async () => { try { await loadFonts(); } catch (e) { console.warn(String(e)); } })();
})();
