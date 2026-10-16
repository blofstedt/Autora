/*
 * The agent's hand in Pages, Sheets and Slides (Visible work: docs/VISIBLE-WORK.md; server/officehand.ts).
 *
 * With Visible work on, what the agent's office_edit changes in the words is typed here, live, as a person types it,
 * while the tool call waits: its cursor (its colour, its name) goes to the place, the words that change are selected
 * and typed over a key at a time, through the editor's own editing -- the browser's insert-text command into the
 * editor's own text surface (Pages' page, a slide's text box, a cell's editor), and the editor's own keys for a new or
 * removed paragraph. A cell is gone to by its address in the name box, as a person types B12 there, and confirmed with
 * the formula bar's tick. A slide's box is opened with a double-click on it and left with Escape.
 *
 * When the hand is done the window is given the file the operations made (office.ts), so what is not typing (styles,
 * tables, pictures) appears then; the hand never pretends to do those.
 *
 * Runs after common.js, as a plain script, in every editor.
 */
(() => {
  "use strict";
  const A = window.__autora;
  if (!A || !A.framed) return;
  const APP = /\/(docs|slides|sheets)\//.exec(location.pathname)?.[1] ?? "";

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (lo, hi) => lo + Math.random() * (hi - lo);
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
  const norm = (t) => String(t ?? "").replace(/\s+/g, " ").trim();

  // ---------------------------------------------------------------- the cursor --

  let cursor = null;
  let at = { x: innerWidth * 0.5, y: innerHeight * 0.4 };
  let told = 0;

  function showCursor(who) {
    if (cursor) cursor.remove();
    const color = /^#[0-9a-f]{6}$/i.test(who?.color ?? "") ? who.color : "#6e5bff";
    const el = document.createElement("div");
    el.setAttribute("aria-hidden", "true");
    el.dataset.autoraHand = "";
    el.style.cssText = "position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;will-change:transform";
    el.innerHTML =
      `<svg width="20" height="22" viewBox="0 0 20 22" style="display:block;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))">` +
      `<path d="M1 1 L1 18 L5.6 14.2 L8.6 21 L11.2 19.9 L8.3 13.4 L13.6 13.4 Z" fill="${color}" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>` +
      `<span style="position:absolute;left:15px;top:19px;padding:2px 7px;border-radius:7px;background:${color};color:#fff;font:600 11px/1.3 system-ui,sans-serif;white-space:nowrap"></span>`;
    el.querySelector("span").textContent = String(who?.name || "Autora").slice(0, 24);
    document.body.appendChild(el);
    cursor = el;
    place(at.x, at.y);
  }
  function hideCursor() {
    const el = cursor;
    cursor = null;
    if (el) setTimeout(() => el.remove(), 1200);
  }
  function place(x, y) {
    at = { x, y };
    if (cursor) cursor.style.transform = `translate(${x}px, ${y}px)`;
    const now = performance.now();
    if (now - told > 70) {
      told = now;
      void A.host("hand-cursor", { x, y }).catch(() => undefined);
    }
  }

  // ------------------------------------------------------------------ the hand --

  const under = (x, y) => document.elementFromPoint(x, y) || document.body;
  function fire(target, type, x, y, down, extra) {
    const init = Object.assign({ bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, screenX: x, screenY: y, button: 0, buttons: down ? 1 : 0 }, extra || {});
    if (type.startsWith("pointer")) target.dispatchEvent(new PointerEvent(type, Object.assign({ pointerId: 7, pointerType: "mouse", isPrimary: true }, init)));
    else target.dispatchEvent(new MouseEvent(type, init));
  }

  /** Move there as a hand does: an arc, faster in the middle; the editor sees every step of it. */
  async function glide(x, y) {
    const from = Object.assign({}, at);
    const dx = x - from.x, dy = y - from.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1) return;
    const ms = 260 + 115 * Math.log2(1 + dist / 24);
    const side = Math.random() < 0.5 ? -1 : 1;
    const bend = { x: from.x + dx / 2 - (dy / dist) * dist * 0.12 * side, y: from.y + dy / 2 + (dx / dist) * dist * 0.12 * side };
    const start = performance.now();
    for (;;) {
      await frame();
      const t = Math.min(1, (performance.now() - start) / ms);
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      const ax = from.x + (bend.x - from.x) * e, ay = from.y + (bend.y - from.y) * e;
      const bx = bend.x + (x - bend.x) * e, by = bend.y + (y - bend.y) * e;
      const px = ax + (bx - ax) * e, py = ay + (by - ay) * e;
      place(px, py);
      const target = under(px, py);
      fire(target, "pointermove", px, py, false);
      fire(target, "mousemove", px, py, false);
      if (t >= 1) return;
    }
  }

  /** A click (or a double-click) on what is really under the point. */
  async function click(x, y, count) {
    await glide(x, y);
    await sleep(rand(60, 140));
    const target = under(x, y);
    for (let n = 1; n <= (count || 1); n++) {
      fire(target, "pointerdown", x, y, true);
      fire(target, "mousedown", x, y, true, { detail: n });
      await sleep(rand(40, 80));
      fire(target, "pointerup", x, y, false);
      fire(target, "mouseup", x, y, false, { detail: n });
      fire(target, "click", x, y, false, { detail: n });
      if (n === 2) fire(target, "dblclick", x, y, false, { detail: 2 });
      await sleep(rand(50, 90));
    }
    await sleep(rand(120, 200));
    return target;
  }

  function key(target, k, mods) {
    const code = k.length === 1 ? `Key${k.toUpperCase()}` : k;
    const keyCode = { Enter: 13, Escape: 27, Backspace: 8, Delete: 46, Tab: 9 }[k] ?? (k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0);
    const init = Object.assign({ key: k, code, keyCode, which: keyCode, bubbles: true, cancelable: true, composed: true }, mods || {});
    const down = new KeyboardEvent("keydown", init);
    target.dispatchEvent(down);
    target.dispatchEvent(new KeyboardEvent("keyup", init));
    return down.defaultPrevented;
  }

  /** Words typed where the editor's selection is, a key at a time, through the browser's own editing. */
  async function typeText(text) {
    for (const ch of Array.from(text)) {
      if (ch === "\n") document.execCommand("insertParagraph");
      else document.execCommand("insertText", false, ch);
      await sleep(rand(45, 110));
    }
  }

  /** The text of an element as the document has it -- a block boundary inside it is a line break -- with each
      piece's text node, so a stretch of the text can be selected. */
  function textMap(el) {
    const parts = [];
    let text = "";
    const walk = (node, first) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) {
          parts.push({ node: child, start: text.length });
          text += child.data;
        } else if (child.nodeType === 1) {
          const block = /^(P|DIV|H[1-6]|LI)$/.test(child.tagName);
          if (child.tagName === "BR") { text += "\n"; continue; }
          if (block && text.length > 0 && !first) text += "\n";
          walk(child, false);
        }
      }
    };
    walk(el, true);
    return { text, parts };
  }
  function point(map, offset) {
    for (let i = map.parts.length - 1; i >= 0; i--) {
      const p = map.parts[i];
      if (p.start <= offset) return [p.node, Math.min(p.node.data.length, offset - p.start)];
    }
    return map.parts.length ? [map.parts[0].node, 0] : null;
  }
  /** Select [from, to) of an element's text with the editor's own selection, as a drag over the words makes it. */
  async function selectSpan(el, from, to) {
    const map = textMap(el);
    const a = point(map, from), b = point(map, to);
    if (!a || !b) return false;
    const range = document.createRange();
    range.setStart(a[0], a[1]);
    range.setEnd(b[0], b[1]);
    const rects = range.getClientRects();
    const first = rects[0] ?? range.getBoundingClientRect();
    const last = rects[rects.length - 1] ?? first;
    if (first && first.width + first.height > 0) await glide(first.left, first.top + first.height / 2);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(range);
    if (last && to > from) await glide(last.right, last.top + last.height / 2);
    await sleep(rand(120, 220));
    return true;
  }
  /** The shortest stretch that differs: what a person selects to type over, keeping the words around it. */
  function spanOf(was, now) {
    let p = 0;
    while (p < was.length && p < now.length && was[p] === now[p]) p++;
    let q = 0;
    while (q < was.length - p && q < now.length - p && was[was.length - 1 - q] === now[now.length - 1 - q]) q++;
    return { from: p, to: was.length - q, text: now.slice(p, now.length - q) };
  }

  function scroller(el) {
    let s = el.parentElement;
    while (s && !(s.scrollHeight > s.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(s).overflowY))) s = s.parentElement;
    return s;
  }
  /** Bring an element into view the way a wheel does: smoothly, never a jump. */
  async function scrollTo(el) {
    const s = scroller(el);
    const r = el.getBoundingClientRect();
    const top = s ? s.getBoundingClientRect().top : 0;
    const height = s ? s.clientHeight : innerHeight;
    if (r.top > top + 40 && r.bottom < top + height - 40) return;
    if (!s) { el.scrollIntoView({ block: "center" }); await sleep(300); return; }
    const by = r.top - (top + height * 0.35);
    const from = s.scrollTop;
    const ms = Math.min(900, 250 + Math.abs(by) * 0.4);
    const start = performance.now();
    for (;;) {
      await frame();
      const t = Math.min(1, (performance.now() - start) / ms);
      s.scrollTop = from + by * (1 - Math.pow(1 - t, 3));
      if (t >= 1) break;
    }
    await sleep(120);
  }

  async function waitFor(find, ms) {
    const end = performance.now() + (ms || 2500);
    for (;;) {
      const got = find();
      if (got) return got;
      if (performance.now() > end) return null;
      await sleep(60);
    }
  }

  // --------------------------------------------------------------------- Pages --

  const page = () => document.querySelector('.ProseMirror[contenteditable="true"]');
  /** A paragraph by its words: the one nearest the place it had, among those that say exactly that. */
  function paragraph(text, near) {
    const root = page();
    if (!root) return null;
    const want = norm(text);
    const hits = [...root.querySelectorAll("[data-idx]")].filter((el) => norm(textMap(el).text) === want);
    if (hits.length === 0) return null;
    hits.sort((a, b) => Math.abs(Number(a.dataset.idx) - near) - Math.abs(Number(b.dataset.idx) - near));
    return hits[0];
  }

  async function pagesStep(step, current) {
    const root = page();
    if (!root) throw new Error("the page is not open");
    root.focus();
    if (step.kind === "para") {
      const el = paragraph(step.was, step.at);
      if (!el) throw new Error("the paragraph is not on the page");
      await scrollTo(el);
      const span = spanOf(textMap(el).text, step.now);
      await selectSpan(el, span.from, span.to);
      if (span.text) await typeText(span.text);
      else document.execCommand("delete");
      current.set(step.at, step.now);
      return;
    }
    if (step.kind === "insert") {
      if (step.after < 0) {
        const first = root.querySelector("[data-idx]");
        if (!first) throw new Error("the page is empty");
        await scrollTo(first);
        await selectSpan(first, 0, 0);
        await typeText(step.text);
        key(root, "Enter");
        return;
      }
      const el = paragraph(current.get(step.after) ?? step.anchor, step.after);
      if (!el) throw new Error("the paragraph before it is not on the page");
      await scrollTo(el);
      const len = textMap(el).text.length;
      await selectSpan(el, len, len);
      const count = root.querySelectorAll("[data-idx]").length;
      if (!key(root, "Enter")) document.execCommand("insertParagraph");
      await sleep(rand(150, 250));
      if (root.querySelectorAll("[data-idx]").length <= count) document.execCommand("insertParagraph");
      await typeText(step.text);
      return;
    }
    if (step.kind === "remove") {
      const el = paragraph(current.get(step.at) ?? step.was, step.at);
      if (!el) throw new Error("the paragraph is not on the page");
      await scrollTo(el);
      await selectSpan(el, 0, textMap(el).text.length);
      document.execCommand("delete");
      await sleep(rand(120, 200));
      // The empty paragraph left goes too, as Backspace takes it.
      if (!key(root, "Backspace")) document.execCommand("delete");
      return;
    }
    throw new Error(`Pages does not type a ${step.kind}`);
  }

  // -------------------------------------------------------------------- Sheets --

  function nameBox() {
    for (const el of document.querySelectorAll("input")) {
      if (!/^\$?[A-Z]{1,3}\$?[0-9]{1,7}$/.test(String(el.value || "").trim().toUpperCase())) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 20 && r.height > 8) return el;
    }
    return null;
  }
  const centre = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };

  /** The formula bar's tick: what a person clicks to put a cell's new contents in. */
  function tick() {
    const box = nameBox();
    if (!box) return null;
    const row = box.getBoundingClientRect();
    const candidates = [...document.querySelectorAll("button, [role=button], span, div")].filter((el) => {
      if (!el.querySelector("svg") && el.tagName !== "svg") return false;
      const r = el.getBoundingClientRect();
      return r.width > 6 && r.width < 40 && r.height > 6 && r.height < 40 && Math.abs((r.top + r.height / 2) - (row.top + row.height / 2)) < 14 && r.left > row.right;
    });
    candidates.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    // Its icons in order: the name box's own drop-down, cancel (x), confirm (tick), then the function button.
    const unique = candidates.filter((el, i) => !candidates.some((o, j) => j < i && Math.abs(o.getBoundingClientRect().left - el.getBoundingClientRect().left) < 4));
    return unique.length >= 3 ? unique[unique.length - 2] : null;
  }

  async function sheetTab(name) {
    const tabs = [...document.querySelectorAll("span, div, button")].filter((el) => el.children.length === 0 && norm(el.textContent) === name && el.getBoundingClientRect().top > innerHeight * 0.7);
    if (tabs.length === 0) return;
    const p = centre(tabs[0]);
    await click(p.x, p.y);
  }

  async function goToCell(ref) {
    // A window brought to the front a moment ago is still laying its editor out.
    const box = await waitFor(nameBox, 6000);
    if (!box) throw new Error("the name box is not on screen");
    if (String(box.value).trim().toUpperCase() === ref) return;
    const p = centre(box);
    await click(p.x, p.y);
    box.focus();
    box.select();
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    let v = "";
    for (const ch of ref) {
      v += ch;
      set.call(box, v);
      box.dispatchEvent(new InputEvent("input", { bubbles: true, data: ch, inputType: "insertText" }));
      await sleep(rand(60, 110));
    }
    key(box, "Enter");
    const got = await waitFor(() => { const b = nameBox(); return b && String(b.value).trim().toUpperCase() === ref ? b : null; }, 1500);
    if (!got) throw new Error(`the name box did not go to ${ref}`);
    await sleep(rand(150, 250));
  }

  let sheetNow = "";
  async function sheetsStep(step) {
    if (step.kind !== "cell") throw new Error(`Sheets does not type a ${step.kind}`);
    if (sheetNow && step.sheet !== sheetNow) await sheetTab(step.sheet);
    sheetNow = step.sheet;
    await goToCell(step.ref);
    // The cell's own editor has the keyboard once the cell is selected.
    const editor = await waitFor(() => { const a = document.activeElement; return a && a.isContentEditable ? a : null; }, 1500);
    if (!editor) throw new Error("the cell did not take the keyboard");
    if (step.input === "") {
      if (!key(editor, "Delete")) key(editor, "Backspace");
      await sleep(200);
      return;
    }
    await typeText(step.input);
    await sleep(rand(150, 250));
    const ok = tick();
    if (ok) {
      const p = centre(ok);
      await click(p.x, p.y);
    } else {
      key(document.activeElement || editor, "Enter");
    }
    await sleep(rand(200, 300));
  }

  // -------------------------------------------------------------------- Slides --

  function stage() {
    let best = null;
    for (const c of document.querySelectorAll("canvas")) {
      const r = c.getBoundingClientRect();
      if (r.width < 2 || r.left < -50 || r.top < -50) continue;
      if (!best || r.width * r.height > best.width * best.height) best = r;
    }
    return best;
  }
  function zoom() {
    for (const el of document.querySelectorAll("span, b, i, div, button")) {
      if (el.children.length > 0) continue;
      const m = /^(\d{2,3})\s*%$/.exec(String(el.textContent || "").trim());
      if (m && el.getBoundingClientRect().width > 4) return Number(m[1]) / 100;
    }
    return null;
  }
  /** Where a point of the slide (in points from its top-left) is on screen: the slide sits in the middle of the
      editor's canvas at its zoom. */
  function onSlide(size, x, y) {
    const r = stage();
    const z = zoom();
    if (!r || !z) return null;
    const w = size[0] * 96 / 72 * z, h = size[1] * 96 / 72 * z;
    const left = r.left + (r.width - w) / 2, top = r.top + (r.height - h) / 2;
    return { x: left + (x / size[0]) * w, y: top + (y / size[1]) * h };
  }
  const slideEditor = () => { const a = document.activeElement; return a && a.classList && a.classList.contains("slide-text-editor") ? a : document.querySelector(".slide-text-editor"); };

  async function slideTo(n) {
    // The slide list beside the stage: its n-th picture, as a person clicks it.
    const label = [...document.querySelectorAll("span, div")].find((el) => el.children.length === 0 && new RegExp(`^Slide ${n} (/|of) `).test(String(el.textContent).trim()));
    if (label) return; // the status bar already says this slide is shown
    const thumbs = [...document.querySelectorAll("canvas, img")].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 40 && r.width < 320 && r.left < innerWidth * 0.3; });
    thumbs.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    const t = thumbs[n - 1];
    if (!t) throw new Error(`slide ${n} is not in the list`);
    t.scrollIntoView({ block: "nearest" });
    const p = centre(t);
    await click(p.x, p.y);
    await sleep(400);
  }

  async function slidesStep(step) {
    if (step.kind !== "box") throw new Error(`Slides does not type a ${step.kind}`);
    await slideTo(step.slide);
    const [x0, y0, x1, y1] = step.box;
    const p = onSlide(step.size, (x0 + x1) / 2, (y0 + y1) / 2);
    if (!p) throw new Error("the slide is not on screen");
    await click(p.x, p.y, 2);
    const editor = await waitFor(() => { const e = slideEditor(); return e && e.isContentEditable ? e : null; }, 2000);
    if (!editor) throw new Error("the box did not open for typing");
    editor.focus();
    const was = textMap(editor).text;
    const span = spanOf(was, step.now);
    await selectSpan(editor, span.from, span.to);
    if (span.text) await typeText(span.text);
    else document.execCommand("delete");
    await sleep(rand(200, 320));
    key(editor, "Escape");
    await sleep(rand(250, 400));
  }

  // ----------------------------------------------------------------- the edit --

  let busy = false;
  async function run(id, steps, who) {
    if (busy) { void A.host("handed", { id, results: [], error: "the editor is already doing an edit" }).catch(() => undefined); return; }
    busy = true;
    const results = [];
    const current = new Map();
    sheetNow = "";
    showCursor(who);
    try {
      for (let i = 0; i < steps.length; i++) {
        try {
          if (APP === "docs") await pagesStep(steps[i], current);
          else if (APP === "sheets") await sheetsStep(steps[i]);
          else if (APP === "slides") await slidesStep(steps[i]);
          else throw new Error("not an editor");
          results.push({ i, ok: true });
        } catch (err) {
          results.push({ i, ok: false, error: String(err && err.message || err) });
        }
      }
      void A.host("handed", { id, results }).catch(() => undefined);
    } catch (err) {
      void A.host("handed", { id, results, error: String(err && err.message || err) }).catch(() => undefined);
    } finally {
      busy = false;
      hideCursor();
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const m = event.data;
    if (m && typeof m === "object" && m.type === "autora:office-save") {
      // The window's Save: the editor's own Ctrl+S, as if pressed where the person is typing.
      const at = document.activeElement && document.activeElement !== document.body ? document.activeElement : document.body;
      at.dispatchEvent(new KeyboardEvent("keydown", { key: "s", code: "KeyS", ctrlKey: true, bubbles: true, cancelable: true }));
      return;
    }
    if (!m || typeof m !== "object" || m.type !== "autora:office-hand" || typeof m.id !== "string" || !Array.isArray(m.steps)) return;
    void run(m.id, m.steps, m.who || {});
  });
})();
