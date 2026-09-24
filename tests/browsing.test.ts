/**
 * Working a page: what the agent is told about a form, and what its actions
 * do to it. The pure parts always run; the page itself runs in a real
 * Chromium when there is one (AUTORA_BROWSER_PATH, or Playwright's own).
 *
 *   npx tsx tests/browsing.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "autora-browsing-"));
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
  const { parseCookieExport, sitesOf } = await import("../server/cookies");
  const { keyName, refusalNote } = await import("../server/tools");
  const { refLine, sameValue, scrollLine, signInRefusal, normaliseNative, LiveBrowser, probeBrowser } =
    await import("../server/browser");

  console.log("cookie exports");
  const now = 1_800_000_000;
  await test("Cookie-Editor JSON", () => {
    const { cookies, expired } = parseCookieExport(JSON.stringify([
      { name: "SID", value: "abc", domain: ".google.com", path: "/", secure: true, httpOnly: true,
        sameSite: "no_restriction", expirationDate: now + 1000 },
      { name: "pref", value: "1", domain: "accounts.google.com", hostOnly: false, session: true },
      { name: "old", value: "x", domain: "github.com", expirationDate: now - 5 },
    ]), now);
    assert.equal(cookies.length, 2);
    assert.equal(expired, 1);
    assert.equal(cookies[0].sameSite, "None");
    assert.equal(cookies[1].domain, ".accounts.google.com");
    assert.equal(cookies[1].expires, -1);
    assert.deepEqual(sitesOf(cookies), ["google.com"]);
  });
  await test("storage state and cookies.txt", () => {
    const state = parseCookieExport(JSON.stringify({ cookies: [{ name: "a", value: "b", domain: "x.co.uk", expires: -1 }] }), now);
    assert.equal(state.cookies.length, 1);
    assert.deepEqual(sitesOf(state.cookies), ["x.co.uk"]);
    const txt = parseCookieExport(
      "# Netscape HTTP Cookie File\n#HttpOnly_.github.com\tTRUE\t/\tTRUE\t" + (now + 99) + "\tuser_session\tzzz\n",
      now,
    );
    assert.equal(txt.cookies[0].httpOnly, true);
    assert.equal(txt.cookies[0].value, "zzz");
  });
  await test("anything else is refused with a reason", () => {
    assert.throws(() => parseCookieExport("hello"), /not a cookie export/);
  });

  console.log("reading fields");
  await test("an element line carries purpose, type, choices and errors", () => {
    const line = refLine({
      ref: 3, role: "textbox", name: "Name", value: null, x: 0, y: 0, w: 1, h: 1, href: null,
      checked: null, disabled: false, purpose: "shipping first name", required: true,
      invalid: "Enter a name",
    });
    assert.equal(line, '[3] textbox "Name" (shipping first name) required INVALID: "Enter a name"');
    const select = refLine({
      ref: 4, role: "combobox", name: "Country", value: "Choose…", x: 0, y: 0, w: 1, h: 1, href: null,
      checked: null, disabled: false, options: ["Choose…", "Canada"], optionCount: 40,
    });
    assert.match(select, /options: "Choose…", "Canada" \(\+38 more\)/);
  });
  await test("where the page is scrolled to, in words", () => {
    assert.match(scrollLine({ y: 0, max: 0, view: 800, pane: false }), /nothing to scroll/);
    assert.match(scrollLine({ y: 1600, max: 1600, view: 800, pane: false }), /at the bottom, nothing more below/);
    assert.match(scrollLine({ y: 400, max: 1600, view: 800, pane: true }), /pane is 25% of the way down, about 1.5 screens more below/);
  });
  await test("values that were reformatted still count as filled", () => {
    assert.ok(sameValue("(555) 123-4567", "5551234567"));
    assert.ok(sameValue("jane@x.com", "jane@x.com"));
    assert.ok(!sameValue("", "Jane"));
    assert.equal(normaliseNative("date", "April 5, 1990"), "1990-04-05");
  });
  await test("keys as a person writes them", () => {
    assert.equal(keyName("esc"), "Escape");
    assert.equal(keyName("ctrl+a"), "Control+a");
    assert.equal(keyName("down"), "ArrowDown");
    assert.equal(keyName("PageDown"), "PageDown");
  });
  await test("a refused sign-in is recognised and explained", () => {
    const said = signInRefusal("Couldn't sign you in\nThis browser or app may not be secure. Learn more");
    assert.ok(said);
    assert.match(refusalNote(said!), /browser_signin_import/);
    assert.equal(signInRefusal("Sign in to continue to Gmail"), null);
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
  const url = `file://${path.resolve("tests/fixtures/form.html")}`;
  try {
    const page = await live.goto(url);
    const line = (pattern: RegExp) => {
      const found = page.outline.split("\n").find((l) => pattern.test(l));
      assert.ok(found, `no line matching ${pattern} in:\n${page.outline}`);
      return found!;
    };
    const refOf = (l: string) => Number(/^\[(\d+)\]/.exec(l)![1]);

    await test("div-labelled fields are named, and say which name they are", () => {
      assert.match(page.outline, /-- Shipping address --/);
      assert.match(line(/\(shipping first name\)/), /textbox "Name" \(shipping first name\) required/);
      assert.match(line(/\(shipping last name\)/), /textbox "Name"/);
    });
    await test("the page's own error on a field is shown", () => {
      assert.match(line(/"Email"/), /type=email.*INVALID: "Enter a valid email address"/);
    });
    await test("a dropdown lists its choices", () => {
      assert.match(line(/"Country"/), /combobox "Country" value="Choose…" options: "Choose…", "United States", "Canada", "Mexico"/);
    });
    await test("a restyled checkbox, a shadow-DOM field, a framed field and a clickable div are all there", () => {
      assert.match(line(/I agree to the terms/), /checkbox .*not checked/);
      assert.match(line(/"Username"/), /textbox "Username"/);
      assert.match(line(/"Coupon code"/), /textbox/);
      assert.match(page.outline, /clickable "Premium plan"/);
    });
    await test("the scroll position is reported", () => {
      assert.match(page.outline, /The page is at the top, about \d/);
    });

    await test("one fill sets text, a formatted phone, a dropdown, a date and a checkbox", async () => {
      const read = await live.fill([
        { ref: refOf(line(/\(shipping first name\)/)), text: "Jane" },
        { ref: refOf(line(/\(shipping last name\)/)), text: "Doe" },
        { ref: refOf(line(/"Phone"/)), text: "5551234567" },
        { ref: refOf(line(/"Country"/)), text: "canada" },
        { ref: refOf(line(/"Birthday"/)), text: "April 5, 1990" },
        { ref: refOf(line(/I agree/)), text: "yes" },
      ], true);
      const notes = read.notes!.join("\n");
      assert.match(notes, /holds "Jane"/);
      assert.match(notes, /holds "\(555\) 123-4567"/);
      assert.match(notes, /chose "Canada"/);
      assert.match(notes, /set to "1990-04-05"/);
      assert.match(notes, /checked\./);
      assert.match(read.text, /Submitted: Jane Doe \/ CA \/ terms=on/);
    });
    await test("a field inside a frame is typed into where it really is", async () => {
      const read = await live.fill([{ ref: refOf(line(/"Coupon code"/)), text: "SAVE10" }]);
      assert.match(read.notes!.join("\n"), /holds "SAVE10"/);
    });
    await test("a dropdown with no such option says what it has", async () => {
      const read = await live.fill([{ ref: refOf(line(/"Country"/)), text: "Narnia" }]);
      assert.match(read.notes!.join("\n"), /no option matches "Narnia". Its options: .*"Mexico"/);
    });
    await test("a div that is only clickable by script can be clicked", async () => {
      const read = await live.click(refOf(line(/"Premium plan"/)));
      assert.match(read.text, /tile clicked/);
    });

    await test("scrolling reports where it got to, and stops at the end", async () => {
      let read = await live.scroll({ screens: 1 });
      assert.match(read.outline, /% of the way down/);
      read = await live.scroll({ to: "bottom" });
      assert.match(read.outline, /at the bottom, nothing more below/);
      read = await live.scroll({ screens: 1 });
      assert.match(read.notes!.join(" "), /already at the bottom/);
      read = await live.scroll({ text: "Message 25" });
      assert.match(read.notes!.join(" "), /Found "Message 25"/);
      read = await live.scroll({ text: "no such words anywhere" });
      assert.match(read.notes!.join(" "), /is not in the page's text/);
    });
    await test("and back to the top", async () => {
      const read = await live.scroll({ to: "top" });
      assert.match(read.outline, /at the top/);
    });

    await test("an open dialog is named first, and Escape closes it", async () => {
      let read = await live.goto(`${url}?dialog`);
      assert.match(read.outline.split("\n")[0], /A dialog is open on top of the page: "Cookie preferences"/);
      assert.match(read.outline, /-- in dialog "Cookie preferences" --\n\[\d+\] button "Accept all"/);
      read = await live.press(["Escape"]);
      assert.doesNotMatch(read.outline, /A dialog is open/);
    });
  } finally {
    await live.close();
    fs.rmSync(home, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
