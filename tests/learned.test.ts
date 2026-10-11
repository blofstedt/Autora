/**
 * The rows under "learned from this", in the real app.
 *
 * Three things it is easy to get wrong, all of them about a row that reads its
 * own state from the server rather than from the event that made it:
 *
 *   - opening one has to name the memory it would replace (the rewrite it was
 *     learned as), or the person is asked to keep a correction to something
 *     they cannot see;
 *   - an answer given somewhere else -- the Mind page keeps a memory, with the
 *     conversation still mounted underneath it -- has to reach the row without
 *     a reload;
 *   - and a thread that re-renders on every event of every turn must not
 *     cancel the row's check, or the row re-asks the server once per event and
 *     may never settle on what it found.
 *
 * The state is seeded the way the server leaves it after a turn that learned a
 * correction: the two memories are written through the API, and the
 * memory.learned event is appended to the session's log (the same JSON lines
 * the server writes) and read back by a restart. Nothing inside the app is
 * mocked, and the model is scripted by the harness.
 *
 *   npx tsx tests/learned.test.ts
 *   AUTORA_BROWSER_PATH=/usr/bin/chromium npx tsx tests/learned.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { sleep, startApp } from "./e2e-harness";

let passed = 0;
let failed = 0;
/** Every check runs, whichever ones fail: a run that stops at the first
    failure cannot say which of them the change it is proving had to fix. */
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${(err as Error).message.split("\n")[0]}`);
  }
}

const OLD_TITLE = "Media server restart: docker restart jellyfin";
const NEW_TITLE = "Media server restart: stop the container before starting it";

/** A session's log: AUTORA_HOME is the state directory's parent, and one turn
    has to have happened first for the file to be there. */
function sessionLog(home: string, session: string): string {
  return path.join(home, "settings", "sessions", session, "events.jsonl");
}

/** The memory.learned event a turn writes when it learns a correction, as the
    server writes it: appended to the session's log, read back on the next
    start. The tallies in meta.json go up with it, so the restarted server
    writes its next event above this one rather than over its number. */
function seedLearned(home: string, session: string, item: { id: string; revises: string }) {
  const file = sessionLog(home, session);
  const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
  const seq = lines.reduce((high, line) => Math.max(high, Number(JSON.parse(line)?.seq) || 0), 0) + 1;
  const event = {
    seq,
    ts: Math.floor(Date.now() / 1000),
    kind: "memory.learned",
    actor: "agent",
    span: null,
    payload: {
      items: [{ id: item.id, title: NEW_TITLE, kind: "procedure", action: "added", status: "provisional", revises: item.revises }],
      changes: [],
    },
    blob: null,
  };
  fs.appendFileSync(file, JSON.stringify(event) + "\n");
  const metaFile = path.join(path.dirname(file), "meta.json");
  const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
  meta.counts = { ...meta.counts, seq, events: (Number(meta.counts?.events) || 0) + 1 };
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
}

async function main() {
  const exe = process.env.AUTORA_BROWSER_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  if (!fs.existsSync(exe)) { console.log("  skip  no browser here"); return; }
  const app = await startApp();
  const browser = await chromium.launch({ executablePath: exe });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  try {
    const s = await app.newSession("Learned");
    const old = await app.api("POST", "/api/memory", {
      title: OLD_TITLE,
      body: "docker restart jellyfin gets the media server's library scan going again.",
      kind: "procedure",
    });
    const learned = await app.api("POST", "/api/memory", {
      title: NEW_TITLE,
      body: "Stop the container, then start it: a plain restart leaves the scan half-written.",
      kind: "procedure",
    });
    // Unconfirmed until it is kept, exactly as a learned one is.
    await app.api("PATCH", `/api/memory/${learned.body.id}`, { status: "provisional" });
    // A turn first, so the session's log is there to add the event to. It is
    // written a beat after the turn ends, not with it.
    await app.turn(s, "one line, so this session has a log");
    const log = sessionLog(app.home, s);
    for (let i = 0; i < 40 && !fs.existsSync(log); i += 1) await sleep(100);
    seedLearned(app.home, s, { id: learned.body.id, revises: old.body.id });
    await app.restart();
    assert.ok(
      (await app.events(s)).some((e) => e.kind === "memory.learned"),
      "the restarted server did not read the learned event back",
    );

    /* Every request the row makes for its own record, so a check that is
       cancelled and re-made can be counted. */
    const checks: number[] = [];
    page.on("request", (r) => {
      if (new URL(r.url()).pathname === `/api/memory/${learned.body.id}`) checks.push(Date.now());
    });

    await page.goto(`${app.base}/?session=${s}`);
    await page.waitForSelector(".learned-item", { timeout: 20_000 });
    const row = page.locator(".learned-item", { hasText: NEW_TITLE }).first();

    await test("a row nothing has answered is asking, and says what it would replace", async () => {
      await page.waitForFunction(
        (title) => [...document.querySelectorAll(".learned-item")].some((el) => el.textContent?.includes(title) && el.classList.contains("is-open")),
        NEW_TITLE,
        { timeout: 10_000 },
      );
      const shown = (await row.innerText()).replace(/\s+/g, " ");
      assert.match(shown, /a correction to an existing memory/);
      assert.match(shown, /Keep/);
    });

    await test("a turn streaming past the row does not make it ask again and again", async () => {
      // One record, looked at once for the ids it has -- not once per event of
      // the turn being written above it.
      checks.length = 0;
      app.decide = () => ({ text: "That is done, and everything came out in order.", slow: true });
      await app.turn(s, "say something while the row is on screen");
      await sleep(600);
      assert.ok(checks.length <= 3, `the row checked its record ${checks.length} times while one turn streamed`);
    });

    await test("opening a row names the memory it would replace", async () => {
      try {
        await row.locator(".learned-open").click();
        await page.waitForSelector(".peek-old", { timeout: 10_000 });
        assert.match(await page.innerText(".peek-old"), new RegExp(`Replaces “${OLD_TITLE}”`));
      } finally {
        await page.keyboard.press("Escape").catch(() => undefined);
        await page.waitForSelector(".peek", { state: "detached", timeout: 5_000 }).catch(() => undefined);
      }
    });

    await test("an answer given on the Mind page reaches the row without a reload", async () => {
      // The row is mounted; mark it, so a remount cannot quietly pass this.
      await row.evaluate((el) => el.setAttribute("data-probe", "1"));
      // Exactly the call the Mind page makes when a memory is kept.
      const kept = await app.api("POST", `/api/memory/${learned.body.id}/confirm`);
      assert.equal(kept.status, 200);
      // Off to the Mind page and back: the conversation stays mounted under it.
      await page.click('.rail-slot [data-page="mind"]');
      await page.waitForSelector(".learned-item", { state: "hidden", timeout: 10_000 });
      await page.click('.rail-slot [data-page="chat"]');
      await row.waitFor({ state: "visible", timeout: 10_000 });
      assert.equal(
        await page.locator(`.learned-item[data-probe="1"]`).count(),
        1,
        "the conversation was remounted on the way back, so this test could not see the bug it is about",
      );

      const settled = await page
        .waitForFunction(
          (title) => [...document.querySelectorAll(".learned-item")].some((el) => el.textContent?.includes(title) && el.classList.contains("is-kept")),
          NEW_TITLE,
          { timeout: 5_000 },
        )
        .then(() => true)
        .catch(() => false);
      const shown = (await row.innerText()).replace(/\s+/g, " ");
      assert.ok(settled, `the row still reads "${shown}" -- it only catches up on a reload`);
      assert.ok(!/Keep/.test(shown), `the row still offers Keep: "${shown}"`);
      assert.match(shown, /kept/);
    });
  } finally {
    await browser.close();
    await app.stop();
  }
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
