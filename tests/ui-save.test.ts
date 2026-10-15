/**
 * Save, and the folders on the Artifacts page, as a person uses them.
 *
 * Every tool window's bar has Save: pressed, what is in the window is written now and kept in Artifacts, and the agent
 * is neither asked nor woken. On the Artifacts page a chat's files are in a folder of their own, and a person can move
 * files into a new folder and rename it.
 *
 * Needs the app and the Office editors built (npm run build, then node scripts/build-office.mjs).
 *
 *   npx tsx tests/ui-save.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium, type Frame, type Page } from "playwright-core";
import { docxParagraphs } from "../server/officedesk";
import { sleep, startApp, type App } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}
const guardOk = (req: { system: string; tools: string[] }) =>
  /You check one action/.test(req.system) ? { text: '{"destructive": false, "requested": true}' }
    : req.tools.length === 0 ? { text: "SKIP" }
      : null;

async function editorIn(page: Page, app: string): Promise<Frame> {
  for (let i = 0; i < 300; i++) {
    const frame = page.frames().find((f) => f.url().includes(`/office-app/${app}/`));
    if (frame) return frame;
    await sleep(100);
  }
  throw new Error("the editor's frame never appeared");
}
async function until(what: string, ok: () => Promise<boolean>, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await ok().catch(() => false)) return; await sleep(300); }
  throw new Error(`timed out waiting for ${what}`);
}

async function agentDoes(app: App, s: string, said: string, call: { name: string; args: Record<string, unknown> }) {
  let n = 0;
  app.decide = (req) => guardOk(req) ?? (++n === 1 ? { tools: [call] } : { text: "Done." });
  await app.turn(s, said, 180_000);
}

async function main() {
  const exe = process.env.AUTORA_BROWSER_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  if (!fs.existsSync(exe)) { console.log("  skip  no browser here"); return; }
  if (!fs.existsSync("dist/index.html")) { console.log("  skip  the app is not built (npm run build)"); return; }
  const app: App = await startApp();
  const browser = await chromium.launch({ executablePath: exe });
  try {
    if (fs.existsSync("dist/office/web/docs/index.html")) {
      const s = await app.newSession("Launch plan", "build");
      await agentDoes(app, s, "write a memo", { name: "office_create", args: { type: "docx", name: "memo", markdown: "# Launch memo\n\nThe launch is on Friday.\n" } });
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.goto(`${app.base}/?session=${s}`);
      const frame = await editorIn(page, "docs");
      await until("the memo in the editor", async () => /The launch is on Friday/.test(await frame.evaluate(() => document.body.innerText)));
      await sleep(1500);

      await test("Pages: Save writes what the person typed into Artifacts now, keeps a version, and wakes no agent", async () => {
        const para = frame.locator(".ProseMirror p", { hasText: "The launch is on Friday" });
        await para.click();
        await frame.evaluate(() => {
          const sel = window.getSelection();
          const p = [...document.querySelectorAll(".ProseMirror p")].find((x) => /on Friday/.test(x.textContent ?? ""));
          if (sel && p) { sel.selectAllChildren(p); sel.collapseToEnd(); }
        });
        await page.keyboard.type(" Bring snacks.", { delay: 20 });
        const asked = app.seen.length;
        const save = page.locator(".office-window .win-save");
        await save.click();
        await until("Saved", async () => /Saved/.test((await save.textContent()) ?? ""), 20_000);
        assert.match((await save.getAttribute("aria-label")) ?? "", /Kept in Artifacts as memo\.docx/);
        const st = (await app.api("GET", `/api/officedesk/${s}`)).body;
        const win = (st.windows as Array<{ kind: string; working?: string; versions?: Array<{ label: string }> }>).find((w) => w.kind === "docx")!;
        const bytes = Buffer.from(await (await fetch(`${app.base}/api/artifacts/${win.working}`)).arrayBuffer());
        assert.match((docxParagraphs(bytes) ?? []).join("\n"), /Bring snacks\./);
        assert.ok((win.versions ?? []).some((v) => v.label === "Saved by you"), JSON.stringify(win.versions));
        await sleep(1500);
        assert.equal(app.seen.length, asked, "saving asked the model nothing");
      });
      await page.close();
    } else {
      console.log("  skip  the Office editors are not built (node scripts/build-office.mjs)");
    }

    await test("Artifacts: a chat's files are in its folder; moved into a new folder, renamed, then the folder removed", async () => {
      const up = await fetch(`${app.base}/api/artifacts`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", "X-File-Name": "packing-list.txt" },
        body: "socks\n",
      }).then((r) => r.json()) as { artifact: { id: string } };
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.goto(`${app.base}/?page=artifacts`);
      const card = page.locator(".art-card", { hasText: "packing-list.txt" });
      await card.waitFor({ timeout: 20_000 });
      // Press and hold to select, then Move to folder.
      const box = (await card.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + 30);
      await page.mouse.down();
      await sleep(700);
      await page.mouse.up();
      await page.getByRole("button", { name: "Move to folder" }).click();
      await page.getByLabel("New folder name").fill("Trip");
      await page.getByRole("button", { name: "Make and move" }).click();
      const head = page.locator(".art-section", { has: page.locator("h3", { hasText: /^Trip$/ }) });
      await head.waitFor({ timeout: 10_000 });
      assert.equal(await head.locator(".art-card", { hasText: "packing-list.txt" }).count(), 1);

      await head.getByRole("button", { name: "Rename the folder Trip" }).click();
      const name = page.getByLabel("Folder name");
      await name.fill("Summer trip");
      await name.press("Enter");
      await page.locator("h3", { hasText: /^Summer trip$/ }).waitFor({ timeout: 10_000 });
      const listed = (await app.api("GET", "/api/artifacts")).body as { artifacts: Array<{ id: string; folder?: string }>; folders: Array<{ id: string; name: string }> };
      const folder = listed.folders.find((f) => f.name === "Summer trip")!;
      assert.equal(listed.artifacts.find((a) => a.id === up.artifact.id)?.folder, folder.id);

      await page.getByRole("button", { name: "Remove the folder Summer trip" }).click();
      await page.getByRole("button", { name: "Remove", exact: true }).click();
      await until("the folder gone", async () => (await page.locator("h3", { hasText: /^Summer trip$/ }).count()) === 0, 10_000);
      assert.equal(await page.locator(".art-card", { hasText: "packing-list.txt" }).count(), 1, "the file stays");
      await page.close();
    });
  } finally {
    await browser.close();
    await app.stop();
  }
  console.log(`ui-save: ${passed} passed`);
}

main().catch((err) => { console.error(err); process.exit(1); });
