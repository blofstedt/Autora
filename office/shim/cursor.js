/*
 * Where things are in the editor, for the agent's cursor.
 *
 * The cursor itself is drawn by the page around the frame (src/components/OfficeCursor.tsx), with
 * the same human motion as the browser's pointer. It cannot see inside this frame, which has no
 * origin, so it asks here: "where is this text, this cell?" and gets back boxes in the frame's own
 * pixels. Only answers; it changes nothing in the editor. Runs after common.js, as a plain script.
 */
(() => {
  "use strict";
  const A = window.__autora;
  if (!A || !A.framed) return;

  const norm = (t) => String(t || "").replace(/\s+/g, " ").trim().toLowerCase();
  const visible = (r) => r.width > 2 && r.height > 2 && r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
  // The editors' own chrome (ribbon, tabs, side panels) also holds words; the document is not in it.
  const chrome = (el) => Boolean(el.closest('[class*="ribbon"], [role="toolbar"], [role="menubar"], [role="tablist"], nav, header, [class*="statusbar"], [class*="status-bar"]'));

  function byText(text) {
    const needle = norm(text).slice(0, 40);
    if (needle.length < 2) return null;
    const hits = [];
    for (const el of document.body.querySelectorAll("*")) {
      if (el.tagName === "SCRIPT" || el.tagName === "STYLE" || el.tagName === "IFRAME") continue;
      if (!norm(el.textContent).includes(needle)) continue;
      hits.push(el);
    }
    // The deepest ones: an element is a hit only when none of its children holds the words too.
    const deepest = hits.filter((el) => !hits.some((o) => o !== el && el.contains(o)));
    for (const el of deepest) {
      if (chrome(el)) continue;
      if (visible(el.getBoundingClientRect())) return el;
    }
    return null;
  }

  // What the words look like there, so the typed words can be drawn the same way over them.
  function look(el) {
    const st = getComputedStyle(el);
    let bg = "";
    for (let n = el; n && !bg; n = n.parentElement) {
      const c = getComputedStyle(n).backgroundColor;
      if (c && !/^rgba\(\s*0,\s*0,\s*0,\s*0\s*\)$|^transparent$/.test(c)) bg = c;
    }
    return { size: parseFloat(st.fontSize) || 14, family: st.fontFamily, color: st.color, bg: bg || "#ffffff", weight: st.fontWeight };
  }

  function find(t) {
    let el = null;
    if (t.cell) {
      const c = String(t.cell).toUpperCase();
      for (const sel of [`[data-cell="${c}"]`, `[data-ref="${c}"]`, `[data-address="${c}"]`, `[data-addr="${c}"]`, `[aria-label="${c}"]`, `[title="${c}"]`]) {
        const e = document.querySelector(sel);
        if (e && visible(e.getBoundingClientRect())) { el = e; break; }
      }
    }
    if (!el) el = byText(t.text);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height, ...look(el) };
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const m = event.data;
    if (!m || typeof m !== "object" || m.type !== "autora:office-locate" || !Array.isArray(m.targets)) return;
    const until = Date.now() + Math.min(8000, Math.max(0, Number(m.wait) || 0));
    const attempt = () => {
      const rects = m.targets.slice(0, 12).map(find);
      // The document may still be opening: keep looking until the first thing is found, or time is up.
      if (!rects.some(Boolean) && Date.now() < until) { setTimeout(attempt, 250); return; }
      void A.host("located", { id: m.id, rects, view: { w: window.innerWidth, h: window.innerHeight } }).catch(() => undefined);
    };
    attempt();
  });
})();
