/**
 * Pointing at things in the app being built.
 *
 * The app preview shows a page in the session's own browser, and the person
 * reviews it by selecting parts of it: an element, several, or a rectangle.
 * What the agent needs from a selection is not a blob of pixels but enough to
 * find the code that made it -- a selector that is unique on the page, the
 * words on it, the classes, the styles it ended up with, where it sits -- and,
 * where the framework tells us, the file and line it came from. This module is
 * the script that reads all of that out of the live page, and the words the
 * agent is told it in.
 *
 * The script runs in the page as a string (this server is compiled without
 * DOM types, and a function passed to Playwright is serialised anyway). Each
 * operation is one expression with its arguments embedded as JSON, because a
 * string given to `evaluate` is evaluated as an expression: an arrow function
 * left uninvoked would come back undefined.
 *
 * It only reads, bar the two operations that exist to try a change on the
 * page before it is asked for (style and text), and both remember what was
 * there so a reset puts it back. A hot-reload wipes them anyway, which is the
 * right thing: the agent's edit replaces the experiment.
 */

export interface Rect { x: number; y: number; w: number; h: number }

export interface PathStep { tag: string; id: string; classes: string[]; selector: string }

/** What is known about one element. */
export interface ElementInfo {
  selector: string;
  tag: string;
  id: string;
  classes: string[];
  /** The words on it, shortened. */
  text: string;
  /** All of them, for editing (up to 2000 characters). */
  fullText: string;
  /** Whether its words are its own: true when it has no element children,
      which is when changing the text is changing this element. */
  editableText: boolean;
  attrs: Record<string, string>;
  rect: Rect;
  styles: Record<string, string>;
  /** A short outerHTML, for the agent to match against source. */
  html: string;
  /** Its ancestors, nearest first, for stepping outwards. */
  path: PathStep[];
  children: number;
  /** Where the framework says it came from, when it says. */
  source: string | null;
  /** The component it belongs to, when the framework names one. */
  component: string | null;
  visible: boolean;
}

/** The properties the style editor may change. Anything else is refused: this
    is an experiment on a design, not a way to run script in the page. */
export const EDITABLE_STYLES = [
  "color", "background-color", "font-size", "font-weight", "font-style", "text-align",
  "line-height", "letter-spacing", "border-radius", "padding", "margin", "gap",
  "opacity", "width", "height", "border", "box-shadow", "display",
] as const;

const SAFE_VALUE = /^[#%(),.\w\s/+:-]{0,80}$/;

/** A style value that is only a value. No urls, no braces, no semicolons. */
export function safeStyle(property: string, value: unknown): string | null {
  if (!(EDITABLE_STYLES as readonly string[]).includes(property)) return null;
  const text = String(value ?? "").trim();
  if (!SAFE_VALUE.test(text) || /url\s*\(|expression|javascript|@import/i.test(text)) return null;
  return text;
}

const SOURCE = String.raw`(req) => {
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&"));
  const uniq = (sel) => { try { return document.querySelectorAll(sel).length === 1; } catch (e) { return false; } };
  const skipClass = (c) => !c || c.length > 40 || /^(css-|sc-|jsx-|svelte-|_|[a-z]{1,2}[0-9a-f]{5,}|[0-9])/i.test(c);

  const selectorOf = (el) => {
    if (!el || el.nodeType !== 1) return "";
    if (el === document.documentElement) return "html";
    if (el === document.body) return "body";
    if (el.id && uniq("#" + esc(el.id))) return "#" + esc(el.id);
    const steps = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body && cur !== document.documentElement) {
      let step = cur.tagName.toLowerCase();
      if (cur.id && uniq("#" + esc(cur.id))) { steps.unshift("#" + esc(cur.id)); break; }
      const classes = [...cur.classList].filter((c) => !skipClass(c)).slice(0, 2);
      if (classes.length) step += "." + classes.map(esc).join(".");
      const parent = cur.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === cur.tagName);
        if (same.length > 1) step += ":nth-of-type(" + (same.indexOf(cur) + 1) + ")";
      }
      steps.unshift(step);
      const joined = steps.join(" > ");
      if (uniq(joined)) return joined;
      cur = parent;
    }
    const full = steps.join(" > ");
    return full || el.tagName.toLowerCase();
  };

  const rectOf = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left * 10) / 10, y: Math.round(r.top * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 };
  };

  const clip = (s, n) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

  const sourceOf = (el) => {
    try {
      const svelte = el.__svelte_meta && el.__svelte_meta.loc;
      if (svelte) return { file: svelte.file + ":" + svelte.line, name: null };
      const vue = el.__vueParentComponent;
      if (vue && vue.type) return { file: vue.type.__file || null, name: vue.type.name || vue.type.__name || null };
      const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
      if (key) {
        let fiber = el[key];
        let file = null, name = null;
        for (let i = 0; fiber && i < 40; i++, fiber = fiber.return) {
          if (!file && fiber._debugSource) file = fiber._debugSource.fileName + ":" + fiber._debugSource.lineNumber;
          const t = fiber.type;
          if (!name && t && typeof t !== "string" && (t.displayName || t.name)) name = t.displayName || t.name;
          if (file && name) break;
        }
        return { file, name };
      }
    } catch (e) {}
    return { file: null, name: null };
  };

  const STYLE_KEYS = ["color", "backgroundColor", "fontSize", "fontWeight", "fontFamily", "textAlign", "lineHeight",
    "letterSpacing", "padding", "margin", "borderRadius", "border", "boxShadow", "display", "position", "width", "height",
    "gap", "opacity"];

  const describe = (el, light) => {
    const base = { selector: selectorOf(el), tag: el.tagName.toLowerCase(), rect: rectOf(el) };
    if (light) {
      const id = el.id ? "#" + el.id : "";
      const cls = [...el.classList].filter((c) => !skipClass(c)).slice(0, 2).map((c) => "." + c).join("");
      return { ...base, label: base.tag + id + cls };
    }
    const cs = getComputedStyle(el);
    const styles = {};
    for (const k of STYLE_KEYS) {
      let v = cs[k];
      if (k === "fontFamily") v = String(v).split(",")[0].replace(/["']/g, "").trim();
      if (k === "border") v = cs.borderTopWidth === "0px" ? "none" : cs.borderTopWidth + " " + cs.borderTopStyle + " " + cs.borderTopColor;
      if (k === "padding") v = cs.paddingTop + " " + cs.paddingRight + " " + cs.paddingBottom + " " + cs.paddingLeft;
      if (k === "margin") v = cs.marginTop + " " + cs.marginRight + " " + cs.marginBottom + " " + cs.marginLeft;
      if (k === "borderRadius") v = cs.borderTopLeftRadius;
      if (v !== undefined && v !== "") styles[k] = String(v);
    }
    const attrs = {};
    for (const a of ["href", "src", "alt", "type", "placeholder", "aria-label", "role", "name", "value", "title", "for", "data-testid"]) {
      const v = el.getAttribute(a);
      if (v) attrs[a] = clip(v, 120);
    }
    const path = [];
    for (let p = el.parentElement; p && p !== document.documentElement && path.length < 6; p = p.parentElement) {
      path.push({ tag: p.tagName.toLowerCase(), id: p.id || "", classes: [...p.classList].filter((c) => !skipClass(c)).slice(0, 3), selector: selectorOf(p) });
    }
    const ownText = el.children.length === 0;
    const html = el.cloneNode(false).outerHTML;
    const src = sourceOf(el);
    const visible = !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    return {
      ...base,
      id: el.id || "",
      classes: [...el.classList].filter((c) => !skipClass(c)).slice(0, 8),
      text: clip(el.innerText || el.textContent, 200),
      fullText: String(el.innerText || el.textContent || "").slice(0, 2000),
      editableText: ownText && !!(el.textContent || "").trim(),
      attrs, styles, path,
      html: clip(html + (ownText ? clip(el.textContent, 80) + "</" + base.tag + ">" : "…"), 300),
      children: el.children.length,
      source: src.file, component: src.name,
      visible,
    };
  };

  const find = (selector) => { try { return document.querySelector(selector); } catch (e) { return null; } };
  const store = window.__autoraPreviewOrig || (window.__autoraPreviewOrig = new WeakMap());
  const remember = (el) => { if (!store.has(el)) store.set(el, { style: el.getAttribute("style"), text: el.children.length === 0 ? el.textContent : null }); };

  switch (req.op) {
    case "at": {
      let el = document.elementFromPoint(req.x, req.y);
      if (!el) return null;
      return describe(el, !!req.light);
    }
    case "sel": {
      let el = find(req.selector);
      if (!el) return null;
      const nav = req.nav;
      if (nav === "parent") { if (el.parentElement && el.parentElement !== document.documentElement) el = el.parentElement; }
      else if (nav === "child") { const kids = [...el.children].filter((c) => c.offsetWidth || c.offsetHeight); if (kids.length) el = kids.sort((a, b) => b.offsetWidth * b.offsetHeight - a.offsetWidth * a.offsetHeight)[0]; }
      else if (nav === "next") { const n = el.nextElementSibling; if (n) el = n; }
      else if (nav === "prev") { const n = el.previousElementSibling; if (n) el = n; }
      return describe(el, !!req.light);
    }
    case "rects": {
      return {
        scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
        rects: (req.selectors || []).map((s) => { const el = find(s); return el ? rectOf(el) : null; }),
      };
    }
    case "style": {
      const el = find(req.selector);
      if (!el) return { ok: false, error: "That element is gone." };
      remember(el);
      const before = {};
      for (const [k, v] of Object.entries(req.css || {})) {
        before[k] = getComputedStyle(el).getPropertyValue(k);
        el.style.setProperty(k, v);
      }
      return { ok: true, before, info: describe(el, false) };
    }
    case "text": {
      const el = find(req.selector);
      if (!el) return { ok: false, error: "That element is gone." };
      if (el.children.length > 0) return { ok: false, error: "This element has other elements inside it; select the one that holds the words." };
      remember(el);
      el.textContent = req.text;
      return { ok: true, info: describe(el, false) };
    }
    case "reset": {
      const el = find(req.selector);
      if (!el) return { ok: false };
      const was = store.get(el);
      if (was) {
        if (was.style === null) el.removeAttribute("style"); else el.setAttribute("style", was.style);
        if (was.text !== null) el.textContent = was.text;
        store.delete(el);
      }
      return { ok: true, info: describe(el, false) };
    }
    case "scroll": {
      return { x: Math.round(window.scrollX), y: Math.round(window.scrollY), w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight };
    }
  }
  return null;
}`;

/** One operation, as an expression for page.evaluate. */
export function pickExpression(req: Record<string, unknown>): string {
  return `(${SOURCE})(${JSON.stringify(req)})`;
}

// ------------------------------------------------------------ for the agent --

/** One element, as the agent is told it. */
export function describeElement(info: ElementInfo): string {
  const lines: string[] = [];
  const name = `<${info.tag}${info.id ? ` id="${info.id}"` : ""}${info.classes.length ? ` class="${info.classes.join(" ")}"` : ""}>`;
  lines.push(`Element ${name}, selector: ${info.selector}`);
  if (info.text) lines.push(`  Text: "${info.text}"`);
  lines.push(`  Size: ${Math.round(info.rect.w)}×${Math.round(info.rect.h)} at ${Math.round(info.rect.x)},${Math.round(info.rect.y)} in the window`);
  const attrs = Object.entries(info.attrs).map(([k, v]) => `${k}="${v}"`).join(" ");
  if (attrs) lines.push(`  Attributes: ${attrs}`);
  const keep = ["color", "backgroundColor", "fontSize", "fontWeight", "padding", "margin", "borderRadius", "display", "width", "height"];
  const styles = keep.filter((k) => info.styles[k]).map((k) => `${k}: ${info.styles[k]}`).join("; ");
  if (styles) lines.push(`  Styles now: ${styles}`);
  if (info.component || info.source) {
    lines.push(`  From: ${[info.component ? `component ${info.component}` : "", info.source ?? ""].filter(Boolean).join(", ")}`);
  }
  if (info.path.length) {
    lines.push(`  Inside: ${info.path.slice(0, 4).map((p) => `${p.tag}${p.id ? `#${p.id}` : p.classes[0] ? `.${p.classes[0]}` : ""}`).join(" < ")}`);
  }
  lines.push(`  HTML: ${info.html}`);
  return lines.join("\n");
}

/** What the person changed on the page to show what they mean. */
export interface StyleChange { property: string; from: string; to: string }

export type CommentKind = "element" | "region";

/** One comment as the server keeps it until the review is sent. */
export interface ReviewComment {
  id: string;
  kind: CommentKind;
  /** What the person wrote. May be empty when a change says it all. */
  text: string;
  /** The elements it is about (one, or several selected together). */
  elements: ElementInfo[];
  /** For a region: the rectangle, in page pixels. */
  region?: Rect;
  /** The words on the element before and after an edit of them. */
  textEdit?: { from: string; to: string };
  styleChanges: StyleChange[];
  /** The crop's picture, as a blob id. */
  blob: string | null;
  /** Where the window was scrolled to, so a region can be found again. */
  scroll: { x: number; y: number };
  /** The size the page was shown at when it was commented on. */
  viewport: { width: number; height: number };
  ts: number;
}

/** The whole review, as one message to the agent. */
export function reviewMessage(input: {
  url: string;
  viewport: { width: number; height: number };
  device: string;
  comments: ReviewComment[];
  consoleErrors: string[];
}): string {
  const { comments } = input;
  const lines: string[] = [
    `[Autora: the person reviewed the app preview (${input.url}, shown at ${input.viewport.width}×${input.viewport.height}, ${input.device}) and left ` +
      `${comments.length} comment${comments.length === 1 ? "" : "s"}. Each has a picture attached, in order. ` +
      "Make the changes in the source, then look at the preview again to check them.]",
    "",
  ];
  comments.forEach((c, i) => {
    lines.push(`${i + 1}. ${c.text.trim() || (c.textEdit || c.styleChanges.length ? "(see the change below)" : "(no words: look at the picture)")}`);
    if (c.kind === "region" && c.region) {
      lines.push(
        `   Region: ${Math.round(c.region.w)}×${Math.round(c.region.h)} at ${Math.round(c.region.x)},${Math.round(c.region.y)} ` +
          `(page position ${Math.round(c.region.x + c.scroll.x)},${Math.round(c.region.y + c.scroll.y)})`,
      );
    }
    for (const el of c.elements.slice(0, 6)) lines.push(...describeElement(el).split("\n").map((l) => `   ${l}`));
    if (c.elements.length > 6) lines.push(`   …and ${c.elements.length - 6} more selected together.`);
    if (c.textEdit) lines.push(`   Change the text: "${c.textEdit.from}" -> "${c.textEdit.to}"`);
    if (c.styleChanges.length) {
      lines.push(`   Change the styles: ${c.styleChanges.map((s) => `${s.property}: ${s.from} -> ${s.to}`).join("; ")}`);
    }
    lines.push("");
  });
  if (input.consoleErrors.length) {
    lines.push("The page's console, for what it is worth:", ...input.consoleErrors.map((e) => `  ${e}`), "");
  }
  return lines.join("\n").trimEnd();
}
