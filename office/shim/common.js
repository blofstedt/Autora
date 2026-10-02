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

  /** Be told when the host pushes something (a new version of the document, the person's choice...). */
  function onPush(op, fn) {
    let set = pushes.get(op);
    if (!set) pushes.set(op, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }

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

  // Autora's agent is the assistant: the editor's own AI entries and panel are left out.
  const style = document.createElement("style");
  style.textContent = ".ribbon-group:has(.ai-entry), .ai-dock, .ai-rail { display: none !important; }";
  document.head.appendChild(style);

  window.__autora = { host, onPush, headless, framed, b64, unb64 };
  // The editor's own script waits for this before it starts (see office/vite).
  window.__autoraReady = (async () => { try { await loadFonts(); } catch (e) { console.warn(String(e)); } })();
})();
