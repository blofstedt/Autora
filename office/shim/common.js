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

  // Autora's agent is the assistant: the editor's own AI panel and one-click AI actions are
  // left out, and its Genspark AI slot on the Home tab becomes one button that puts the
  // cursor in Autora's chat box.
  const style = document.createElement("style");
  // The panel, its edge button, and the bar over a slide; the Home tab's AI group becomes the one button below.
  style.textContent = ".ai-dock, .ai-rail, .stage-ai-bar { display: none !important; } .ribbon-group:has(.ai-entry) .ai-entry:not(.autora-ask) { display: none !important; }";
  document.head.appendChild(style);
  const MARK = '<svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 21 20H3z" fill="#8b7cf6"/></svg>';
  const adopt = () => {
    for (const group of document.querySelectorAll(".ribbon-group")) {
      const entries = group.querySelectorAll(".ai-entry");
      if (!entries.length) continue;
      const first = entries[0];
      if (!first.classList.contains("autora-ask")) {
        first.classList.add("autora-ask");
        first.classList.remove("active");
        first.setAttribute("data-tip", "Ask Autora in the chat");
        first.addEventListener("click", (e) => { e.stopImmediatePropagation(); e.preventDefault(); void host("ask", {}).catch(() => undefined); }, true);
      }
      // Word and PowerPoint draw the icon in .rb-big-icon and the name in a span; Excel in .tool-icon-row and <strong>.
      const icon = first.querySelector(".rb-big-icon, .tool-icon-row");
      const label = first.querySelector("strong") || first.querySelector(":scope > span:not(.rb-big-icon):not(.tool-icon-row)");
      if (icon && !icon.querySelector("[data-autora]")) icon.innerHTML = '<span data-autora="1">' + MARK + "</span>";
      if (label && label.textContent !== "Autora") label.textContent = "Autora";
      const name = group.querySelector(".ribbon-group-label");
      if (name && name.textContent !== "Autora") name.textContent = "Autora";
      if (group.getAttribute("aria-label") && group.getAttribute("aria-label") !== "Autora") group.setAttribute("aria-label", "Autora");
    }
  };
  new MutationObserver(adopt).observe(document.documentElement, { childList: true, subtree: true });

  window.__autora = { host, onPush, headless, framed, b64, unb64, ipc, enc, dec };
  // The editor's own script waits for this before it starts (see office/vite).
  window.__autoraReady = (async () => { try { await loadFonts(); } catch (e) { console.warn(String(e)); } })();
})();
