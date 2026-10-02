/**
 * Looking at an app the way a developer's tools do: what it fetched, what is
 * wrong with its structure, and what changed on screen.
 *
 * app_preview's `look` gives a picture and the console. These are the checks
 * a picture cannot make: the Network tab (a failed request, a slow or huge
 * one, the API calls the page makes), an accessibility audit read from the
 * page's own structure (missing labels and alt text, low contrast, tiny tap
 * targets, skipped headings), and a before/after comparison of the screen
 * (take a baseline, change the code, diff) with what moved marked in red.
 * All plain code over the preview's own browser.
 */

import type { LiveBrowser, NetEntry } from "./browser";

const kb = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
const short = (url: string, max = 110) => (url.length > max ? `${url.slice(0, max - 1)}…` : url);

// ---------------------------------------------------------------- network --

export function networkReport(rows: NetEntry[], opts: { list?: boolean } = {}): string {
  if (!rows.length) return "No requests have been recorded since the last reload.";
  const byType = new Map<string, number>();
  for (const r of rows) byType.set(r.type, (byType.get(r.type) ?? 0) + 1);
  const bad = rows.filter((r) => r.failed || (r.status !== null && r.status >= 400));
  const slow = rows.filter((r) => (r.ms ?? 0) > 1500).sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0)).slice(0, 5);
  const big = rows.filter((r) => (r.size ?? 0) > 500_000).sort((a, b) => (b.size ?? 0) - (a.size ?? 0)).slice(0, 5);
  const api = rows.filter((r) => r.type === "xhr" || r.type === "fetch");
  const out = [`${rows.length} requests: ${[...byType.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${n} ${t}`).join(", ")}.`];
  if (bad.length) out.push(`Failed (${bad.length}):`, ...bad.slice(0, 12).map((r) => `  #${r.id} ${r.method} ${short(r.url)} -> ${r.failed ?? r.status}`));
  else out.push("None failed.");
  if (slow.length) out.push("Slow (over 1.5 s):", ...slow.map((r) => `  #${r.id} ${short(r.url)} ${((r.ms ?? 0) / 1000).toFixed(1)} s`));
  if (big.length) out.push("Large (over 500 KB):", ...big.map((r) => `  #${r.id} ${short(r.url)} ${kb(r.size ?? 0)}`));
  if (api.length) out.push(`API calls (${api.length}):`, ...api.slice(-15).map((r) => `  #${r.id} ${r.method} ${short(r.url)} -> ${r.status ?? "pending"}${r.mime ? ` ${r.mime}` : ""}`));
  if (opts.list) out.push("All:", ...rows.slice(-60).map((r) => `  #${r.id} ${r.method} ${r.type} ${short(r.url, 90)} -> ${r.failed ?? r.status ?? "pending"}`));
  return out.join("\n");
}

// ------------------------------------------------------------------- a11y --

/** Runs in the page. Returns a list of {rule, where, detail}. */
const A11Y_SOURCE = `() => {
  const issues = [];
  const add = (rule, el, detail) => issues.push({ rule, where: sel(el), detail: detail || "" });
  const sel = (el) => {
    if (!el || !el.tagName) return "page";
    if (el.id) return el.tagName.toLowerCase() + "#" + el.id;
    const cls = (el.getAttribute("class") || "").trim().split(/\\s+/).filter(Boolean).slice(0, 2).join(".");
    return el.tagName.toLowerCase() + (cls ? "." + cls : "");
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0;
  };
  const text = (el) => (el.textContent || "").replace(/\\s+/g, " ").trim();
  const nameOf = (el) => {
    const aria = el.getAttribute("aria-label"); if (aria && aria.trim()) return aria.trim();
    const by = el.getAttribute("aria-labelledby");
    if (by) { const t = by.split(/\\s+/).map((id) => { const n = document.getElementById(id); return n ? text(n) : ""; }).join(" ").trim(); if (t) return t; }
    if (el.getAttribute("title")) return el.getAttribute("title");
    const t = text(el); if (t) return t;
    const img = el.querySelector("img[alt]"); if (img && img.getAttribute("alt").trim()) return img.getAttribute("alt");
    const svgTitle = el.querySelector("svg title"); if (svgTitle && text(svgTitle)) return text(svgTitle);
    return "";
  };
  if (!document.documentElement.getAttribute("lang")) add("html-lang", document.documentElement, "the page has no lang attribute");
  if (!document.querySelector('meta[name="viewport"]')) add("viewport", document.documentElement, "no viewport meta: a phone shows the desktop layout");
  if (!document.title.trim()) add("title", document.documentElement, "the page has no title");
  for (const img of document.querySelectorAll("img")) {
    if (!img.hasAttribute("alt") && img.getAttribute("role") !== "presentation" && visible(img)) add("img-alt", img, "image without alt text (use alt=\\"\\" if decorative)");
  }
  for (const el of document.querySelectorAll("input, select, textarea")) {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (["hidden", "submit", "button", "reset", "image"].includes(type) || !visible(el)) continue;
    const labelled = el.labels && el.labels.length > 0 || el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || el.getAttribute("title");
    if (!labelled) add("form-label", el, "form field with no label" + (el.getAttribute("placeholder") ? " (a placeholder is not a label)" : ""));
  }
  for (const el of document.querySelectorAll("button, a[href], [role=button], [role=link]")) {
    if (!visible(el)) continue;
    if (!nameOf(el)) add("control-name", el, "a " + (el.tagName === "A" ? "link" : "button") + " with no text or accessible name");
  }
  let last = 0, h1 = 0;
  for (const h of document.querySelectorAll("h1,h2,h3,h4,h5,h6")) {
    if (!visible(h)) continue;
    const n = Number(h.tagName[1]);
    if (n === 1) h1++;
    if (last && n > last + 1) add("heading-order", h, "jumps from h" + last + " to h" + n);
    last = n;
  }
  if (h1 === 0) add("h1", document.body, "the page has no h1");
  if (h1 > 1) add("h1", document.body, h1 + " h1 headings");
  const ids = new Map();
  for (const el of document.querySelectorAll("[id]")) ids.set(el.id, (ids.get(el.id) || 0) + 1);
  for (const [id, n] of ids) if (n > 1) add("duplicate-id", document.getElementById(id), "id \\"" + id + "\\" is used " + n + " times");
  for (const el of document.querySelectorAll("[tabindex]")) if (Number(el.getAttribute("tabindex")) > 0) add("tabindex", el, "positive tabindex breaks the natural order");
  for (const el of document.querySelectorAll("a[href], button, input:not([type=hidden]), select, textarea, [role=button]")) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 24 || r.height < 24) add("tap-target", el, "only " + Math.round(r.width) + "x" + Math.round(r.height) + " px (24 is the least; 44 is comfortable)");
  }
  const parse = (c) => { const m = c.match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const p = m[1].split(",").map((x) => parseFloat(x)); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const bgOf = (el) => {
    let layers = [];
    for (let e = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.backgroundImage && cs.backgroundImage !== "none") return null;
      const c = parse(cs.backgroundColor);
      if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; }
    }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base);
    return base;
  };
  let checked = 0;
  const seen = new Set();
  for (const el of document.querySelectorAll("body *")) {
    if (checked >= 500) break;
    if (!el.childNodes.length || ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    if (!visible(el)) continue;
    checked++;
    const cs = getComputedStyle(el);
    const fg = parse(cs.color); const bg = bgOf(el);
    if (!fg || !bg) continue;
    const front = over(fg, bg);
    const a = lum(front), b = lum(bg);
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const size = parseFloat(cs.fontSize), bold = Number(cs.fontWeight) >= 700;
    const need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
    if (ratio < need) {
      const key = cs.color + cs.backgroundColor + cs.fontSize;
      if (seen.has(key)) continue;
      seen.add(key);
      add("contrast", el, "contrast " + ratio.toFixed(2) + ":1, needs " + need + ":1 (" + cs.color + " on " + (bg ? "rgb(" + Math.round(bg.r) + "," + Math.round(bg.g) + "," + Math.round(bg.b) + ")" : "?") + ") -- " + text(el).slice(0, 40));
    }
  }
  return issues;
}`;

export interface A11yIssue { rule: string; where: string; detail: string }

export function a11yReport(issues: A11yIssue[]): string {
  if (!issues.length) return "No accessibility problems found by the automatic checks (labels, alt text, names, contrast, headings, tap targets). This does not replace trying it with a keyboard and a screen reader.";
  const by = new Map<string, A11yIssue[]>();
  for (const i of issues) by.set(i.rule, [...(by.get(i.rule) ?? []), i]);
  const out = [`${issues.length} accessibility problem${issues.length === 1 ? "" : "s"} in ${by.size} kind${by.size === 1 ? "" : "s"}:`];
  for (const [rule, list] of [...by.entries()].sort((a, b) => b[1].length - a[1].length)) {
    out.push(`${rule} (${list.length}):`, ...list.slice(0, 5).map((i) => `  ${i.where}: ${i.detail}`), ...(list.length > 5 ? [`  ... ${list.length - 5} more`] : []));
  }
  return out.join("\n");
}

export async function runA11y(live: LiveBrowser): Promise<string> {
  const issues = await live.evalJson<A11yIssue[]>(A11Y_SOURCE);
  return a11yReport(Array.isArray(issues) ? issues : []);
}

// ------------------------------------------------------------------- diff --

const baselines = new Map<string, { png: Buffer; at: number; url: string }>();

export function keepBaseline(key: string, png: Buffer, url: string) {
  baselines.set(key, { png, at: Date.now(), url });
}

export function dropBaseline(key: string) {
  baselines.delete(key);
}

export function hasBaseline(key: string): boolean {
  return baselines.has(key);
}

/** Group changed grid cells that touch into regions, biggest first. */
export function regionsOf(cells: { x: number; y: number; n: number }[], cell: number): { x: number; y: number; w: number; h: number; n: number }[] {
  const at = new Map(cells.map((c) => [`${c.x},${c.y}`, c]));
  const seen = new Set<string>();
  const out: { x: number; y: number; w: number; h: number; n: number }[] = [];
  for (const c of cells) {
    const k = `${c.x},${c.y}`;
    if (seen.has(k)) continue;
    const stack = [c];
    seen.add(k);
    let x0 = c.x, y0 = c.y, x1 = c.x, y1 = c.y, n = 0;
    while (stack.length) {
      const cur = stack.pop()!;
      n += cur.n;
      x0 = Math.min(x0, cur.x); y0 = Math.min(y0, cur.y); x1 = Math.max(x1, cur.x); y1 = Math.max(y1, cur.y);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const nk = `${cur.x + dx},${cur.y + dy}`;
        const next = at.get(nk);
        if (next && !seen.has(nk)) { seen.add(nk); stack.push(next); }
      }
    }
    out.push({ x: x0 * cell, y: y0 * cell, w: (x1 - x0 + 1) * cell, h: (y1 - y0 + 1) * cell, n });
  }
  return out.sort((a, b) => b.n - a.n);
}

export interface DiffReport {
  summary: string;
  marked: Buffer | null;
}

export async function runDiff(live: LiveBrowser, key: string, now: Buffer): Promise<DiffReport> {
  const was = baselines.get(key);
  if (!was) return { summary: "There is no baseline to compare with. Take one first with app_preview baseline, change the code, then diff.", marked: null };
  const cell = 40;
  const r = await live.compareImages(was.png, now, cell);
  const pct = (r.changed / r.total) * 100;
  if (r.changed === 0) return { summary: `No visible difference from the baseline taken ${Math.round((Date.now() - was.at) / 1000)} s ago.`, marked: null };
  const regions = regionsOf(r.cells, cell).slice(0, 8);
  return {
    summary:
      `${pct < 0.01 ? "<0.01" : pct.toFixed(2)}% of the picture changed from the baseline (${r.width}x${r.height}). ` +
      `Where (x, y, width x height, from the top-left): ` +
      regions.map((g) => `${g.x},${g.y} ${Math.min(g.w, r.width - g.x)}x${Math.min(g.h, r.height - g.y)}`).join("; ") +
      `. The picture of the current page with the changes in red is in this result.`,
    marked: r.marked,
  };
}
