/**
 * What Settings -> Appearance may put on the page.
 *
 * The sizes, the column width and the corner widgets all arrive from a file
 * or a request, so each one is only ever used if it is one of the known names:
 * a hand-edited settings file, or a server one release behind, must fall back
 * to something the stylesheet understands rather than to a missing number --
 * which is what an undefined --ts would be.
 *
 *   npm test
 */
import assert from "node:assert/strict";
import {
  DEFAULT_APPEARANCE, dockCount, iconScale, saneAppearance, textScale,
} from "../src/lib/theme";
import { mergeAppearance } from "../server/state";

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

test("nothing at all gives the defaults", () => {
  const a = saneAppearance(undefined);
  assert.equal(a.theme, "violet");
  assert.equal(a.text, "default");
  assert.equal(a.icons, "default");
  assert.equal(a.column, "comfort");
  assert.equal(dockCount(a.dock), 0);
});

test("an older payload, with only a theme in it, keeps its theme", () => {
  const a = saneAppearance({ theme: "ember", font: "mono" });
  assert.equal(a.theme, "ember");
  assert.equal(a.font, "mono");
  // and everything the old payload never had comes back usable
  assert.equal(a.text, DEFAULT_APPEARANCE.text);
  assert.deepEqual(a.dock, DEFAULT_APPEARANCE.dock);
});

test("junk is refused rather than passed on", () => {
  const a = saneAppearance({
    theme: "chartreuse", font: 7, text: "huge", icons: {}, column: null,
    dock: { tl: "weather", tr: "usage" },
  });
  assert.equal(a.theme, "violet");
  assert.equal(a.font, "inter");
  assert.equal(a.text, "default");
  assert.equal(a.icons, "default");
  assert.equal(a.column, "comfort");
  assert.equal(a.dock.tl, "none");
  assert.equal(a.dock.tr, "usage");
});

test("the scales are numbers the stylesheet can multiply by", () => {
  assert.equal(textScale("default"), 1);
  assert.ok(textScale("largest") > textScale("large"));
  assert.ok(textScale("largest") > textScale("default"));
  assert.ok(textScale("small") < 1);
  assert.equal(iconScale("default"), 1);
  assert.ok(iconScale("largest") > iconScale("large"));
});

test("the server keeps the sizes and the corners too, and merges the corners", () => {
  const into = {
    theme: "violet" as const, font: "inter" as const,
    text: "default" as const, icons: "default" as const, column: "comfort" as const,
    dock: { tl: "none" as const, tr: "none" as const, bl: "none" as const, br: "none" as const },
  };
  mergeAppearance(into as any, {
    text: "large", column: "wide", dock: { tl: "system", br: "sessions" },
  });
  assert.equal(into.text, "large");
  assert.equal(into.column, "wide");
  assert.equal(into.dock.tl, "system");
  assert.equal(into.dock.br, "sessions");
  // the corners not mentioned are left alone, so one can be cleared on its own
  mergeAppearance(into as any, { dock: { tl: "none" } });
  assert.equal(into.dock.tl, "none");
  assert.equal(into.dock.br, "sessions");
  // and nonsense changes nothing
  mergeAppearance(into as any, { text: "enormous", dock: { tr: "weather" } });
  assert.equal(into.text, "large");
  assert.equal(into.dock.tr, "none");
});

console.log(`\n${passed} checks passed`);
