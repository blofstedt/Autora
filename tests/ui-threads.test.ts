/**
 * Threads, as the person uses it: every post and comment has an up and a down vote, the
 * time of the last reply is on the post (and in the list), and a reply is written under the
 * comment it answers -- not in a box at the top of the page.
 *
 *   npx tsx tests/ui-threads.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium } from "playwright-core";
import { startApp } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

async function main() {
  const exe = process.env.AUTORA_BROWSER_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  if (!fs.existsSync(exe)) { console.log("  skip  no browser here"); return; }
  if (!fs.existsSync("dist/index.html")) { console.log("  skip  the app is not built"); return; }
  const app = await startApp();
  const browser = await chromium.launch({ executablePath: exe });
  try {
    const made = (await app.api("POST", "/api/threads", { title: "Retry logic", body: "There is a gap in the retry path." })).body;
    const pid: string = made.post?.id ?? made.id;
    const texts = ["First thought.", "Second thought.", "Third thought.", "Fourth thought."];
    for (const text of texts) await app.api("POST", `/api/threads/${pid}/comments`, { text });
    const empty = (await app.api("POST", "/api/threads", { title: "Nobody has answered", body: "Hello?" })).body;

    for (const [name, width] of [["desktop", 1200], ["phone", 390]] as const) {
      const page = await browser.newPage({ viewport: { width, height: 700 } });
      await page.goto(`${app.base}/?page=threads`);
      await page.waitForSelector("text=Retry logic");

      await test(`${name}: the list shows each post's vote and when the last reply was`, async () => {
        const row = page.locator(".th-row", { hasText: "Retry logic" });
        assert.equal(await row.getByRole("button", { name: /upvote/i }).count(), 1);
        assert.equal(await row.getByRole("button", { name: /downvote/i }).count(), 1);
        assert.match(await row.locator(".th-lastreply").innerText(), /^last reply /);
        assert.equal(await page.locator(".th-row", { hasText: "Nobody has answered" }).locator(".th-lastreply").count(), 0, "no reply, nothing to say");
      });

      await page.locator(".th-main", { hasText: "Retry logic" }).click();
      await page.waitForSelector(".th-post");

      await test(`${name}: the open post says when it was last replied to, and so does the comments header`, async () => {
        assert.match(await page.locator(".th-post .th-lastreply").innerText(), /^last reply /);
        assert.match(await page.locator(".th-comments-head").innerText(), /\d+ comments · last reply /);
        assert.ok((await page.locator(".th-lastreply").first().getAttribute("title"))?.startsWith("Last reply "), "the exact time is on hover");
      });

      await test(`${name}: the post and every comment have an up and a down vote that work`, async () => {
        // The phone pass starts from what the desktop pass voted: a vote taken back is "Upvote" again.
        for (const taken of await page.getByRole("button", { name: /Remove (up|down)vote/ }).all()) await taken.click();
        await page.waitForFunction(() => document.querySelectorAll('[aria-label^="Remove "]').length === 0);
        assert.equal(await page.locator(".th-post").getByRole("button", { name: /Upvote this post/ }).count(), 1);
        assert.equal(await page.locator(".th-post").getByRole("button", { name: /Downvote this post/ }).count(), 1);
        const comments = await page.locator(".th-comment").count();
        assert.ok(comments >= 4, "the comments are there");
        assert.equal(await page.getByRole("button", { name: /vote this comment/i }).count(), comments * 2, "an up and a down on every one");
        const box = (await page.getByRole("button", { name: /Upvote this comment/ }).first().boundingBox())!;
        assert.ok(box.width >= 28 && box.height >= 26, `a target worth hitting, got ${box.width}x${box.height}`);
        await page.getByRole("button", { name: /Upvote this post/ }).click();
        await page.waitForFunction(() => document.querySelector(".th-post .th-score")?.textContent === "1");
        await page.getByRole("button", { name: /Downvote this comment/ }).nth(1).click();
        // Comments are in score order, so the one voted down moves: look for the score, not the place.
        await page.waitForFunction(() => [...document.querySelectorAll(".th-comment .th-score")].some((e) => e.textContent === "-1"));
      });

      await test(`${name}: Reply opens the box under that comment, focused and in view, and the reply lands under it`, async () => {
        assert.equal(await page.locator(".th-replybox").count(), 0, "no reply box until one is asked for");
        const button = page.locator(".th-comment", { hasText: "Third thought." }).first().getByRole("button", { name: "Reply", exact: true }).first();
        await button.scrollIntoViewIfNeeded();
        await button.click();
        const box = page.locator(".th-replybox");
        await box.waitFor();
        assert.equal(await box.count(), 1);
        // It is inside the comment that was answered, after its buttons, not in the top form.
        const insideThird = await box.evaluate((el) => el.closest(".th-comment")?.querySelector(".th-body")?.textContent ?? "");
        assert.equal(insideThird.trim(), "Third thought.");
        // It scrolls into view smoothly: give it a moment to arrive, and fail if it never does.
        await page.waitForFunction(() => {
          const t = document.querySelector(".th-replybox textarea");
          const r = t?.getBoundingClientRect();
          return !!r && r.top >= 0 && r.bottom <= innerHeight;
        }, undefined, { timeout: 3000 }).catch(() => undefined);
        const geometry = await box.locator("textarea").evaluate((el) => {
          const r = el.getBoundingClientRect();
          return { focused: document.activeElement === el, inView: r.top >= 0 && r.bottom <= innerHeight };
        });
        assert.equal(geometry.focused, true, "the cursor is in it");
        assert.equal(geometry.inView, true, "and it is on screen");
        // The page still has the one box for a comment on the post itself, at the top.
        assert.equal(await page.locator("form.nb-new:not(.th-replybox) textarea").count(), 1);
        await page.keyboard.type("A reply right where I clicked");
        await box.getByRole("button", { name: "Reply", exact: true }).click();
        await page.waitForFunction(() => document.querySelectorAll(".th-replybox").length === 0);
        const saved = (await app.api("GET", `/api/threads/${pid}`)).body;
        const post = saved.post ?? saved;
        const mine = post.comments.find((c: { text: string }) => c.text === "A reply right where I clicked");
        assert.ok(mine, "saved");
        assert.equal(post.comments.find((c: { id: string }) => c.id === mine.parent)?.text, "Third thought.");
      });

      await test(`${name}: Reply again, or Cancel, closes it; only one is open at a time`, async () => {
        // The Reply buttons in the comments' own rows: the open form has a "Reply" submit button of its own.
        const replies = page.locator(".th-comment > .th-acts").getByRole("button", { name: "Reply", exact: true });
        await replies.nth(0).click();
        await page.locator(".th-replybox").waitFor();
        await replies.nth(1).click();
        await page.waitForFunction(() => document.querySelectorAll(".th-replybox").length === 1);
        await replies.nth(1).click();
        await page.waitForFunction(() => document.querySelectorAll(".th-replybox").length === 0);
        await replies.nth(0).click();
        await page.locator(".th-replybox").getByRole("button", { name: "Cancel" }).click();
        assert.equal(await page.locator(".th-replybox").count(), 0);
      });

      await page.locator(".nb-top .btn", { hasText: "All threads" }).click();
      await page.waitForSelector(".th-list");
      await page.close();
    }
    void empty;
  } finally {
    await browser.close();
    await app.stop();
  }
  console.log(`\n${passed} passed`);
  process.exit(0);
}
main().catch((err) => { console.error(err); process.exit(1); });
