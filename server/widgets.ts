/**
 * Trying an explainer widget before anyone sees it.
 *
 * The agent writes a widget blind: it cannot look at the thread, and a
 * widget that throws on load or draws into a 300×150 corner is a blank card
 * to the person. So every widget is run here first, in a headless Chromium
 * of its own, the same way the thread runs it. It is left to settle, looked
 * at twice to see whether it moves, and then used: every button pressed,
 * every slider pushed, the canvas dragged. What happened comes back to the
 * agent as a report in words -- errors and when they happened, the text and
 * controls on screen, where the drawing is and in what colours, whether it
 * animates and whether each control changed the picture -- because a tool
 * result reaches every model as text, and a report is something the agent
 * can act on. A widget with errors is not shown; the agent fixes it and
 * tries again.
 *
 * This browser is not the one in ./browser.ts: that one carries the
 * person's sign-ins and cookies, and a widget has no business near them. It
 * starts on the first check and closes itself after a few idle minutes.
 */

import fs from "node:fs";
import path from "node:path";
import type { Browser, Page } from "playwright-core";
import { probeBrowser, systemBrowser } from "./browser";
import { DEFAULT_PALETTE, usesThree, widgetDocument } from "../src/lib/widget";

// ------------------------------------------------------------- Three.js --

let runtime: Promise<string> | null = null;

/** src/widget/three.ts as one file: prebuilt in production, built on first
    ask in development with the same esbuild the build uses. */
export function threeRuntime(): Promise<string> {
  runtime ??= (process.env.NODE_ENV === "production"
    ? fs.promises.readFile(path.join(process.cwd(), "dist", "widget", "three.js"), "utf8")
    : import("esbuild").then(async (esbuild) => {
        const out = await esbuild.build({
          entryPoints: [path.join(process.cwd(), "src", "widget", "three.ts")],
          bundle: true, format: "esm", minify: true, write: false,
        });
        return out.outputFiles[0].text;
      })
  ).catch((err) => {
    runtime = null;
    throw err;
  });
  return runtime;
}

async function threeDataUrl(): Promise<string | null> {
  try {
    return `data:text/javascript;base64,${Buffer.from(await threeRuntime(), "utf8").toString("base64")}`;
  } catch {
    return null;
  }
}

// -------------------------------------------------------------- browser --

/** How wide the thread's column draws a widget, near enough. */
const CHECK_WIDTH = 800;
const IDLE_CLOSE_MS = 3 * 60_000;
/** A widget that has not finished loading and being tried in this long is
    stuck -- an endless loop, most likely -- and is reported as such. */
const CHECK_BUDGET_MS = 25_000;
const LOAD_TIMEOUT_MS = 10_000;
/** Less than this share of the layout map changing is a focus ring or a
    hover colour, not the picture responding. */
const MOVED = 0.015;

let browser: Promise<Browser> | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let checking = 0;

async function checker(): Promise<Browser> {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  browser ??= (async () => {
    const { chromium } = await import("playwright-core");
    const executablePath = systemBrowser();
    const launched = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        // WebGL with no GPU: SwiftShader draws it on the CPU, which is slow
        // but real, so a 3D widget is checked rather than waved through.
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
        "--ignore-gpu-blocklist",
      ],
    });
    launched.on("disconnected", () => { browser = null; });
    return launched;
  })().catch((err) => {
    browser = null;
    throw err;
  });
  return browser;
}

function releaseChecker() {
  if (checking > 0) return;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    const closing = browser;
    browser = null;
    void closing?.then((b) => b.close()).catch(() => undefined);
  }, IDLE_CLOSE_MS);
  idleTimer.unref?.();
}

// ---------------------------------------------------------------- looks --

/** Records every canvas context asked for, and whether it was given. */
const INSTRUMENT = `
(() => {
  const seen = [];
  Object.defineProperty(window, "__autoraCanvases", { value: seen });
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const ctx = original.call(this, type, ...rest);
    if (!seen.some((s) => s.el === this && s.type === type)) seen.push({ el: this, type, ok: !!ctx });
    return ctx;
  };
})();
`;

type Look = {
  /** Share of the frame that is not background, 0-1. */
  coverage: number;
  background: string;
  colours: { hex: string; share: number }[];
  /** Rows of the layout map: "#" content, "." a little, " " background. */
  grid: string[];
  /** Mean colour per grid cell, for telling two looks apart. */
  cells: number[];
};

const GRID_COLS = 40;

/**
 * What the page looks like, from a screenshot, measured by the page itself:
 * the browser decodes the PNG, so nothing here needs an image library.
 */
async function look(page: Page): Promise<Look> {
  const png = await page.screenshot({ type: "png" });
  const url = `data:image/png;base64,${png.toString("base64")}`;
  return page.evaluate(LOOK_SCRIPT(url)) as Promise<Look>;
}

/** Run in the page, as text: the server is not typed against the DOM. */
const LOOK_SCRIPT = (url: string) => `
(async () => {
  const cols = ${GRID_COLS};
  const bitmap = await createImageBitmap(await (await fetch(${JSON.stringify(url)})).blob());
  const w = bitmap.width, h = bitmap.height;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  const px = ctx.getImageData(0, 0, w, h).data;

  // The background is whatever colour is most common, in coarse bins.
  const bin = (i) => ((px[i] >> 4) << 8) | ((px[i + 1] >> 4) << 4) | (px[i + 2] >> 4);
  const counts = new Map();
  for (let i = 0; i < px.length; i += 12) counts.set(bin(i), (counts.get(bin(i)) || 0) + 1);
  let bg = 0, most = 0;
  for (const [k, n] of counts) if (n > most) { most = n; bg = k; }
  const bgRgb = [((bg >> 8) & 15) * 16 + 8, ((bg >> 4) & 15) * 16 + 8, (bg & 15) * 16 + 8];
  const isBg = (i) =>
    Math.abs(px[i] - bgRgb[0]) + Math.abs(px[i + 1] - bgRgb[1]) + Math.abs(px[i + 2] - bgRgb[2]) < 36;

  const rows = Math.max(1, Math.round((cols * h) / w / 2));
  const cw = w / cols, ch = h / rows;
  const grid = [], cells = [];
  let content = 0, total = 0;
  const colourCounts = new Map();
  for (let r = 0; r < rows; r++) {
    let line = "";
    for (let c = 0; c < cols; c++) {
      let n = 0, on = 0, sr = 0, sg = 0, sb = 0;
      for (let y = Math.floor(r * ch); y < Math.floor((r + 1) * ch); y += 2) {
        for (let x = Math.floor(c * cw); x < Math.floor((c + 1) * cw); x += 2) {
          const i = (y * w + x) * 4;
          n++; sr += px[i]; sg += px[i + 1]; sb += px[i + 2];
          if (!isBg(i)) {
            on++;
            const k = bin(i);
            colourCounts.set(k, (colourCounts.get(k) || 0) + 1);
          }
        }
      }
      content += on; total += n;
      const share = n ? on / n : 0;
      line += share > 0.25 ? "#" : share > 0.02 ? "." : " ";
      cells.push(n ? sr / n : 0, n ? sg / n : 0, n ? sb / n : 0);
    }
    grid.push(line.replace(/\\s+$/, ""));
  }
  const hex = (k) => "#" + [(k >> 8) & 15, (k >> 4) & 15, k & 15]
    .map((v) => (v * 16 + 8).toString(16).padStart(2, "0")).join("");
  const colours = [...colourCounts.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([k, n]) => ({ hex: hex(k), share: n / Math.max(1, total) }))
    .filter((c) => c.share >= 0.003);
  return { coverage: total ? content / total : 0, background: hex(bg), colours, grid, cells };
})()
`;

/** Share of the layout map that visibly changed between two looks. */
function changed(a: Look, b: Look): number {
  const n = Math.min(a.cells.length, b.cells.length) / 3;
  if (!n) return 0;
  let moved = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(a.cells[i * 3] - b.cells[i * 3]) +
      Math.abs(a.cells[i * 3 + 1] - b.cells[i * 3 + 1]) +
      Math.abs(a.cells[i * 3 + 2] - b.cells[i * 3 + 2]);
    if (d > 6) moved++;
  }
  return moved / n;
}

// ---------------------------------------------------------------- facts --

type Control = { kind: string; label: string; detail: string };
type Facts = {
  text: string;
  controls: Control[];
  canvases: { w: number; h: number; types: string[]; failed: string[] }[];
  scrollW: number; scrollH: number;
  webgl: boolean;
};

const CONTROLS = "button, input[type=range], input[type=checkbox], input[type=radio], select, input[type=number]";

async function facts(page: Page): Promise<Facts> {
  return page.evaluate(FACTS_SCRIPT) as Promise<Facts>;
}

const FACTS_SCRIPT = `
(() => {
  const labelOf = (el) => {
    const aria = el.getAttribute("aria-label") || el.getAttribute("title");
    if (aria) return aria;
    const id = el.getAttribute("id");
    const byFor = id ? document.querySelector('label[for="' + CSS.escape(id) + '"]') : null;
    const label = byFor || el.closest("label");
    const text = ((label && label.textContent) || el.innerText || "").replace(/\\s+/g, " ").trim();
    return text.slice(0, 40) || id || el.tagName.toLowerCase();
  };
  const controls = [...document.querySelectorAll(${JSON.stringify(CONTROLS)})].slice(0, 16).map((el) => {
    const kind = el.tagName === "INPUT" ? el.type : el.tagName.toLowerCase();
    const detail = kind === "range" || kind === "number"
      ? (el.min || "?") + "–" + (el.max || "?") + ", now " + el.value
      : kind === "checkbox" || kind === "radio" ? (el.checked ? "on" : "off")
      : kind === "select" ? el.options.length + " options" : "";
    return { kind, label: labelOf(el), detail };
  });
  const seen = window.__autoraCanvases || [];
  const canvases = [...document.querySelectorAll("canvas")].slice(0, 6).map((c) => {
    const r = c.getBoundingClientRect();
    return {
      w: Math.round(r.width), h: Math.round(r.height),
      types: seen.filter((s) => s.el === c && s.ok).map((s) => s.type),
      failed: seen.filter((s) => s.el === c && !s.ok).map((s) => s.type),
    };
  });
  let webgl = false;
  try { webgl = !!document.createElement("canvas").getContext("webgl2"); } catch (e) {}
  return {
    text: ((document.body && document.body.innerText) || "").replace(/\\s+/g, " ").trim().slice(0, 500),
    controls, canvases, webgl,
    scrollW: document.documentElement.scrollWidth, scrollH: document.documentElement.scrollHeight,
  };
})()
`;

/** Push a slider or number box to the other end of its range. */
const NUDGE_SCRIPT = (index: number) => `
(() => {
  const input = document.querySelectorAll(${JSON.stringify(CONTROLS)})[${index}];
  const max = input.max !== "" ? Number(input.max) : Number(input.value) + 10;
  const min = input.min !== "" ? Number(input.min) : 0;
  const next = Number(input.value) >= max ? min : max;
  input.value = String(next);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return "set to " + next;
})()
`;

const OPTIONS_SCRIPT = (index: number) =>
  `document.querySelectorAll(${JSON.stringify(CONTROLS)})[${index}].options.length`;

/** The biggest canvas on the page, where a drag is most likely meant. */
const CANVAS_SCRIPT = `
(() => {
  let best = null;
  for (const c of document.querySelectorAll("canvas")) {
    const r = c.getBoundingClientRect();
    if (!best || r.width * r.height > best.w * best.h) best = { x: r.x, y: r.y, w: r.width, h: r.height };
  }
  return best;
})()
`;

// --------------------------------------------------------------- report --

export type WidgetCheck = {
  /** False when there was no browser to check it in. */
  checked: boolean;
  /** Fit to show: it ran without errors and drew something. */
  ok: boolean;
  /** What the agent is told. */
  report: string;
};

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Run the widget, try it, and say what happened. */
export async function checkWidget(widget: { title: string; html: string; height: number }): Promise<WidgetCheck> {
  const probe = await probeBrowser();
  if (!probe.ok) {
    return {
      checked: false, ok: true,
      report: `It could not be tried first (${probe.detail ?? "no browser on this server"}), so it is shown unchecked.`,
    };
  }
  checking++;
  let page: Page | null = null;
  try {
    const b = await checker();
    const context = await b.newContext({ viewport: { width: CHECK_WIDTH, height: widget.height }, deviceScaleFactor: 1 });
    page = await context.newPage();
    const run = tryWidget(page, widget);
    const timeout = new Promise<"stuck">((resolve) => {
      const t = setTimeout(() => resolve("stuck"), CHECK_BUDGET_MS);
      t.unref?.();
    });
    const result = await Promise.race([run, timeout]);
    if (result === "stuck") {
      void run.catch(() => undefined);
      return {
        checked: true, ok: false,
        report: `It stopped responding while it was being tried (more than ${CHECK_BUDGET_MS / 1000} s), ` +
          "which usually means an endless loop or a synchronous computation far too heavy for a browser. Nothing was shown.",
      };
    }
    return result;
  } catch (err: any) {
    return {
      checked: false, ok: true,
      report: `It could not be tried first (${String(err?.message ?? err).split("\n")[0]}), so it is shown unchecked.`,
    };
  } finally {
    void page?.context().close().catch(() => undefined);
    checking--;
    releaseChecker();
  }
}

async function tryWidget(page: Page, widget: { title: string; html: string; height: number }): Promise<WidgetCheck> {
  const problems: { when: string; text: string }[] = [];
  let phase = "while loading";
  page.on("pageerror", (e) => problems.push({ when: phase, text: e.message.split("\n")[0] }));
  /* A download that failed -- a web font, a texture -- is a warning: this
     server may simply be offline, and a script that needed it fails in its
     own right, which is an error. */
  const unloaded: string[] = [];
  page.on("console", (m) => {
    if (m.type() !== "error" || /^Failed to load resource/.test(m.text())) return;
    problems.push({ when: phase, text: m.text().split("\n")[0].slice(0, 300) });
  });
  page.on("requestfailed", (r) => {
    if (r.url().startsWith("data:")) return;
    unloaded.push(`${r.url().slice(0, 120)} (${r.failure()?.errorText ?? "failed"})`);
  });

  const bundle = usesThree(widget.html) ? await threeDataUrl() : null;
  // First thing in the head, so it is in place before any of the widget's
  // own scripts ask for a canvas.
  const doc = widgetDocument({ title: widget.title, html: widget.html, palette: DEFAULT_PALETTE, threeBundle: bundle })
    .replace(/<head[^>]*>/i, (tag) => `${tag}\n<script>${INSTRUMENT}</script>`);
  try {
    await page.setContent(doc, { waitUntil: "load", timeout: LOAD_TIMEOUT_MS });
  } catch (err: any) {
    if (!/timeout/i.test(String(err?.message))) throw err;
    return {
      checked: true, ok: false,
      report: `It did not finish loading within ${LOAD_TIMEOUT_MS / 1000} s, which usually means an endless loop ` +
        "or a synchronous computation far too heavy for a browser" +
        (problems.length ? `. Errors before that:\n${problems.map((p) => `- ${p.text}`).join("\n")}` : "") +
        ". Nothing was shown.",
    };
  }
  await page.waitForTimeout(1200);

  phase = "while running";
  const first = await look(page);
  await page.waitForTimeout(700);
  const second = await look(page);
  const motion = changed(first, second);
  const seen = await facts(page);

  // Use it: each control once, then a drag across the biggest canvas.
  const tried: string[] = [];
  let before = second;
  const controls = page.locator(CONTROLS);
  const count = Math.min(await controls.count(), 12);
  for (let i = 0; i < count; i++) {
    const control = seen.controls[i];
    if (!control) break;
    const el = controls.nth(i);
    const name = `${control.kind} "${control.label}"`;
    let did = "";
    phase = `after using ${name}`;
    const errorsBefore = problems.length;
    try {
      if (!(await el.isVisible())) { tried.push(`- ${name}: hidden, not tried`); continue; }
      if (control.kind === "range" || control.kind === "number") {
        did = String(await page.evaluate(NUDGE_SCRIPT(i)));
      } else if (control.kind === "select") {
        const options = Number(await page.evaluate(OPTIONS_SCRIPT(i)));
        if (options < 2) { tried.push(`- ${name}: one option, not tried`); continue; }
        await el.selectOption({ index: 1 }, { timeout: 1000 });
        did = "chose the second option";
      } else {
        await el.click({ timeout: 1000 });
        did = "clicked";
      }
    } catch {
      tried.push(`- ${name}: could not be used (covered by something, or disabled)`);
      continue;
    }
    await page.waitForTimeout(350);
    const after = await look(page);
    const errors = problems.length - errorsBefore;
    tried.push(`- ${name}: ${did}; ${errors ? `${errors} error${errors === 1 ? "" : "s"} (below)` : "no errors"}, ` +
      `picture ${changed(before, after) > MOVED ? `changed (${pct(changed(before, after))} of it)` : "did not change"}`);
    before = after;
  }

  const canvasBox = await page.evaluate(CANVAS_SCRIPT) as { x: number; y: number; w: number; h: number } | null;
  if (canvasBox && canvasBox.w > 40 && canvasBox.h > 40) {
    phase = "after dragging across the canvas";
    const errorsBefore = problems.length;
    const cx = canvasBox.x + canvasBox.w / 2, cy = canvasBox.y + canvasBox.h / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + Math.min(160, canvasBox.w / 3), cy + 30, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    const after = await look(page);
    const errors = problems.length - errorsBefore;
    tried.push(`- dragged across the canvas: ${errors ? `${errors} error${errors === 1 ? "" : "s"} (below)` : "no errors"}, ` +
      `picture ${changed(before, after) > MOVED ? `changed (${pct(changed(before, after))} of it)` : "did not change"}`);
  }

  // Errors that only say this server's browser has no WebGL are about here,
  // not about the widget; the person's browser almost certainly has it.
  const noWebgl = !seen.webgl;
  const real = problems.filter((p) => !(noWebgl && /webgl/i.test(p.text)));
  const unique = [...new Map(real.map((p) => [`${p.when}|${p.text}`, p])).values()].slice(0, 10);
  // A 3D scene cannot draw without WebGL, so blank is no verdict then.
  const blank = second.coverage < 0.003 && !seen.text && !(noWebgl && usesThree(widget.html));

  const lines: string[] = [];
  lines.push(`Tried in a headless browser at ${CHECK_WIDTH}×${widget.height}: loaded, watched for 2 seconds, then each control used once.`);
  if (unique.length) {
    lines.push("", `ERRORS (${unique.length}):`);
    for (const p of unique) lines.push(`- ${p.when}: ${p.text}`);
  }
  if (blank) lines.push("", "NOTHING IS VISIBLE: the frame is empty -- no drawing and no text.");
  lines.push(
    "",
    `On screen: ${pct(second.coverage)} of the frame has content, on a ${second.background} background` +
      (second.colours.length ? `; main colours ${second.colours.map((c) => `${c.hex} (${pct(c.share)})`).join(", ")}` : "") + ".",
    `Layout (${GRID_COLS} columns across the width; # content, . a little, blank = background):`,
    ...second.grid.map((row) => `|${row.padEnd(GRID_COLS)}|`),
  );
  if (seen.text) lines.push(`Text: "${seen.text}"`);
  lines.push(seen.controls.length
    ? `Controls: ${seen.controls.map((c) => `${c.kind} "${c.label}"${c.detail ? ` (${c.detail})` : ""}`).join("; ")}`
    : "Controls: none.");
  for (const c of seen.canvases) {
    lines.push(`Canvas: ${c.w}×${c.h}${c.types.length ? `, ${c.types.join("/")}` : ", no context"}${
      c.failed.length ? `, ${c.failed.join("/")} context refused` : ""}.`);
  }
  lines.push(motion > MOVED ? `Motion: animating (${pct(motion)} of the frame changed in 0.7 s).` : "Motion: still.");
  if (tried.length) lines.push("Used:", ...tried);

  const warnings: string[] = [];
  if (seen.canvases.some((c) => c.w === 300 && c.h === 150)) {
    warnings.push("a canvas is 300×150, the default size: it was probably never sized to the frame.");
  }
  if (seen.scrollW > CHECK_WIDTH + 4) warnings.push(`the content is ${seen.scrollW}px wide, wider than the ${CHECK_WIDTH}px frame, so it scrolls sideways.`);
  if (seen.scrollH > widget.height * 1.6) warnings.push(`the content is ${seen.scrollH}px tall against a height of ${widget.height}; the card grows to fit, but consider a taller height or a tighter layout.`);
  if (noWebgl && usesThree(widget.html)) warnings.push("this server's browser has no WebGL, so the 3D scene itself could not be checked here.");
  if (!blank && second.coverage < 0.02 && seen.canvases.length) warnings.push("the canvas is almost empty: check the camera, the scale and that something is drawn.");
  for (const u of unloaded.slice(0, 4)) warnings.push(`could not load ${u} here; the person's browser may, but inline what you can.`);
  if (warnings.length) lines.push("", "Warnings:", ...warnings.map((w) => `- ${w}`));

  return { checked: true, ok: unique.length === 0 && !blank, report: lines.join("\n") };
}
