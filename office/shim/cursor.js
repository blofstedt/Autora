/*
 * Where things are in the editor, and what the agent does there, for the cursor.
 *
 * The cursor itself is drawn by the page around the frame (src/components/OfficeCursor.tsx), with the same human
 * motion as the browser's pointer. It cannot see inside this frame, which has no origin, so it asks here: "where is
 * this text, this cell?" and, for the things an editor can take, "put it there and type this".
 *
 * Only the editor's own answer is used. A place it cannot confirm is reported as nothing, and the cursor does not
 * go there at all: an invented position is worse than no cursor (the person asked for this). A cell is confirmed by
 * the editor's own name box saying which cell the click landed on; a piece of text by the element holding it.
 *
 * Nothing here commits anything: a click only selects, and the words typed go into the editor's own field and are
 * left with Escape, so the document keeps exactly what the agent's change made of it.
 *
 * Runs after common.js, as a plain script.
 */
(() => {
  "use strict";
  const A = window.__autora;
  if (!A || !A.framed) return;

  /* What this shim has been asked to do, for a test to read: how many places it could confirm, how many clicks and
     how many pieces of typing it did in the editor. */
  window.__autoraCursor = { located: 0, clicked: 0, typed: 0, refused: 0 };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

  /** Where the text in this element ends -- the end of its last line -- which is where a person typing it would be. */
  function endOf(el) {
    try {
      const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let last = null;
      for (let n = walk.nextNode(); n; n = walk.nextNode()) if (n.nodeValue && n.nodeValue.trim()) last = n;
      if (!last) return null;
      const range = document.createRange();
      range.setStart(last, last.nodeValue.length);
      range.setEnd(last, last.nodeValue.length);
      const rects = range.getClientRects();
      const r = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
      if (!r || (r.width === 0 && r.height === 0 && r.left === 0 && r.top === 0)) return null;
      return { x: r.right, y: r.top + r.height / 2 };
    } catch {
      return null;
    }
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

  /** The editor's zoom, as its status bar shows it ("56%"), as a number like 0.56; null when it shows none. */
  function zoom() {
    for (const el of document.querySelectorAll("span, b, i, div, button")) {
      if (el.children.length > 0) continue;
      const m = /^(\d{2,3})\s*%$/.exec(String(el.textContent || "").trim());
      if (!m) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 4 && visible(r)) return Number(m[1]) / 100;
    }
    return null;
  }

  /** Where the slide itself is. The editor's canvas is the whole stage -- the slide sits in the middle of it at the
   *  editor's zoom -- so a box given as fractions of the slide is placed on the slide, not on the stage. Without the
   *  slide's size or the zoom, the canvas is all there is to go by. */
  function slideRect(stage, slide) {
    if (!stage) return null;
    const z = zoom();
    if (!Array.isArray(slide) || slide.length !== 2 || !z) return stage;
    const w = (slide[0] * 96 / 72) * z;
    const h = (slide[1] * 96 / 72) * z;
    if (!(w > 20 && h > 20) || w > stage.width * 1.05 || h > stage.height * 1.05) return stage;
    const left = stage.left + (stage.width - w) / 2;
    const top = stage.top + (stage.height - h) / 2;
    return { left, top, width: w, height: h, right: left + w, bottom: top + h };
  }

  /** "B3" -> { col: 1, row: 2 }. */
  function addr(cell) {
    const m = /^\$?([A-Z]{1,3})\$?(\d+)$/.exec(String(cell || "").toUpperCase());
    if (!m) return null;
    let col = 0;
    for (const ch of m[1]) col = col * 26 + ch.charCodeAt(0) - 64;
    return { col: col - 1, row: Number(m[2]) - 1 };
  }

  // The measured layout of a workbook's default grid. It only ever picks the first point to click: nothing is drawn
  // unless the editor's own name box then says the click landed on the cell the agent meant.
  const GRID = { gutter: 46, band: 20, col: 69.3, row: 20 };

  /** The editor's own name box: the address it shows for what is selected. One of the few DOM parts of a canvas
   *  grid, and the only thing here that can say where a cell is. */
  function nameBox() {
    for (const el of document.querySelectorAll('input, textarea, [contenteditable="true"], span, b, i, div')) {
      if (el.children.length > 0) continue;
      const v = String(el.value ?? el.textContent ?? "").trim().toUpperCase();
      if (!/^\$?[A-Z]{1,3}\$?[0-9]{1,7}$/.test(v)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8 || !visible(r)) continue;
      const near = `${el.className || ""} ${el.parentElement ? el.parentElement.className || "" : ""}`;
      if (!chrome(el) && !/formula|name|address|reference|cell|input/i.test(near)) continue;
      return { el, value: v };
    }
    return null;
  }
  const selected = () => {
    const box = nameBox();
    return box ? box.value : null;
  };

  /** The field the editor takes keystrokes in, when it has one on screen (a cell's editor, a formula bar).
   *  Never a document's own editable text: typing there would change the file a second time, on top of the change
   *  the agent's tool already made. */
  function typingTarget() {
    const ok = (el) => Boolean(el) && (el.tagName === "INPUT" || el.tagName === "TEXTAREA") && !chrome(el);
    if (ok(document.activeElement)) return document.activeElement;
    for (const el of document.querySelectorAll('textarea, input[type="text"], input:not([type])')) {
      if (chrome(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 60 && r.height > 8 && visible(r)) return el;
    }
    return null;
  }

  /** A real click where the agent is working: the editor reacts as it does to a person's -- it selects the cell,
   *  puts the caret in the word, picks the shape up. Selecting changes nothing in the document. */
  function clickAt(x, y) {
    const el = document.elementFromPoint(x, y) || document.body;
    const o = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: 0, buttons: 1, pointerId: 1, pointerType: "mouse", isPrimary: true };
    try { el.dispatchEvent(new PointerEvent("pointerdown", o)); } catch { /* no PointerEvent here */ }
    el.dispatchEvent(new MouseEvent("mousedown", o));
    try { el.dispatchEvent(new PointerEvent("pointerup", Object.assign({}, o, { buttons: 0 }))); } catch { /* as above */ }
    el.dispatchEvent(new MouseEvent("mouseup", Object.assign({}, o, { buttons: 0 })));
    el.dispatchEvent(new MouseEvent("click", Object.assign({}, o, { buttons: 0 })));
    return el;
  }

  /** Type into the editor's own field, a character at a time, with the events a keyboard makes. */
  function typeInto(el, text) {
    for (const ch of text) {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true, cancelable: true, composed: true }));
      const before = String(el.value != null ? el.value : "");
      const after = before + ch;
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      // React keeps its own copy of a field's value: set it through the native setter so the editor notices.
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(el, after);
      el.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: ch, bubbles: true, composed: true }));
      el.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true, composed: true }));
    }
  }

  /** A cell's place, asked of the editor: click, and read the address its own name box shows for it. The measured
   *  grid picks the first point only; the address the editor answers with corrects it, and four tries is the end. */
  async function cellSpot(rc, from) {
    if (!nameBox()) return null; // nothing here can confirm a cell: the cursor is not sent to a guess
    let x = from.x;
    let y = from.y;
    for (let i = 0; i < 4; i++) {
      clickAt(x, y);
      await sleep(70);
      const got = addr(selected());
      if (!got) return null;
      if (got.col === rc.col && got.row === rc.row) return { x, y, at: selected() };
      x += (rc.col - got.col) * GRID.col;
      y += (rc.row - got.row) * GRID.row;
    }
    return null;
  }

  /** Where something is, or null -- and null means the cursor does not go there. */
  async function find(t) {
    const rc = t.cell ? addr(t.cell) : null;
    if (rc) {
      const r = mainCanvas();
      if (!r) return null;
      const x = r.left + GRID.gutter + rc.col * GRID.col + GRID.col / 2;
      const y = r.top + GRID.band + rc.row * GRID.row + GRID.row / 2;
      if (x + GRID.col / 2 > r.right || y + GRID.row / 2 > r.bottom) return null;
      const hit = await cellSpot(rc, { x, y });
      if (!hit) return null;
      return { x: hit.x - GRID.col / 2, y: hit.y - GRID.row / 2, w: GRID.col, h: GRID.row, size: 13, family: "Calibri, Arial, sans-serif", color: "#ffffff", bg: "#1f2023", weight: "400", at: hit.at };
    }
    if (Array.isArray(t.box) && t.box.length === 4) {
      const r = slideRect(mainCanvas(), t.slide);
      if (!r) return null;
      const [fx, fy, fw, fh] = t.box;
      const h = fh * r.height;
      return { x: r.left + fx * r.width, y: r.top + fy * r.height, w: fw * r.width, h, size: Math.max(12, Math.min(34, h * 0.55)), family: "Calibri, Arial, sans-serif", color: "#111111", bg: "#ffffff", weight: "400" };
    }
    const el = byText(t.text);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height, at: el.tagName.toLowerCase(), end: endOf(el), ...look(el) };
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const m = event.data;
    if (!m || typeof m !== "object") return;

    if (m.type === "autora:office-locate" && Array.isArray(m.targets)) {
      const until = Date.now() + Math.min(8000, Math.max(0, Number(m.wait) || 0));
      const attempt = async () => {
        const rects = await Promise.all(m.targets.slice(0, 12).map((t) => find(t).catch(() => null)));
        window.__autoraCursor.located = rects.filter(Boolean).length;
        if (!rects.some(Boolean)) window.__autoraCursor.refused++;
        // The document may still be opening: keep looking until the first thing is found, or time is up.
        if (!rects.some(Boolean) && Date.now() < until) { setTimeout(attempt, 250); return; }
        void A.host("located", { id: m.id, rects, view: { w: window.innerWidth, h: window.innerHeight } }).catch(() => undefined);
      };
      void attempt();
      return;
    }

    /* What the agent does in the editor. The answer says what the editor itself did about it: the address its name
       box shows after a click, and whether it had a field to take the words in. */
    if (m.type === "autora:office-act") {
      void (async () => {
        let out = { id: m.id, ok: false };
        if (m.act === "click" && Number.isFinite(m.x) && Number.isFinite(m.y)) {
          const el = clickAt(m.x, m.y);
          window.__autoraCursor.clicked++;
          // A click made by script cannot move the browser's own caret -- only a person's pointer does that -- so the
          // editor's selection is put where the agent worked by hand. It is the editor's own selection model, and the
          // person sees it as the editor draws it. Only for a piece of text (not a whole page, not a canvas).
          const host = el && el.closest ? el.closest('[contenteditable="true"]') : null;
          const words = el ? String(el.textContent || "") : "";
          if (host && words.length > 0 && words.length < 400) {
            try {
              const r = document.createRange();
              r.selectNodeContents(el);
              const s = window.getSelection();
              s.removeAllRanges();
              s.addRange(r);
            } catch { /* not selectable */ }
          }
          await sleep(60);
          out = { id: m.id, ok: true, at: selected() };
        } else if (m.act === "type" && typeof m.text === "string") {
          const el = typingTarget();
          if (el) {
            try { el.focus(); } catch { /* not focusable */ }
            typeInto(el, m.text);
            window.__autoraCursor.typed++;
            out = { id: m.id, ok: true, field: String(el.tagName).toLowerCase(), text: String(el.value != null ? el.value : el.textContent || "").slice(-80) };
          }
        } else if (m.act === "end") {
          // Out of any edit made here, so the document keeps what the agent's change made of it.
          const el = typingTarget() || document.activeElement || document.body;
          const o = { key: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true, composed: true };
          el.dispatchEvent(new KeyboardEvent("keydown", o));
          el.dispatchEvent(new KeyboardEvent("keyup", o));
          out = { id: m.id, ok: true };
        }
        void A.host("acted", out).catch(() => undefined);
      })();
    }
  });
})();
