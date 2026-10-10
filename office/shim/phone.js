/*
 * The editors on a phone (the window adds ?phone=1 to the frame's address): the paired-down one.
 *
 * GenOffice's editors are desktop programs, a ribbon of commands over a page. On a phone Autora's window shows the
 * pages as pictures and the agent does the editing; this is the editor for when the person wants to type something
 * themselves ("Full editor"). It keeps the page and gives the screen back: the ribbon starts closed (a tap on a tab
 * opens that tab, the editor's own behaviour), the tabs row scrolls sideways instead of running off, the controls are
 * 40px, and the switches a phone does not need are away. Nothing is removed from the editors: a desktop gets the same
 * editor untouched, and so does a phone's "Full editor" on a tablet-width window.
 */
(() => {
  "use strict";
  let phone = false;
  try { phone = new URLSearchParams(location.search).get("phone") === "1"; } catch { /* no address: the desktop editor */ }
  if (!phone) return;
  document.documentElement.classList.add("autora-phone");

  const css = `
    html.autora-phone .ribbon-tabs { overflow-x: auto; flex-wrap: nowrap; scrollbar-width: none; padding-bottom: 2px; }
    html.autora-phone .ribbon-tabs::-webkit-scrollbar { display: none; }
    html.autora-phone .ribbon-tabs > * { flex: 0 0 auto; }
    html.autora-phone .ribbon-tab { min-height: 40px; padding-left: 12px; padding-right: 12px; border-radius: 12px; }
    html.autora-phone .qa-btn { width: 40px; height: 40px; border-radius: 12px; }
    html.autora-phone .autosave-toggle { display: none; }
    html.autora-phone .ribbon-body { max-height: 38vh; overflow: auto; }
    html.autora-phone .status-bar button, html.autora-phone footer button { min-height: 32px; }
    /* Slides: a narrow strip of slides, so the slide itself has the width. */
    html.autora-phone .slide-list { width: 76px !important; min-width: 0 !important; }
    html.autora-phone .thumb-resizer { display: none; }
  `;
  const style = document.createElement("style");
  style.textContent = css;
  (document.head || document.documentElement).appendChild(style);

  /* Start with the ribbon closed. Each editor reads one saved flag for it when it starts (the keys below, one per
     editor); this frame's storage is in memory, so the flag is only ever what is written here, and a tap on a tab opens
     the ribbon for as long as the person wants it. */
  for (const key of ["aidocs.ribbonCollapsed", "ai-sheets-ribbon-collapsed", "ai-slides-ribbon-collapsed"]) {
    try { window.localStorage.setItem(key, "1"); } catch { /* no storage: the ribbon starts open */ }
  }
})();
