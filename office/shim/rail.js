/*
 * The one tool bar, in Pages, Sheets and Slides (docs/TOOL-RAIL.md): round coloured tools down the right side of a desktop
 * and along the bottom of a phone, as many as fit and never scrolling, and a grid button last that opens every tool in a
 * modal. It replaces the ribbon on both, and nothing is shown of the ribbon at all: it is closed to nothing (its place in the
 * layout kept, because Sheets lays out in rows and a row that goes missing moves every other row up).
 *
 * Every command of the ribbon is a tool. The common ones are listed here (TOOLS) with a colour per verb and a place on the
 * bar; the rest are read from the ribbon itself once the editor is up (it opens each tab once, unseen, and notes its
 * controls), and appear in All tools under the name of their tab, each one pinnable like the others. A tool presses the
 * editor's own button, found by the start of the name each carries (`data-tip`, `aria-label`, `title`), so there is nothing
 * to keep in step with the editor but the names, and no second implementation of bold. A command that opens a drop-down (a
 * colour, borders, a table size) has its drop-down open beside the bar, because while it runs the ribbon is laid out, unseen,
 * at a fixed place there. The agent has every tool whatever is shown. Pins live in the page's storage, which a frame with no
 * origin only has for the session (common.js). Runs only in the framed editor; the server's headless render never gets it.
 */
(() => {
  "use strict";
  if (window.parent === window || typeof window.__autoraHeadless !== "undefined" || typeof window.__autoraHost === "function") return;
  let phone = false;
  try { phone = new URLSearchParams(location.search).get("phone") === "1"; } catch { /* no address: the desktop editor */ }
  const root = document.documentElement;
  root.classList.add("autora-rail-ui", phone ? "autora-phone" : "autora-desktop");
  const app = /\/(docs|sheets|slides)\//.exec(location.pathname)?.[1] ?? "docs";

  const css = `
    html.autora-rail-ui .ribbon, html.autora-rail-ui header.excel-header { max-height: 0 !important; min-height: 0 !important; overflow: hidden !important; visibility: hidden; border: 0 !important; padding: 0 !important; }
    /* The ribbon is never seen. While a tool needs it, it is laid out at a fixed place (so a drop-down opens beside the bar, not at the
       top-left corner) and stays invisible; the tools of a tab are shown as tiles in our own panel, and pressing one presses the real button. */
    html.autora-rail-ui.rail-ribbon .ribbon, html.autora-rail-ui.rail-ribbon header.excel-header {
      position: fixed !important; z-index: 85; box-sizing: border-box; overflow: visible !important; visibility: hidden; pointer-events: none; max-height: min(70vh, 520px) !important; }
    /* What a command opens inside the ribbon (a table size, a list of styles) is seen, though the ribbon is not. */
    html.autora-rail-ui.rail-ribbon .ribbon :is([class*="picker"], [class*="popover"], [class*="popup"], [class*="menu"], [class*="dropdown"], [class*="gallery"], [role="menu"], [role="listbox"], [role="dialog"]),
    html.autora-rail-ui.rail-ribbon header.excel-header :is([class*="picker"], [class*="popover"], [class*="popup"], [class*="menu"], [class*="dropdown"], [class*="gallery"], [role="menu"], [role="listbox"], [role="dialog"]) { visibility: visible; pointer-events: auto; box-shadow: 0 16px 48px -10px #000; outline: 1px solid rgba(255,255,255,.16); border-radius: 10px; }
    html.autora-desktop.rail-ribbon .ribbon, html.autora-desktop.rail-ribbon header.excel-header { right: 76px; top: 12px; width: min(680px, calc(100vw - 100px)); }
    html.autora-phone.rail-ribbon .ribbon, html.autora-phone.rail-ribbon header.excel-header { left: 8px; right: 8px; bottom: 64px; max-height: 46vh !important; }
    html.autora-rail-ui .qa-btn, html.autora-rail-ui .autosave-toggle, html.autora-rail-ui .ribbon-tab-file { display: none !important; }
    html.autora-rail-ui .ribbon-tabs { overflow-x: auto; flex-wrap: nowrap; scrollbar-width: none; }
    html.autora-rail-ui .ribbon-tabs::-webkit-scrollbar { display: none; }
    html.autora-rail-ui .ribbon-tabs > * { flex: 0 0 auto; }
    html.autora-rail-ui .ribbon-body { overflow-x: auto; }
    html.autora-phone footer.status-bar, html.autora-phone .status-bar { display: none !important; }
    html.autora-phone #root { box-sizing: border-box; padding-bottom: 56px; }
    html.autora-desktop #root { box-sizing: border-box; padding-right: 66px; }
    html.autora-phone .ribbon-tab { min-height: 40px; padding: 0 12px; border-radius: 12px; }
    html.autora-phone .slide-list { width: 76px !important; min-width: 0 !important; }
    html.autora-phone .thumb-resizer, html.autora-phone .notes-pane { display: none !important; }
    @keyframes autora-flash { 0%, 100% { box-shadow: 0 0 0 0 rgba(110,91,255,0); } 30% { box-shadow: 0 0 0 4px rgba(110,91,255,.85); } }
    .autora-flash { animation: autora-flash 1.4s ease-in-out 2; border-radius: 6px; }

    #autora-rail { position: fixed; z-index: 70; box-sizing: border-box; display: flex; align-items: center; gap: 4px; padding: 8px; font-family: inherit;
      background: rgba(21,24,36,.92); border: 1px solid rgba(255,255,255,.13); box-shadow: 0 18px 48px -12px rgba(0,0,0,.7); backdrop-filter: blur(8px); }
    html.autora-desktop #autora-rail { right: 8px; top: 50%; transform: translateY(-50%); flex-direction: column; border-radius: 999px; max-height: calc(100% - 16px); overflow: hidden; }
    html.autora-phone #autora-rail { left: 0; right: 0; bottom: 0; height: 56px; justify-content: center; gap: 2px; padding: 8px 6px; border-width: 1px 0 0; border-radius: 0; background: #0e1016; box-shadow: none; }
    #autora-rail button.rb { --tc: #98a1b6; flex: none; display: grid; place-items: center; border: 0; border-radius: 50%; cursor: pointer; padding: 0; color: var(--tc);
      background: color-mix(in srgb, var(--tc) 16%, transparent); touch-action: manipulation; transition: background .15s, box-shadow .15s; }
    html.autora-desktop #autora-rail button.rb { width: 44px; height: 44px; }
    html.autora-phone #autora-rail button.rb { width: 40px; height: 40px; }
    #autora-rail button.rb:hover:not(:disabled) { background: color-mix(in srgb, var(--tc) 28%, transparent); }
    #autora-rail button.rb.on { color: #fff; background: var(--tc); box-shadow: 0 6px 18px color-mix(in srgb, var(--tc) 45%, transparent); }
    #autora-rail button.rb:disabled { opacity: .35; cursor: default; }
    #autora-rail button.rb svg, .ar-tile svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
    #autora-rail .div { flex: none; background: rgba(255,255,255,.13); }
    html.autora-desktop #autora-rail .div { width: 24px; height: 1px; margin: 2px 0; }
    html.autora-phone #autora-rail .div { width: 1px; height: 24px; margin: 0 2px; }

    #autora-grid { position: fixed; inset: 0; z-index: 90; display: grid; place-items: center; padding: 16px; background: rgba(8,9,13,.68); backdrop-filter: blur(3px); font-family: inherit; }
    #autora-grid .box { width: min(560px, 100%); max-height: min(88vh, 720px); overflow-y: auto; box-sizing: border-box; padding: 16px; border-radius: 20px; background: #0e1016; border: 1px solid rgba(255,255,255,.13); color: #edeff5; box-shadow: 0 30px 80px -20px #000; }
    html.autora-phone #autora-grid .box { width: min(340px, 100%); padding: 12px; }
    #autora-grid .head { display: flex; align-items: center; gap: 8px; }
    #autora-grid h3 { margin: 0; font-size: 15px; font-weight: 600; flex: 1; }
    #autora-grid h4 { margin: 14px 4px 8px; font-size: 10.5px; font-weight: 500; letter-spacing: .08em; text-transform: uppercase; color: #7a8297; }
    #autora-grid .hint { margin: 4px 0 0; font-size: 12px; color: #7a8297; min-height: 1.4em; }
    #autora-grid .plain { border: 0; background: transparent; color: #98a1b6; font: inherit; font-size: 12px; padding: 4px 8px; border-radius: 999px; cursor: pointer; }
    #autora-grid .plain:hover { background: #151824; color: #edeff5; }
    #autora-grid .x { width: 30px; height: 30px; padding: 0; border-radius: 50%; display: grid; place-items: center; }
    .ar-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 8px; }
    html.autora-phone .ar-tiles { grid-template-columns: repeat(auto-fill, minmax(64px, 1fr)); gap: 6px; }
    .ar-wrap { position: relative; --tc: #98a1b6; }
    .ar-tile { width: 100%; height: 76px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; padding: 0 4px; box-sizing: border-box; border: 0; border-radius: 16px; cursor: pointer; font: inherit; font-size: 11.5px; line-height: 1.15; text-align: center;
      color: var(--tc); background: color-mix(in srgb, var(--tc) 16%, transparent); }
    .ar-tile span { color: #edeff5; }
    .ar-tile:hover:not(:disabled) { background: color-mix(in srgb, var(--tc) 26%, transparent); }
    .ar-tile:disabled { opacity: .35; cursor: default; }
    .ar-tile.on { box-shadow: inset 0 0 0 1px rgba(110,91,255,.6); }
    html.autora-phone .ar-tile { height: 56px; border-radius: 14px; gap: 4px; font-size: 10px; }
    .ar-pin { position: absolute; top: 4px; right: 4px; width: 20px; height: 20px; padding: 0; border: 0; border-radius: 50%; display: grid; place-items: center; cursor: pointer; background: transparent; color: #7a8297; }
    .ar-pin svg { width: 11px; height: 11px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .ar-pin.on { color: #fff; background: var(--tc); }
  `;
  const style = document.createElement("style");
  style.textContent = css;
  (document.head || root).appendChild(style);

  // The ribbon starts open in the editor's own memory (the ribbon sheet needs its body); the CSS above is what hides it.
  for (const key of ["aidocs.ribbonCollapsed", "ai-sheets-ribbon-collapsed", "ai-slides-ribbon-collapsed"]) {
    try { window.localStorage.setItem(key, "0"); } catch { /* no storage: the editor's default */ }
  }

  /* ---------------------------------------------------------------- the tools */
  const BLUE = "#2563eb", EMERALD = "#059669", AMBER = "#f59e0b", PURPLE = "#9333ea", INDIGO = "#4f46e5", SKY = "#0284c7", GOLD = "#d97706", ROSE = "#e11d48", CYAN = "#0891b2", SLATE = "#94a3b8";
  /** id, label, group, icon, colour, what it presses, how, flags. `jump` opens the ribbon on the control (and on `tab` first). */
  const t = (id, label, group, icon, color, starts, o = {}) => ({ id, label, group, icon, color, starts: starts || [], ...o });

  const HIST = [t("undo", "Undo", "History", "undo-2", SLATE, ["undo"], { phone: 1, desktop: 1 }), t("redo", "Redo", "History", "redo-2", SLATE, ["redo"], { desktop: 1 })];
  const CLIP = [
    t("cut", "Cut", "Clipboard", "scissors", SLATE, ["cut"]), t("copy", "Copy", "Clipboard", "copy", SLATE, ["copy"]),
    t("paste", "Paste", "Clipboard", "clipboard-paste", SLATE, ["paste"]), t("painter", "Format painter", "Clipboard", "paintbrush", SLATE, ["format painter"]),
  ];

  const TOOLS = {
    docs: [
      ...HIST,
      t("bold", "Bold", "Text", "bold", EMERALD, ["bold"], { phone: 1, desktop: 1 }),
      t("italic", "Italic", "Text", "italic", EMERALD, ["italic"], { phone: 1, desktop: 1 }),
      t("underline", "Underline", "Text", "underline", EMERALD, ["underline"], { phone: 1, desktop: 1 }),
      t("strike", "Strikethrough", "Text", "strikethrough", EMERALD, ["strikethrough"]),
      t("highlight", "Highlight", "Text", "highlighter", AMBER, ["text highlight color"], { pop: 1, phone: 1, desktop: 1 }),
      t("color", "Text colour", "Text", "baseline", PURPLE, ["font color"], { pop: 1, desktop: 1 }),
      t("larger", "Bigger text", "Text", "a-arrow-up", EMERALD, ["increase font size"]),
      t("smaller", "Smaller text", "Text", "a-arrow-down", EMERALD, ["decrease font size"]),
      t("clearfmt", "Clear formatting", "Text", "eraser", ROSE, ["clear all formatting"]),
      t("h1", "Heading", "Paragraph", "heading-1", INDIGO, ["heading 1"]),
      t("bullets", "Bullets", "Paragraph", "list", SKY, ["bullets"], { phone: 1, desktop: 1 }),
      t("numbering", "Numbering", "Paragraph", "list-ordered", SKY, ["numbering"], { phone: 1, desktop: 1 }),
      t("left", "Align left", "Paragraph", "align-left", INDIGO, ["align left"], { desktop: 1 }),
      t("centre", "Centre", "Paragraph", "align-center", INDIGO, ["center"], { desktop: 1 }),
      t("right", "Align right", "Paragraph", "align-right", INDIGO, ["align right"]),
      t("justify", "Justify", "Paragraph", "align-justify", INDIGO, ["justify"]),
      t("indent", "Indent", "Paragraph", "indent-increase", INDIGO, ["increase indent"]),
      t("outdent", "Outdent", "Paragraph", "indent-decrease", INDIGO, ["decrease indent"]),
      t("spacing", "Line spacing", "Paragraph", "text-select", INDIGO, ["line spacing"], { pop: 1 }),
      t("find", "Find", "Edit", "search", BLUE, ["find text in the document"]), t("replace", "Replace", "Edit", "replace", BLUE, ["find and replace"]),
      t("selectall", "Select all", "Edit", "text-select", BLUE, ["select the whole document"]), t("words", "Word count", "Edit", "hash", SKY, ["word count"]),
      t("track", "Track changes", "Edit", "file-diff", ROSE, ["track changes"]),
      ...CLIP,
    ],
    sheets: [
      ...HIST,
      t("bold", "Bold", "Text", "bold", EMERALD, ["bold"], { phone: 1, desktop: 1 }),
      t("italic", "Italic", "Text", "italic", EMERALD, ["italic"], { phone: 1, desktop: 1 }),
      t("underline", "Underline", "Text", "underline", EMERALD, ["underline"], { desktop: 1 }),
      t("strike", "Strikethrough", "Text", "strikethrough", EMERALD, ["strikethrough"]),
      t("larger", "Bigger text", "Text", "a-arrow-up", EMERALD, ["increase font size"]), t("smaller", "Smaller text", "Text", "a-arrow-down", EMERALD, ["decrease font size"]),
      t("color", "Text colour", "Colour", "baseline", PURPLE, ["font color"], { desktop: 1 }),
      t("fill", "Fill colour", "Colour", "paint-bucket", AMBER, ["fill color"], { phone: 1, desktop: 1 }),
      t("borders", "Borders", "Colour", "grid-3x3", INDIGO, ["borders"], { pop: 1 }),
      t("left", "Align left", "Align", "align-left", INDIGO, ["align left"], { desktop: 1 }), t("centre", "Centre", "Align", "align-center", INDIGO, ["align center"]),
      t("right", "Align right", "Align", "align-right", INDIGO, ["align right"]), t("wrap", "Wrap text", "Align", "wrap-text", INDIGO, ["wrap text"], { desktop: 1 }),
      t("merge", "Merge cells", "Align", "merge", INDIGO, ["merge cells"], { pop: 1 }),
      t("currency", "Currency", "Numbers", "dollar-sign", GOLD, ["currency"], { desktop: 1 }), t("percent", "Percent", "Numbers", "percent", GOLD, ["percent"], { desktop: 1 }),
      t("thousands", "Thousands", "Numbers", "hash", GOLD, ["thousands"]), t("moredec", "More decimals", "Numbers", "plus", GOLD, ["increase decimal"]), t("lessdec", "Fewer decimals", "Numbers", "table-properties", GOLD, ["decrease decimal"]),
      t("insrow", "Insert row", "Cells", "rows-3", CYAN, ["insert row"], { phone: 1, desktop: 1 }), t("inscol", "Insert column", "Cells", "columns-3", CYAN, ["insert column"], { phone: 1, desktop: 1 }),
      t("delrow", "Delete row", "Cells", "trash-2", ROSE, ["delete row"]), t("delcol", "Delete column", "Cells", "trash-2", ROSE, ["delete column"]),
      t("fmtcells", "Format cells", "Cells", "table-properties", BLUE, ["format cells"]),
      t("autosum", "AutoSum", "Data", "sigma", SKY, ["autosum"], { pop: 1, phone: 1, desktop: 1 }), t("sort", "Sort & filter", "Data", "funnel", SKY, ["sort & filter"], { pop: 1 }),
      t("cond", "Conditional formatting", "Data", "palette", AMBER, ["conditional formatting"], { pop: 1 }), t("astable", "Format as table", "Data", "table-properties", INDIGO, ["format as table"], { pop: 1 }),
      t("styles", "Cell styles", "Data", "palette", PURPLE, ["cell styles"], { pop: 1 }),
      t("replace", "Replace", "Edit", "replace", BLUE, ["replace"]), t("goto", "Go to", "Edit", "search", BLUE, ["go to"]),
      ...CLIP,
    ],
    slides: [
      ...HIST,
      t("newslide", "New slide", "Slides", "square-plus", CYAN, ["new blank slide"], { phone: 1, desktop: 1 }),
      t("layoutpick", "Layout", "Slides", "layout-template", INDIGO, ["change current slide layout"], { pop: 1, phone: 1, desktop: 1 }),
      t("section", "Add section", "Slides", "plus", CYAN, ["add a section"]),
      t("present", "Present", "Slides", "play", ROSE, ["full-screen show"], { phone: 1, desktop: 1 }),
      t("bold", "Bold", "Text", "bold", EMERALD, ["bold"], { phone: 1, desktop: 1 }),
      t("italic", "Italic", "Text", "italic", EMERALD, ["italic"], { phone: 1, desktop: 1 }),
      t("underline", "Underline", "Text", "underline", EMERALD, ["underline"], { phone: 1, desktop: 1 }),
      t("strike", "Strikethrough", "Text", "strikethrough", EMERALD, ["strikethrough"]),
      t("color", "Text colour", "Text", "baseline", PURPLE, ["font color"], { pop: 1, desktop: 1 }),
      t("larger", "Bigger text", "Text", "a-arrow-up", EMERALD, ["increase font size"], { desktop: 1 }), t("smaller", "Smaller text", "Text", "a-arrow-down", EMERALD, ["decrease font size"], { desktop: 1 }),
      t("clearfmt", "Clear formatting", "Text", "eraser", ROSE, ["clear all formatting"]), t("para", "Paragraph", "Text", "align-left", INDIGO, ["paragraph"], { pop: 1 }),
      t("formatpane", "Format pane", "Arrange", "panel-right", BLUE, ["show or hide the format pane"], { desktop: 1 }), t("arrange", "Align & distribute", "Arrange", "layout-grid", INDIGO, ["align or evenly distribute"], { pop: 1 }),
      t("notes", "Notes", "Arrange", "message-square", SKY, ["hide notes", "show notes"]),
      ...CLIP,
    ],
  }[app];

  /* ------------------------------------------------------------ the editor's own buttons */
  const named = (el) => ["data-tip", "aria-label", "title"].map((a) => (el.getAttribute(a) || "").trim().toLowerCase()).filter(Boolean);
  const mine = (el) => el.closest("#autora-rail, #autora-grid") || el.classList.contains("ai-entry");
  /** The editor's button whose name starts with one of `starts`, never one of ours and never an AI one. */
  function find(starts) {
    for (const el of document.querySelectorAll("button, [role=button]")) {
      if (mine(el)) continue;
      const names = named(el);
      if (starts.some((s) => names.some((n) => n.startsWith(s)))) return el;
    }
    return null;
  }
  /** A ribbon tab, by its whole name. */
  function tabButton(name) {
    for (const el of document.querySelectorAll("button, [role=button]")) {
      if (mine(el)) continue;
      if (named(el).includes(name) || (el.textContent || "").trim().toLowerCase() === name) return el;
    }
    return null;
  }
  const isOn = (el) => !!el && (el.getAttribute("aria-pressed") === "true" || el.classList.contains("active") || el.classList.contains("is-active") || el.classList.contains("on"));
  const isOff = (el) => !el || el.disabled || el.getAttribute("aria-disabled") === "true";
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  /** Press a button the way a hand does: some of the editors' buttons act on the press, not on the click. */
  function press(el) {
    if (!el) return;
    const at = el.getBoundingClientRect();
    const init = { bubbles: true, cancelable: true, view: window, clientX: at.left + at.width / 2, clientY: at.top + at.height / 2, button: 0 };
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
      el.dispatchEvent(type.startsWith("pointer") ? new PointerEvent(type, { ...init, pointerType: "mouse", isPrimary: true }) : new MouseEvent(type, init));
    }
    el.click();
  }

  /** The label a ribbon control goes by: the start of its name, without the shortcut or the tip after it. */
  const short = (el) => {
    const shown = (el.textContent || "").trim().replace(/\s+/g, " ");
    const tip = (el.getAttribute("data-tip") || el.getAttribute("aria-label") || el.getAttribute("title") || "").trim();
    let nice = (tip || shown).split(/\s*[:—(]\s*/)[0].trim().replace(/^(insert|add|create)\s+(a|an|the)\s+/i, "").replace(/^(insert|add)\s+/i, "");
    if (nice.length > 24 && shown && shown.length <= 24) nice = shown;
    nice = nice.charAt(0).toUpperCase() + nice.slice(1);
    return nice.length > 24 ? `${nice.slice(0, 23)}…` : nice;
  };
  /** The controls of the ribbon tab that is open: not the tabs, not the title row, not a drop-down's second half. */
  function controlsOfTab() {
    const box = document.querySelector(".ribbon, header.excel-header");
    if (!box) return [];
    const out = [];
    for (const el of box.querySelectorAll("button, [role=button]")) {
      if (mine(el) || el.closest(".ribbon-tabs, .qa-btn") || el.classList.contains("ribbon-tab") || el.classList.contains("qa-btn")) continue;
      if (/caret/.test(el.className?.toString() || "")) continue;
      const label = short(el);
      if (!label || label.length < 2) continue;
      out.push({ el, label, names: named(el), icon: el.querySelector("svg, img")?.outerHTML ?? "" });
    }
    return out;
  }

  /* ----------------------------------------------- which ribbon tab is open, and every command on every tab */
  const TABS = {
    docs: [["home", "Home", BLUE], ["insert", "Insert", CYAN], ["draw", "Draw", PURPLE], ["design", "Design", AMBER], ["layout", "Layout", INDIGO], ["references", "References", SKY], ["review", "Review", GOLD], ["view", "View", BLUE]],
    sheets: [["home", "Home", BLUE], ["insert", "Insert", CYAN], ["page layout", "Page layout", INDIGO], ["formulas", "Formulas", SKY], ["data", "Data", SKY], ["review", "Review", GOLD], ["view", "View", BLUE]],
    slides: [["home", "Home", BLUE], ["insert", "Insert", CYAN], ["draw", "Draw", PURPLE], ["design", "Design", AMBER], ["transitions", "Transitions", INDIGO], ["animations", "Animations", GOLD], ["slide show", "Slide show", ROSE], ["review", "Review", GOLD], ["view", "View", BLUE]],
  }[app];
  let curTab = "home";
  /** Opens a ribbon tab (unseen) and waits for its controls to be drawn. */
  async function showTab(name) {
    if (curTab === name) return;
    press(tabButton(name));
    curTab = name;
    await wait(220);
  }
  /** Every curated tool already names its button, so a command the ribbon has under one of those names is not listed twice. */
  const curated = (names) => TOOLS.some((x) => x.starts.some((s) => names.some((n) => n.startsWith(s))));
  let scanned = false;
  async function scan() {
    if (scanned) return;
    scanned = true;
    const found = [];
    for (const [key, label, color] of TABS) {
      await showTab(key);
      const seen = new Set();
      for (const c of controlsOfTab()) {
        const id = `r:${key}:${c.label.toLowerCase()}`;
        if (seen.has(id) || curated(c.names)) continue;
        seen.add(id);
        found.push({ id, label: c.label, group: label, color, tab: key, names: c.names.length ? c.names : [c.label.toLowerCase()], iconHtml: c.icon, starts: [], auto: 1, pop: /dropdown|caret|menu/.test(c.el.className?.toString() || "") || !!c.el.getAttribute("aria-haspopup") });
      }
    }
    await showTab("home");
    for (const x of found) { TOOLS.push(x); byId.set(x.id, x); }
    refresh();
  }

  const anchored = () => root.classList.contains("rail-ribbon");
  function setAnchor(on) { root.classList.toggle("rail-ribbon", on); }
  let busy = false;
  /** Press a tool: the editor's own button, on the right ribbon tab, with a drop-down opening beside the bar. */
  async function run(tool) {
    if (busy) return;
    busy = true;
    try {
      const tab = tool.tab || "home";
      // A drop-down opens next to its button, so for it the (unseen) ribbon sits beside the bar; any other press puts it away.
      const opens = !!(tool.pop || tool.auto);
      setAnchor(opens);
      if (curTab !== tab) await showTab(tab);
      const el = tool.auto
        ? (controlsOfTab().find((c) => c.names.join("|") === tool.names.join("|") || c.label === tool.label) || {}).el
        : find(tool.starts);
      press(el);
      // A command that does not open anything leaves the Home tab as it found it, so the common tools can read their state again.
      if (tab !== "home" && !opens) { await wait(200); await showTab("home"); }
      // One that may have opened something keeps its tab until the person moves on (a click in the page, Esc), or a while passes.
      if (opens) setTimeout(() => { if (!document.querySelector("[role=dialog]:not(#autora-grid .box), [role=menu], [role=listbox]")) { setAnchor(false); if (curTab !== "home") void showTab("home"); } }, 8000);
    } finally { busy = false; }
  }
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && anchored() && !grid) { setAnchor(false); if (curTab !== "home") void showTab("home"); } }, true);
  // Pressing in the page puts a drop-down's anchor away and brings the Home tab back.
  document.addEventListener("pointerdown", (e) => {
    if (!anchored() || (e.target instanceof Element && e.target.closest("#autora-rail, #autora-grid"))) return;
    setTimeout(() => { setAnchor(false); if (curTab !== "home") void showTab("home"); }, 400);
  }, true);

  /* ------------------------------------------------------------------ the bar and the grid */
  const svg = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${(window.__autoraIcons || {})[name] || (window.__autoraIcons || {}).plus || ""}</svg>`;
  const iconOf = (tool) => (tool.iconHtml ? tool.iconHtml.replace(/<svg/, '<svg style="width:20px;height:20px"') : svg(tool.icon));
  const PINS = `autora-rail-pins-${app}`;
  let pins = (() => {
    try { const saved = JSON.parse(localStorage.getItem(PINS) || "null"); if (Array.isArray(saved)) return saved; } catch { /* the defaults */ }
    return TOOLS.filter((x) => x.desktop).map((x) => x.id);
  })();
  const savePins = () => { try { localStorage.setItem(PINS, JSON.stringify(pins)); } catch { /* this session only */ } };
  const byId = new Map(TOOLS.map((x) => [x.id, x]));
  const shownIds = () => (phone ? TOOLS.filter((x) => x.phone).map((x) => x.id) : pins.filter((id) => byId.has(id)));

  const BTN = phone ? 40 : 44, GAP = phone ? 2 : 4, PAD = 8;
  const room = () => {
    const space = phone ? window.innerWidth : window.innerHeight - 16;
    return Math.max(1, Math.floor((space - 2 * PAD - 12 + GAP) / (BTN + GAP)) - 1);
  };

  let bar = null, grid = null, toast = "";
  const swallow = (el) => { el.addEventListener("pointerdown", (e) => e.preventDefault()); el.addEventListener("mousedown", (e) => e.preventDefault()); };

  function state(tool) {
    if (tool.auto || tool.tab) return { on: false, off: false, found: true };
    const el = find(tool.starts);
    return { on: isOn(el), off: isOff(el), found: !!el, key: el && !phone ? shortcutOf(el, tool.id) : "" };
  }
  /** The editor's own shortcut for a command, as its button names it: "Bold (Ctrl+B)" or "Paste Ctrl+V". Kept working: the editor handles the keys. */
  const COMMON = { bold: "Ctrl+B", italic: "Ctrl+I", underline: "Ctrl+U", undo: "Ctrl+Z", redo: "Ctrl+Y", cut: "Ctrl+X", copy: "Ctrl+C", paste: "Ctrl+V", find: "Ctrl+F", replace: "Ctrl+H", selectall: "Ctrl+A", goto: "Ctrl+G", left: "Ctrl+L", centre: "Ctrl+E", right: "Ctrl+R", justify: "Ctrl+J", newslide: "Ctrl+M" };
  function shortcutOf(el, id) {
    for (const n of [el.getAttribute("data-tip"), el.getAttribute("aria-label"), el.getAttribute("title")]) {
      const m = /\(((?:ctrl|shift|alt|cmd|⌘)[^)]*)\)/i.exec(n || "") || /\b((?:ctrl|shift|alt)\+[A-Za-z0-9+]+)\s*$/i.exec(n || "");
      if (m) return m[1];
    }
    return COMMON[id] || "";
  }

  function drawBar() {
    if (!bar) return;
    bar.textContent = "";
    for (const id of shownIds().slice(0, room())) {
      const tool = byId.get(id);
      const b = document.createElement("button");
      b.type = "button";
      b.className = "rb";
      b.dataset.tool = id;
      if (tool.starts.length) b.dataset.starts = tool.starts.join("|");
      b.style.setProperty("--tc", tool.color);
      b.title = tool.label;
      b.setAttribute("aria-label", tool.label);
      b.innerHTML = iconOf(tool);
      swallow(b);
      b.addEventListener("click", () => void run(tool));
      bar.appendChild(b);
    }
    const div = document.createElement("i");
    div.className = "div";
    bar.appendChild(div);
    const g = document.createElement("button");
    g.type = "button";
    g.className = "rb";
    g.style.setProperty("--tc", "#98a1b6");
    g.title = "All tools";
    g.setAttribute("aria-label", "All tools");
    g.setAttribute("aria-haspopup", "dialog");
    g.innerHTML = svg("layout-grid");
    swallow(g);
    g.addEventListener("click", openGrid);
    bar.appendChild(g);
    paint();
  }

  /** Which tools are lit or dimmed: read from the editor's own buttons, a few times a second (only while its Home tab is the one open). */
  function paint() {
    if (curTab !== "home") return;
    if (bar) {
      for (const b of bar.querySelectorAll("button[data-tool]")) {
        const s = state(byId.get(b.dataset.tool));
        b.classList.toggle("on", !!s.on);
        b.disabled = !!s.off;
        if (s.key) { const label = byId.get(b.dataset.tool).label; b.title = `${label} (${s.key})`; }
        if (b.dataset.starts) b.toggleAttribute("data-linked", !!s.found);
      }
    }
    if (grid) {
      for (const b of grid.querySelectorAll("button[data-tile]")) {
        const s = state(byId.get(b.dataset.tile));
        b.classList.toggle("on", !!s.on);
        b.disabled = !!s.off;
      }
    }
  }
  function refresh() { drawBar(); if (grid) fillGrid?.(); }

  let fillGrid = null;
  function openGrid() {
    closeGrid();
    grid = document.createElement("div");
    grid.id = "autora-grid";
    grid.setAttribute("role", "presentation");
    const box = document.createElement("div");
    box.className = "box";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-label", "All tools");
    grid.appendChild(box);
    const head = document.createElement("div");
    head.className = "head";
    head.innerHTML = "<h3>All tools</h3>";
    if (!phone) {
      const reset = document.createElement("button");
      reset.type = "button"; reset.className = "plain"; reset.textContent = "Reset bar";
      reset.addEventListener("click", () => { pins = TOOLS.filter((x) => x.desktop).map((x) => x.id); savePins(); refresh(); });
      head.appendChild(reset);
    }
    const x = document.createElement("button");
    x.type = "button"; x.className = "plain x"; x.setAttribute("aria-label", "Close"); x.innerHTML = svg("x");
    x.addEventListener("click", closeGrid);
    head.appendChild(x);
    box.appendChild(head);
    const hint = document.createElement("p");
    hint.className = "hint";
    box.appendChild(hint);
    const body = document.createElement("div");
    box.appendChild(body);

    fillGrid = () => {
      const ids = shownIds();
      hint.textContent = toast || (phone ? "Tap a tool to use it." : `Pin the tools you use most to your bar. It has room for ${room()} at this window size (${ids.length} pinned).`);
      body.textContent = "";
      const groups = [];
      for (const tool of TOOLS) if (!groups.includes(tool.group)) groups.push(tool.group);
      for (const g of groups) {
        const h = document.createElement("h4");
        h.textContent = g;
        body.appendChild(h);
        const tiles = document.createElement("div");
        tiles.className = "ar-tiles";
        for (const tool of TOOLS.filter((y) => y.group === g)) {
          const wrap = document.createElement("div");
          wrap.className = "ar-wrap";
          wrap.style.setProperty("--tc", tool.color);
          const b = document.createElement("button");
          b.type = "button";
          b.className = "ar-tile";
          b.dataset.tile = tool.id;
          b.innerHTML = `${iconOf(tool)}<span></span>`;
          b.querySelector("span").textContent = tool.label;
          swallow(b);
          b.addEventListener("click", () => { closeGrid(); void run(tool); });
          wrap.appendChild(b);
          if (!phone) {
            const pin = document.createElement("button");
            const pinned = ids.includes(tool.id);
            pin.type = "button";
            pin.className = `ar-pin${pinned ? " on" : ""}`;
            pin.setAttribute("aria-pressed", String(pinned));
            pin.setAttribute("aria-label", `${pinned ? "Unpin" : "Pin"} ${tool.label} ${pinned ? "from" : "to"} the bar`);
            pin.innerHTML = svg("pin");
            pin.addEventListener("click", () => {
              if (pinned) pins = pins.filter((p) => p !== tool.id);
              else if (ids.length >= room()) { toast = "The bar is full. Unpin a tool first."; refresh(); return; }
              else pins = [...pins, tool.id];
              toast = "";
              savePins(); refresh();
            });
            wrap.appendChild(pin);
          }
          tiles.appendChild(wrap);
        }
        body.appendChild(tiles);
      }
      paint();
    };
    toast = "";
    fillGrid();
    grid.addEventListener("click", (e) => { if (e.target === grid) closeGrid(); });
    document.body.appendChild(grid);
  }
  function closeGrid() { grid?.remove(); grid = null; fillGrid = null; }
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && grid) closeGrid(); }, true);

  function build() {
    if (document.getElementById("autora-rail") || !document.body) return;
    bar = document.createElement("nav");
    bar.id = "autora-rail";
    bar.setAttribute("aria-label", "Tools");
    document.body.appendChild(bar);
    drawBar();
    window.addEventListener("resize", drawBar);
    setInterval(paint, 400);
    // Once the editor is up, read every command from the ribbon, unseen, so All tools has the lot.
    const ready = setInterval(() => { if (find(["undo"])) { clearInterval(ready); setTimeout(() => void scan(), 800); } }, 500);
  }
  if (document.body) build();
  else document.addEventListener("DOMContentLoaded", build, { once: true });

  /* Hiding the ribbon changes the room the page has without the editor being told (a canvas grid draws at the size it last
     measured), so it is told: a resize, a few times while the editor starts, and whenever the anchor comes or goes. */
  const refit = () => window.dispatchEvent(new Event("resize"));
  for (const ms of [400, 1200, 2500, 5000]) setTimeout(refit, ms);
  new MutationObserver(refit).observe(root, { attributes: true, attributeFilter: ["class"] });
})();
