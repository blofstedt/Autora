/**
 * The design tokens are the only vocabulary the stylesheet speaks.
 *
 * src/styles.css grew to ~7,700 lines written by many hands, and drifted: 19 font
 * sizes with half-steps, 70 radii that were no token's, a dozen durations that
 * nobody could tell apart, the status colours written out as literals (so a
 * theme could not change them), and tokens used that nothing defined (a card
 * whose background was silently transparent). docs/DESIGN.md says what to use
 * instead; this test says when someone has not.
 *
 *   npx tsx tests/tokens.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    throw err;
  }
}

const css = read("src/styles.css");
const rail = read("src/rail.css");

/** The stylesheet without the block that defines the tokens and the block of themes (which are literals by nature). */
function body(text: string): string {
  const rootAt = text.indexOf(":root {");
  const rootEnd = text.indexOf("\n}\n", rootAt) + 3;
  const themes = text.indexOf("   Themes\n");
  const themesStart = text.lastIndexOf("/* ====", themes);
  const themesEnd = text.indexOf("/* Fonts. The monospace face");
  assert.ok(rootAt >= 0 && themes >= 0 && themesEnd > themesStart, "the stylesheet's layout changed: update this test");
  return (text.slice(0, rootAt) + text.slice(rootEnd, themesStart) + text.slice(themesEnd)).replace(/\/\*[\s\S]*?\*\//g, "");
}
const rules = body(css);

const lines = (text: string, re: RegExp) =>
  text.split("\n").map((l, i) => ({ l, i: i + 1 })).filter(({ l }) => re.test(l)).map(({ l, i }) => `${i}: ${l.trim().slice(0, 110)}`);

test("font sizes are the type scale, not calc(Npx * var(--ts))", () => {
  const bad = lines(rules, /font-size:\s*calc\(\s*[\d.]+px\s*\*\s*var\(--ts/);
  assert.deepEqual(bad, [], "use var(--fs-2xs … --fs-4xl)");
  const used = new Set([...rules.matchAll(/var\(--(fs-[a-z0-9]+)\)/g)].map((m) => m[1]));
  const defined = new Set([...css.matchAll(/--(fs-[a-z0-9]+):/g)].map((m) => m[1]));
  for (const u of used) assert.ok(defined.has(u), `--${u} is used but not defined`);
});

test("radii are tokens (or a circle, a hairline, or a device bezel)", () => {
  const bad: string[] = [];
  for (const m of rules.matchAll(/border(?:-[a-z]+)*-radius:\s*([^;}]+)/g)) {
    const v = m[1].replace(/var\([^)]*\)/g, "").replace(/!important/, "");
    for (const px of v.matchAll(/(\d+(?:\.\d+)?)px/g)) {
      if (![1, 2, 30].includes(Number(px[1]))) bad.push(m[0]);
    }
  }
  assert.deepEqual([...new Set(bad)], [], "use var(--r-2xs … --r-xl, --r-pill)");
});

test("durations and curves are the motion tokens", () => {
  const bad: string[] = [];
  for (const m of rules.matchAll(/(?<![\w-])(transition|animation):\s*([^;{}]+)/g)) {
    for (const item of m[2].split(/,(?![^(]*\))/)) {
      if (/infinite|steps\(|linear/.test(item)) continue;       // ambient loops and spinners keep their own tempo
      const time = /var\(--dur-/.test(item) ? null : item.match(/(?:^|\s)(\d*\.?\d+)(ms|s)\b/);   // a delay after a token is fine
      if (time) {
        const s = Number(time[1]) / (time[2] === "ms" ? 1000 : 1);
        if (s > 0 && s < 0.5) bad.push(`${m[1]}: ${item.trim()}`);
      }
      if (/(?:^|\s)(ease|ease-out|ease-in-out|ease-in)(?:\s|$)/.test(item)) bad.push(`${m[1]}: ${item.trim()}`);
    }
  }
  assert.deepEqual([...new Set(bad)], [], "use var(--dur-1 | --dur-2 | --dur-3) and var(--ease | --ease-spring)");
});

test("status colours come from the tokens, so a theme can change them", () => {
  const hex = lines(rules, /#(34d399|fb7185|fbbf24|f87171|6ee7b7|7c5cff|8b7cf6|6a58e0)\b/i);
  assert.deepEqual(hex, [], "use var(--live / --danger / --warn / --accent …)");
  const rgb = lines(rules, /rgba?\(\s*(52,\s*211,\s*153|251,\s*113,\s*133|251,\s*191,\s*36|110,\s*91,\s*255|124,\s*92,\s*255)\b/);
  assert.deepEqual(rgb, [], "use rgba(var(--live-rgb | --danger-rgb | --warn-rgb | --accent-rgb), a)");
});

test("every var(--token) is defined somewhere (or given a fallback)", () => {
  const files = [css, rail, ...walk("src").filter((f) => f.endsWith(".tsx") || f.endsWith(".ts")).map(read)].join("\n");
  const defined = new Set([...files.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1]));
  // Set per element by script or by a parent rule, read with a fallback or not at all when unset.
  const local = new Set(["--attention", "--bar", "--beat", "--bw", "--fx", "--fy", "--head", "--quarter", "--zoom", "--level", "--fill",
    "--chat-w", "--composer-h", "--composer-l", "--composer-w", "--rail-w", "--pt-r"]);
  const missing = new Set<string>();
  for (const m of files.matchAll(/var\((--[a-zA-Z0-9-]+)\s*\)/g)) {
    if (!defined.has(m[1]) && !local.has(m[1]) && !m[1].startsWith("--tw-")) missing.add(m[1]);
  }
  // lib/widget.ts styles a sandboxed frame with its own palette: --surface and --muted are defined there.
  assert.deepEqual([...missing].filter((n) => !["--surface", "--muted"].includes(n)), []);
  assert.ok(!/var\(--surface\)/.test(rules), "--surface is the widget frame's, not the app's: use --s1 / --s2");
});

test("the sandboxed editors take their palette from the page", () => {
  for (const f of ["office/shim/common.js", "office/shim/docs.js", "office/shim/sheets.js", "office/shim/slides.js"]) {
    const text = read(f);
    assert.ok(/var\(--autora-accent,/.test(text) || f.endsWith("sheets.js") || f.endsWith("slides.js"), `${f}: accent is not themed`);
    assert.ok(!/:\s*#6e5bff\s*!important/i.test(text), `${f}: the accent is a bare literal`);
    assert.ok(!/:\s*#0e1016\s*!important/i.test(text), `${f}: the surface is a bare literal`);
  }
  assert.ok(/autora:theme/.test(read("office/shim/common.js")), "the Office frame does not listen for the page's theme");
  assert.ok(/autora:theme/.test(read("spectra-editor/src/autora/host.ts")), "the PDF frame does not listen for the page's theme");
  assert.ok(/useFrameTheme/.test(read("src/components/SpectraWindow.tsx")) && /useFrameTheme/.test(read("src/components/OfficeWindow.tsx")));
});

test("fields share one focus ring", () => {
  const stray = lines(rules, /:focus(?:-visible)?\s*\{\s*outline:\s*none;\s*border-color:\s*var\(--accent-line\);\s*\}/);
  assert.deepEqual(stray, [], "add the selector to the shared text-field focus rule instead");
});

function walk(dir: string): string[] {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}

console.log(`${passed} passed`);
