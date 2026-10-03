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
    if (!document.body) return null;
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

  /** The editor's main drawing surface: the biggest canvas that is on screen (a deck's slide, a workbook's grid). */
  function mainCanvas() {
    let best = null;
    let area = 0;
    for (const c of document.querySelectorAll("canvas")) {
      const r = c.getBoundingClientRect();
      if (r.left < -50 || r.top < -50 || !visible(r)) continue;
      if (r.width * r.height > area) { area = r.width * r.height; best = r; }
    }
    return best;
  }

  /** "B3" -> { col: 1, row: 2 }. */
  function addr(cell) {
    const m = /^\$?([A-Z]{1,3})\$?(\d+)$/.exec(String(cell || "").toUpperCase());
    if (!m) return null;
    let col = 0;
    for (const ch of m[1]) col = col * 26 + ch.charCodeAt(0) - 64;
    return { col: col - 1, row: Number(m[2]) - 1 };
  }

  // The workbook's grid is drawn on a canvas, so a cell has no element to ask. Its default layout is measured
  // from the editor itself: a row-number gutter, a column-letter band, default-size cells. A sheet whose columns
  // were resized puts the cursor a little off, and a cell out of view is not pointed at.
  const GRID = { gutter: 46, band: 20, col: 69.3, row: 20 };

  function find(t) {
    const rc = t.cell ? addr(t.cell) : null;
    if (rc) {
      const r = mainCanvas();
      if (r) {
        const x = r.left + GRID.gutter + rc.col * GRID.col;
        const y = r.top + GRID.band + rc.row * GRID.row;
        if (x + GRID.col <= r.right && y + GRID.row <= r.bottom) {
          return { x, y, w: GRID.col, h: GRID.row, size: 13, family: "Calibri, Arial, sans-serif", color: "#ffffff", bg: "#1f2023", weight: "400" };
        }
      }
    }
    if (Array.isArray(t.box) && t.box.length === 4) {
      const r = mainCanvas();
      if (r) {
        const [fx, fy, fw, fh] = t.box;
        const h = fh * r.height;
        return { x: r.left + fx * r.width, y: r.top + fy * r.height, w: fw * r.width, h, size: Math.max(12, Math.min(34, h * 0.55)), family: "Calibri, Arial, sans-serif", color: "#111111", bg: "#ffffff", weight: "400" };
      }
    }
    const el = byText(t.text);
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
