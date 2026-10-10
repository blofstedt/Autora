/*
 * The editors on a phone (the window adds ?phone=1 to the frame's address): the paired-down ones.
 *
 * GenOffice's editors are desktop programs: a ribbon of a hundred commands over a page. A phone gets the page, with
 * one bar at the bottom of what a thumb does while writing (undo, bold, italic, underline, a list, the size, zoom, a new
 * slide, a row) and a "More" that opens the real ribbon as a sheet for everything else. The bar presses the editor's own
 * buttons, found by the name each carries, so there is nothing here to keep in step with the editor but the names, and
 * no second implementation of bold. The ribbon's top row (File, save, tabs) and the status bar are away: Autora saves as
 * you go and the window's bar downloads. Nothing is removed from the editors: a desktop never loads this.
 */
(() => {
  "use strict";
  let phone = false;
  try { phone = new URLSearchParams(location.search).get("phone") === "1"; } catch { /* no address: the desktop editor */ }
  if (!phone) return;
  const root = document.documentElement;
  root.classList.add("autora-phone");

  const css = `
    /* The ribbon is closed to nothing (its place in the layout kept: some editors lay out in rows, and a row that goes
       missing moves every other row up); "More" opens it in place, with its tabs, over the top of the page. */
    html.autora-phone .ribbon, html.autora-phone header.excel-header { max-height: 0 !important; min-height: 0 !important; overflow: hidden !important; visibility: hidden; border: 0 !important; padding: 0 !important; }
    html.autora-phone.phone-more .ribbon, html.autora-phone.phone-more header.excel-header { max-height: 46vh !important; overflow: auto !important; visibility: visible; }
    html.autora-phone .qa-btn, html.autora-phone .autosave-toggle, html.autora-phone .ribbon-tab-file { display: none !important; }
    html.autora-phone .ribbon-tabs { overflow-x: auto; flex-wrap: nowrap; scrollbar-width: none; }
    html.autora-phone .ribbon-tabs::-webkit-scrollbar { display: none; }
    html.autora-phone .ribbon-tabs > * { flex: 0 0 auto; }
    html.autora-phone .ribbon-tab { min-height: 40px; padding: 0 12px; border-radius: 12px; }
    html.autora-phone .ribbon-body { overflow-x: auto; }
    html.autora-phone footer.status-bar, html.autora-phone .status-bar { display: none !important; }
    html.autora-phone #root { box-sizing: border-box; padding-bottom: 56px; }
    html.autora-phone .slide-list { width: 76px !important; min-width: 0 !important; }
    html.autora-phone .thumb-resizer, html.autora-phone .notes-pane { display: none !important; }

    #autora-phonebar {
      position: fixed; left: 0; right: 0; bottom: 0; z-index: 70; height: 56px; box-sizing: border-box;
      display: flex; align-items: center; gap: 4px; padding: 8px; overflow-x: auto; scrollbar-width: none;
      background: #0e1016; border-top: 1px solid rgba(255,255,255,.11); font-family: inherit;
    }
    #autora-phonebar::-webkit-scrollbar { display: none; }
    #autora-phonebar button {
      flex: 1 1 auto; min-width: 34px; height: 40px; padding: 0 6px; border-radius: 12px; border: 1px solid transparent;
      background: #151824; color: #98a1b6; font: 600 14px/1 inherit; cursor: pointer; touch-action: manipulation;
    }
    #autora-phonebar button:active { background: rgba(110,91,255,.22); color: #edeff5; }
    #autora-phonebar button.on { background: rgba(110,91,255,.22); color: #edeff5; border-color: rgba(110,91,255,.42); }
    #autora-phonebar .gap { display: none; }
    #autora-phonebar .more { flex: 0 0 auto; padding: 0 12px; }
    #autora-phonebar .b { font-weight: 800; } #autora-phonebar .i { font-style: italic; } #autora-phonebar .u { text-decoration: underline; }
  `;
  const style = document.createElement("style");
  style.textContent = css;
  (document.head || root).appendChild(style);

  // The ribbon starts open in the editor's own memory (the More sheet needs its body); the CSS above is what hides it.
  for (const key of ["aidocs.ribbonCollapsed", "ai-sheets-ribbon-collapsed", "ai-slides-ribbon-collapsed"]) {
    try { window.localStorage.setItem(key, "0"); } catch { /* no storage: the editor's default */ }
  }

  const app = /\/(docs|sheets|slides)\//.exec(location.pathname)?.[1] ?? "docs";
  /** What each editor's bar holds: a label, and the start of the name of the editor's own button it presses. */
  const BARS = {
    docs: [["↶", ["undo"], "Undo"], ["↷", ["redo"], "Redo"], ["B", ["bold"], "Bold", "b"], ["I", ["italic"], "Italic", "i"], ["U", ["underline"], "Underline", "u"],
      ["•", ["bullets"], "Bulleted list"], ["A−", ["decrease font size"], "Smaller text"], ["A+", ["increase font size"], "Bigger text"]],
    sheets: [["↶", ["undo"], "Undo"], ["↷", ["redo"], "Redo"], ["B", ["bold"], "Bold", "b"], ["I", ["italic"], "Italic", "i"],
      ["+Row", ["insert row"], "Insert a row"], ["+Col", ["insert column"], "Insert a column"], ["−Row", ["delete row"], "Delete the row"]],
    slides: [["↶", ["undo"], "Undo"], ["↷", ["redo"], "Redo"], ["B", ["bold"], "Bold", "b"], ["I", ["italic"], "Italic", "i"],
      ["A−", ["decrease font size"], "Smaller text"], ["A+", ["increase font size"], "Bigger text"], ["+Slide", ["new blank slide"], "New slide"]],
  }[app];

  const named = (el) => ["data-tip", "aria-label", "title"].map((a) => (el.getAttribute(a) || "").trim().toLowerCase()).filter(Boolean);
  /** The editor's own button by the start of its name (or, for zoom, its sign), never one of ours and never an AI one. */
  function find(starts) {
    for (const el of document.querySelectorAll("button, [role=button]")) {
      if (el.closest("#autora-phonebar") || el.classList.contains("ai-entry")) continue;
      const names = named(el);
      const text = (el.textContent || "").trim();
      if (starts.some((s) => names.some((n) => n.startsWith(s)) || (s.length === 1 && text === s && el.classList.contains("zoom-btn")))) return el;
    }
    return null;
  }

  function build() {
    if (document.getElementById("autora-phonebar") || !document.body) return;
    const bar = document.createElement("nav");
    bar.id = "autora-phonebar";
    bar.setAttribute("aria-label", "Editing tools");
    for (const [label, starts, tip, cls] of BARS) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.title = tip;
      b.dataset.starts = starts.join("|");
      b.setAttribute("aria-label", tip);
      if (cls) b.className = cls;
      // Pressing the bar must not take the page's selection (and the keyboard) with it: the editor needs both to apply bold.
      b.addEventListener("pointerdown", (e) => e.preventDefault());
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", () => { const el = find(starts); if (el) el.click(); });
      bar.appendChild(b);
    }
    const gap = document.createElement("span");
    gap.className = "gap";
    bar.appendChild(gap);
    const more = document.createElement("button");
    more.type = "button";
    more.textContent = "More";
    more.className = "more";
    more.setAttribute("aria-label", "More tools");
    more.setAttribute("aria-pressed", "false");
    more.addEventListener("pointerdown", (e) => e.preventDefault());
    more.addEventListener("click", () => {
      const on = root.classList.toggle("phone-more");
      more.classList.toggle("on", on);
      more.setAttribute("aria-pressed", String(on));
    });
    bar.appendChild(more);
    document.body.appendChild(bar);
  }
  /** Which of the bar's buttons have an editor button to press: marked, so that a renamed one is found by a test, not by a person. */
  function link() {
    for (const b of document.querySelectorAll("#autora-phonebar button[data-starts]")) b.toggleAttribute("data-linked", !!find(b.dataset.starts.split("|")));
  }
  if (document.body) build();
  else document.addEventListener("DOMContentLoaded", build, { once: true });
  for (const ms of [1500, 4000, 8000]) setTimeout(link, ms);

  /* Hiding the ribbon changes the room the page has without the editor being told (a canvas grid draws at the size it last
     measured), so it is told: a resize, a few times while the editor starts, and whenever the More sheet comes or goes. */
  const refit = () => window.dispatchEvent(new Event("resize"));
  for (const ms of [400, 1200, 2500, 5000]) setTimeout(refit, ms);
  new MutationObserver(refit).observe(root, { attributes: true, attributeFilter: ["class"] });
})();
