/**
 * Running JavaScript in the page: the instrument that reaches what the
 * outline cannot see, and the notes that stop the agent reading an unchanged
 * page for the twentieth time. The pure parts always run; the page itself
 * runs in a real Chromium when there is one.
 *
 *   npx tsx tests/eval.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "autora-eval-"));
process.env.AUTORA_HOME = home;

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    throw err;
  }
}

async function main() {
  const {
    describeScriptValue, lookKey, plainScriptError, SameLook, scriptAttempts,
    SAME_PAGE_NOTE, SAME_PICTURE_NOTE, LiveBrowser, probeBrowser,
  } = await import("../server/browser");

  console.log("the shape of a script");
  await test("an expression runs as it stands, so a click happens once", () => {
    const click = `__autora.click(__autora.byText("Save as draft"))`;
    const tries = scriptAttempts(click);
    assert.equal(tries[0], click);
    // Nothing may call the result of the expression: `(click())()` runs the
    // click, throws "is not a function" and runs it again on the retry.
    assert.doesNotMatch(tries[0], /\)\(\)$/);
  });
  await test("statements go in a function body, where return and const belong", () => {
    const [first, second] = scriptAttempts("const x = [1, 2]; return x.length;");
    assert.match(first, /^\(async \(\) => \{/);
    assert.match(first, /return x\.length/);
    assert.equal(second, "const x = [1, 2]; return x.length;");
  });
  await test("an arrow function written out is an expression still", () => {
    const { scriptAttempts: again } = { scriptAttempts };
    assert.equal(again("() => document.title")[0], "() => document.title");
  });
  await test("an IIFE is left alone", () => {
    const iife = "(() => { return 1; })()";
    assert.equal(scriptAttempts(iife)[0], iife);
  });

  console.log("what the script returned");
  await test("nothing, a value, and a value too long to paste in", () => {
    assert.match(describeScriptValue(undefined), /returned nothing/);
    assert.equal(describeScriptValue("Draft saved."), "Draft saved.");
    assert.equal(describeScriptValue(7), "7");
    assert.match(describeScriptValue({ a: [1, 2] }), /"a"/);
    const long = describeScriptValue("x".repeat(5000));
    assert.equal(long.length, 4001);
    assert.ok(long.endsWith("…"));
  });

  console.log("what a failed script says");
  await test("Playwright's stack is cut to the page's own words", () => {
    const raw = "page.evaluate: Error: nothing to act on: byText() found no element saying that\n"
      + "    at Object.el (eval at evaluate (:290:30), <anonymous>:16:25)\n"
      + "    at Object.click (eval at evaluate (:290:30), <anonymous>:20:23)";
    const said = plainScriptError({ message: raw });
    assert.equal(said, "nothing to act on: byText() found no element saying that");
    assert.doesNotMatch(said, /anonymous|eval at|Object\./);
  });
  await test("a script that will not parse says so, once", () => {
    const said = plainScriptError(new SyntaxError("Unexpected token 'const'"));
    assert.match(said, /not valid JavaScript/);
    assert.equal(said.split("\n").length, 1);
  });

  console.log("nothing changed");
  await test("the third identical look is the one that says so", () => {
    const look = new SameLook();
    assert.equal(look.seen("a", SAME_PAGE_NOTE), null);
    assert.equal(look.seen("a", SAME_PAGE_NOTE), null);
    assert.equal(look.seen("a", SAME_PAGE_NOTE), SAME_PAGE_NOTE);
    // ...and it keeps saying it rather than going quiet on the fourth.
    assert.equal(look.seen("a", SAME_PAGE_NOTE), SAME_PAGE_NOTE);
  });
  await test("anything else resets it", () => {
    const look = new SameLook();
    look.seen("a", SAME_PAGE_NOTE);
    look.seen("a", SAME_PAGE_NOTE);
    assert.equal(look.seen("b", SAME_PAGE_NOTE), null);
    assert.equal(look.seen("b", SAME_PAGE_NOTE), null);
    assert.equal(look.seen("b", SAME_PAGE_NOTE), SAME_PAGE_NOTE);
  });
  await test("a page keys on its address, its title and its outline", () => {
    const page = { url: "https://x.test/a", title: "A", outline: "[0] button \"Go\"", text: "Go" } as any;
    assert.equal(lookKey(page), lookKey({ ...page }));
    assert.notEqual(lookKey(page), lookKey({ ...page, outline: "[1] button \"Stop\"" }));
    assert.notEqual(lookKey(page), lookKey({ ...page, url: "https://x.test/b" }));
    // Reading a second part of the same page is not the same look.
    assert.notEqual(lookKey(page, 1), lookKey(page, 2));
  });
  await test("the note names the way out, not just the problem", () => {
    assert.match(SAME_PAGE_NOTE, /NOTHING CHANGED/);
    assert.match(SAME_PAGE_NOTE, /browser_eval/);
    assert.match(SAME_PAGE_NOTE, /__autora\.byText/);
    assert.match(SAME_PAGE_NOTE, /Escape is never the key/);
    assert.match(SAME_PAGE_NOTE, /browser_handoff/);
    assert.match(SAME_PICTURE_NOTE, /browser_eval/);
    assert.match(SAME_PICTURE_NOTE, /browser_handoff/);
  });

  console.log("a real page");
  const executable = process.env.AUTORA_BROWSER_PATH
    || ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium"]
      .find((p) => fs.existsSync(p));
  if (executable) process.env.AUTORA_BROWSER_PATH = executable;
  const probe = await probeBrowser();
  if (!probe.ok) {
    console.log(`  skip  no browser here (${probe.detail})`);
    console.log(`\n${passed} passed`);
    return;
  }

  const live = new LiveBrowser({
    onFrame: () => {}, onKeyframe: () => {}, onNav: () => {}, onAction: () => {},
    onFields: () => {}, watchers: () => 0,
  });
  const url = `file://${path.resolve("tests/fixtures/script-dialog.html")}`;
  try {
    const page = await live.goto(url);

    await test("a dialog drawn by script is on the page but has no ref to read", () => {
      const save = page.outline.split("\n").find((l) => l.includes("Save as draft"));
      // This is the trap: the words are there, but the element is a span with
      // a listener, and reading gives the agent nothing it can act on.
      assert.ok(save === undefined || /clickable/.test(save), `unexpected outline line: ${save}`);
    });

    await test("an expression is run and its value comes back", async () => {
      const ran = await live.runScript("document.title");
      assert.equal(ran.value, "Composer");
    });
    await test("statements are wrapped so return works", async () => {
      const ran = await live.runScript('const t = document.title; return t.toUpperCase();');
      assert.equal(ran.value, "COMPOSER");
    });
    await test("the page's own elements can be counted and named", async () => {
      const ran = await live.runScript('__autora.all("h1").map((h) => h.innerText)');
      assert.match(ran.value, /Write a post/);
      const hidden = await live.runScript('__autora.all(".prompt .btn").map((b) => b.innerText)');
      assert.match(hidden.value, /Save as draft/);
    });

    await test("a script can open the dialog and click the button by its words", async () => {
      const opened = await live.runScript('__autora.click(__autora.byText("Close composer"))');
      assert.equal(opened.value, "Close composer");
      assert.equal(opened.hits.length, 1);
      const saved = await live.runScript('__autora.click(__autora.byText("Save as draft"))');
      assert.equal(saved.value, "Save as draft");
      assert.match(saved.page.text, /Draft saved\./);
      // Exact name matched, and clicked exactly once: a "Discard" clicked twice
      // would be the post gone.
      const seen = await live.runScript("window.seen.join(\",\")");
      assert.equal(seen.value, "save");
    });
    await test("a click that finds nothing says so in words the agent can act on", async () => {
      const missed = await live.runScript('__autora.click(__autora.byText("Publish"))');
      assert.match(missed.value, /^The script failed: nothing to act on/);
      assert.doesNotMatch(missed.value, /anonymous|eval at|playwright/i);
      const selector = await live.runScript('__autora.click("#no-such-thing")');
      assert.match(selector.value, /no element matches the selector "#no-such-thing"/);
      assert.equal(selector.hits.length, 0);
    });
    await test("a script that throws is reported, and the page is still read", async () => {
      const boom = await live.runScript('throw new Error("boom")');
      assert.match(boom.value, /The script failed: boom/);
      assert.match(boom.page.outline, /Write a post/);
    });
    await test("the same page read three times gets the way-out note", async () => {
      const first = await live.snapshot();
      const second = await live.snapshot();
      const third = await live.snapshot();
      assert.equal(live.lookNote(first), null);
      assert.equal(live.lookNote(second), null);
      assert.equal(live.lookNote(third), SAME_PAGE_NOTE);
    });
  } finally {
    await live.close().catch(() => undefined);
  }

  console.log(`\n${passed} passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
