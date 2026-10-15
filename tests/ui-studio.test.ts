/**
 * Autora Music as a person uses it, in a real browser: the window opens beside the chat, a first part is one click,
 * notes are drawn on the roll, the song plays and bounces to a real WAV, and what the agent does shows up live.
 *
 *   npx tsx tests/ui-studio.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium, type Page } from "playwright-core";
import { sleep, startApp } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

async function main() {
  const exe = process.env.AUTORA_BROWSER_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  if (!fs.existsSync(exe)) { console.log("  skip  no browser here"); return; }
  const shots = process.env.STUDIO_SHOTS || "";
  const app = await startApp();
  const browser = await chromium.launch({ executablePath: exe, args: ["--autoplay-policy=no-user-gesture-required"] });
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 820 }, acceptDownloads: true });
  const errors: string[] = [];
  const page: Page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  const shot = async (name: string) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png` }); };
  try {
    const s = await app.newSession("Music", "build");
    await page.goto(`${app.base}/?session=${s}`);
    await page.waitForSelector('textarea[aria-label="Task"]');
    const doc = async () => (await app.api("GET", `/api/studio/${s}/doc`)).body.doc;
    const until = async (what: string, fn: () => Promise<boolean> | boolean, ms = 8000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (await fn()) return; await sleep(100); }
      throw new Error(`timed out: ${what}`);
    };

    await test("opening it from the server puts the window beside the chat, on an empty song with four ways to start", async () => {
      assert.equal((await app.api("POST", `/api/studio/${s}/open`)).status, 200);
      await page.waitForSelector('[data-pane="studio"] .st-window');
      assert.equal(await page.locator(".st-start").count(), 4);
      await shot("1-empty");
    });

    await test("one click makes a drum part you can hear straight away, and it is saved", async () => {
      await page.click(".st-start:has-text('Beat')");
      await page.waitForSelector(".st-clip");
      await until("the server has the track", async () => (await doc()).tracks.length === 1);
      const d = await doc();
      assert.equal(d.tracks[0].instrument, "kit");
      assert.ok(d.tracks[0].clips[0].notes.length > 20);
      assert.ok(await page.locator(".st-step.is-on").count() > 5, "the drum grid shows the hits");
    });

    await test("chords come in the song's key; the piano roll shows them and a click draws a note", async () => {
      await page.click('.rail-bar button[aria-label="Add track"]');
      await page.click(".rail-tray .st-add-chip:has-text('Keys')");
      await page.waitForSelector(".st-row:nth-child(3)");
      // Make a clip on the new track by dragging across its lane.
      const lane = page.locator(".st-lane").nth(1);
      const box = (await lane.boundingBox())!;
      await page.mouse.move(box.x + 8, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + 8 + 28 * 8, box.y + box.height / 2, { steps: 6 });
      await page.mouse.up();
      await page.waitForSelector(".st-roll .st-grid");
      const view = (await page.locator(".st-roll-scroll").boundingBox())!;
      await page.mouse.click(view.x + 52 + 120, view.y + 80);
      await until("a note is saved", async () => (await doc()).tracks[1]?.clips[0]?.notes.length === 1);
      assert.ok(await page.locator(".st-note").count() >= 1);
      await shot("2-roll");
    });

    await test("with Visible work off, the agent's change appears, lights the clip it touched, and one Ctrl+Z takes it back", async () => {
      await app.api("PATCH", "/api/agent-cursor", { on: false });
      const before = (await doc()).tracks.length;
      app.script.push({ tools: [{ name: "studio_make", args: { kind: "bass", progression: "C G Am F", style: "eighths", bars: 4 } }] });
      app.script.push({ text: "Bass line in." });
      await app.turn(s, "add a bass line to my song");
      await until("the bass track shows", async () => (await page.locator(".st-row").count()) === before + 1 + 1 - 0 || (await page.locator(".st-name:has-text('Bass')").count()) > 0);
      await page.waitForSelector(".st-clip.is-flash", { timeout: 4000 });
      await shot("3-agent");
      await page.locator(".st-window").focus();
      await page.keyboard.press("Control+z");
      await until("the bass is gone again", async () => (await page.locator(".st-name:has-text('Bass')").count()) === 0);
      await until("and the server agrees", async () => (await doc()).tracks.length === before);
      await app.api("PATCH", "/api/agent-cursor", { on: true });
    });

    const told = () => JSON.stringify(app.seen.flatMap((r) => r.messages).filter((m: { role: string }) => m.role === "tool").slice(-1));
    /** Whether the agent's pointer showed while `run` went, and how many notes the window had at its busiest. */
    const watching = async (run: () => Promise<unknown>) => {
      let seen = false;
      let on = true;
      void (async () => { while (on) { if (await page.locator(".agent-pointer-layer.is-on").count()) seen = true; await sleep(60); } })();
      await run();
      on = false;
      return seen;
    };

    await test("with Visible work on, the agent adds a track by hand: Add track, the instrument, its name typed in", async () => {
      app.script.push({ tools: [{ name: "studio_track", args: { action: "add", instrument: "pad", name: "Strings" } }] });
      app.script.push({ text: "Added." });
      const seen = await watching(() => app.turn(s, "add a pad track called Strings", 120_000));
      assert.ok(seen, "the agent's pointer was there");
      assert.match(told(), /Done by hand in the Music window/, told().slice(-1200));
      assert.match(told(), /added a pad track with Add track/);
      assert.match(told(), /named a track \\"Strings\\"/);
      await page.waitForSelector(".st-name:has-text('Strings')");
      assert.ok((await doc()).tracks.some((t: { name: string; instrument: string }) => t.name === "Strings" && t.instrument === "pad"));
      assert.equal(await page.locator(".st-clip.is-flash").count(), 0, "nothing lit up: the person watched it being done");
    });

    await test("with Visible work on, a clip is drawn on its lane and its notes placed in the piano roll by hand", async () => {
      const notes = [{ pitch: 60, start: 0, length: 1 }, { pitch: 64, start: 1, length: 1 }, { pitch: 67, start: 2, length: 2 }];
      app.script.push({ tools: [{ name: "studio_clip", args: { action: "add", track: "Strings", bar: 1, bars: 1, name: "Pad chords", notes } }] });
      app.script.push({ text: "Drawn." });
      let filming = Boolean(shots);
      const film = (async () => { for (let i = 0; filming && i < 40; i++) { await sleep(1500); await page.screenshot({ path: `${shots}/hand-${i}.png` }).catch(() => undefined); } })();
      await app.turn(s, "write a little line on the strings", 180_000);
      filming = false;
      await film;
      assert.match(told(), /drew a clip on its lane/, told().slice(-1500));
      assert.match(told(), /placed 3 notes in the piano roll/);
      const d = await doc();
      const clip = d.tracks.find((t: { name: string }) => t.name === "Strings").clips[0];
      assert.equal(clip.name, "Pad chords");
      await sleep(600);
      assert.equal(await page.locator(".st-clip-name-input").inputValue(), "Pad chords", "the clip it drew is still open in the roll, the finished song taken in under it");
      assert.equal(await page.locator(".st-roll .st-note").count(), 3);
      assert.match(told(), new RegExp(`clip ${clip.id}`), "the agent is told the clip's id as the window has it");
      assert.deepEqual(clip.notes.map((n: { pitch: number; start: number; length: number }) => [n.pitch, n.start, n.length]).sort(), [[60, 0, 1], [64, 1, 1], [67, 2, 2]]);
      await shot("3b-hand");
    });

    await test("with Visible work on, the tempo is typed into the Song tray and hits are clicked into the drum grid", async () => {
      const drums = (await doc()).tracks.find((t: { instrument: string }) => t.instrument === "kit");
      const beat = drums.clips[0];
      app.script.push({ tools: [{ name: "studio_song", args: { bpm: 96 } }] });
      app.script.push({ tools: [{ name: "studio_notes", args: { action: "replace", clip: beat.id, notes: [{ pitch: "kick", start: 0 }, { pitch: "snare", start: 1 }, { pitch: "kick", start: 2 }, { pitch: "snare", start: 3 }] } }] });
      app.script.push({ text: "Done." });
      await app.turn(s, "slow it to 96 and simplify the beat", 240_000);
      const all = JSON.stringify(app.seen.flatMap((r) => r.messages).filter((m: { role: string }) => m.role === "tool").slice(-2));
      assert.match(all, /set the tempo to 96 in the Song tray/, all.slice(-2000));
      assert.match(all, /pressed Clear in the piano roll/);
      assert.match(all, /placed 4 notes in the drum grid/);
      const d = await doc();
      assert.equal(d.bpm, 96);
      assert.equal(d.tracks.find((t: { id: string }) => t.id === drums.id).clips[0].notes.length, 4);
    });

    await test("play moves the playhead and makes sound; stop brings it back", async () => {
      await page.click(".st-play");
      const head = () => page.evaluate(() => Number(document.querySelector<HTMLElement>(".st-window")!.style.getPropertyValue("--ph") || 0));
      await sleep(900);
      const first = await head();
      await sleep(600);
      const second = await head();
      assert.ok(second > first && first > 0, `the playhead moves (${first} -> ${second})`);
      const clock = await page.textContent(".st-clock");
      assert.notEqual(clock?.trim(), "1.1.1  ·  0:00.0");
      await shot("4-playing");
      await page.click(".st-play");
      await page.click('button[aria-label="Back to the start"]');
      await sleep(200);
      assert.equal(await head(), 0);
    });

    await test("export renders a real WAV with sound in it", async () => {
      const [download] = await Promise.all([page.waitForEvent("download", { timeout: 60_000 }), page.click(".st-export")]);
      const file = await download.path();
      const bytes = fs.readFileSync(file!);
      assert.equal(bytes.subarray(0, 4).toString(), "RIFF");
      assert.equal(bytes.subarray(8, 12).toString(), "WAVE");
      assert.ok(bytes.length > 400_000, `${bytes.length} bytes`);
      let peak = 0;
      for (let i = 44; i < bytes.length - 1; i += 2) peak = Math.max(peak, Math.abs(bytes.readInt16LE(i)));
      assert.ok(peak > 2000, `there is sound in it (peak ${peak})`);
      assert.ok(peak < 32767, "and it does not clip");
    });

    await test("the agent can ask the window to bounce the song, and it lands in the thread", async () => {
      app.script.push({ tools: [{ name: "studio_export", args: { name: "demo" } }] });
      app.script.push({ text: "Exported." });
      await app.turn(s, "export the song as a wav", 90_000);
      const arts = JSON.stringify((await app.api("GET", "/api/artifacts")).body);
      assert.ok(arts.includes("demo.wav"));
    });

    await test("the mixer sets levels the agent sees", async () => {
      await page.click('.rail-bar button[aria-label="Mixer"]');
      await page.waitForSelector(".st-strip");
      const fader = page.locator(".st-strip:not(.st-master) .st-fader").first();
      await fader.focus();
      for (let i = 0; i < 25; i++) await page.keyboard.press("ArrowDown");
      await until("volume saved", async () => (await doc()).tracks[0].volume < 0.7);
      await shot("5-mixer");
    });

    await test("on a phone it sits in the pinned view without spilling sideways", async () => {
      const phone = await browser.newContext({ viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      const p2 = await phone.newPage();
      p2.on("pageerror", (e) => errors.push(e.message));
      await p2.goto(`${app.base}/?session=${s}`);
      await p2.waitForSelector(".st-window", { timeout: 15_000 });
      const wide = await p2.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      assert.equal(wide, false, "no sideways page scroll");
      if (shots) await p2.screenshot({ path: `${shots}/6-phone.png` });
      await p2.click(".pdf-full-btn");
      await p2.waitForSelector(".st-window.is-full");
      assert.equal(await p2.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false);
      await sleep(500);
      if (shots) await p2.screenshot({ path: `${shots}/7-phone-full.png` });
      await phone.close();
    });

    assert.deepEqual(errors.filter((e) => !/favicon|manifest|Failed to load resource/.test(e)), [], "no errors in the page");
  } finally {
    await browser.close();
    await app.stop();
  }
  console.log(`\n${passed} passed`);
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
