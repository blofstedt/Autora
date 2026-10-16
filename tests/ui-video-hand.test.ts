/**
 * The video window with Visible work on: the agent's edits are made with the editor's own controls, live -- a clip
 * picked, the playhead put by a click on the ruler, Split and Delete on the tool bar, a clip dragged into place, a
 * media tile's "+" -- and the agent is told it was done by hand.
 *
 * Needs the app and the video editor built (npm run build).
 *
 *   npx tsx tests/ui-video-hand.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import zlib from "node:zlib";
import { chromium } from "playwright-core";
import { sleep, startApp } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

/** A 64x36 PNG, solid violet, made here so there is no file to carry. */
function png(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([head, body, crc]);
  };
  const w = 64;
  const h = 36;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.concat(Array.from({ length: w }, () => Buffer.from([110, 91, 255])))]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}


async function main() {
  const exe = process.env.AUTORA_BROWSER_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  if (!fs.existsSync(exe)) { console.log("  skip  no browser here"); return; }
  if (!fs.existsSync("dist/opencut-editor/index.html")) { console.log("  skip  the editor is not built (npm run build)"); return; }
  const shots = process.env.VIDEO_SHOTS || "";
  const app = await startApp();
  const browser = await chromium.launch({ executablePath: exe });
  try {
    const up = await fetch(`${app.base}/api/artifacts`, {
      method: "POST", headers: { "Content-Type": "application/octet-stream", "X-File-Name": "violet.png" }, body: new Uint8Array(png()),
    });
    const picture = (await up.json()).artifact.id as string;
    const s = await app.newSession("Cut");
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on("console", (m) => { if (m.text().startsWith("[video hand]")) console.log(`    ${m.text()}`); });
    await page.goto(`${app.base}/?session=${s}`);
    await page.waitForSelector(".composer", { timeout: 20_000 });

    const guard = (req: { system: string }) => /You check one action/.test(req.system) ? { text: '{"destructive": false, "requested": true}' } : null;
    /** One turn of these calls; what the tools answered, as text. */
    const run = async (said: string, calls: Array<{ name: string; args: Record<string, unknown> }>, made?: (last: string) => Record<string, unknown> | null) => {
      let n = 0;
      app.seen.length = 0;
      app.decide = (req) => {
        const g = guard(req);
        if (g) return g;
        if (n >= calls.length) return { text: "Done." };
        const call = calls[n++];
        return { tools: [{ name: call.name, args: { ...call.args, ...(made?.(req.last) ?? {}) } }] };
      };
      await app.turn(s, said, 240_000);
      return app.seen.map((r) => JSON.stringify(r.messages.filter((m) => m.role === "tool"))).join("\n").replace(/\\+"/g, '"');
    };
    let pointer = 0;
    const watch = setInterval(() => {
      void page.locator(".app-pane[data-pane=video] .office-cursor-name").count().then((c) => { if (c) pointer++; }).catch(() => undefined);
    }, 120);
    const film = (tag: string) => {
      if (!shots) return { stop: async () => undefined };
      let on = true;
      const done = (async () => { for (let i = 0; on && i < 30; i++) { await sleep(900); await page.screenshot({ path: `${shots}/${tag}-${i}.png` }).catch(() => undefined); } })();
      return { stop: async () => { on = false; await done; } };
    };

    /** The picture's clips on the timeline now, read with video_look. */
    let lastLook = "";
    const clipsNow = async () => {
      const out = await run("look", [{ name: "video_look", args: {} }]);
      lastLook = out;
      return [...out.matchAll(/([0-9a-f-]{36}) {2}image "violet.png[^"]*" of [0-9a-f-]+ {2}([\d.]+)s to ([\d.]+)s/g)].map((m) => ({ id: m[1], start: Number(m[2]), end: Number(m[3]) }));
    };

    let clipId = "";
    await test("a picture is added from the Media panel's \"+\", by hand", async () => {
      const mediaOf = (text: string) => /([0-9a-f-]{36})\s+image "violet/.exec(text)?.[1] ?? /imported image "violet.png" as ([0-9a-f-]+)/i.exec(text)?.[1];
      let media = "";
      const out = await run("put the picture in a new cut", [
        { name: "video_open", args: { new: "Hand cut" } },
        { name: "video_import", args: { file: picture } },
        { name: "video_edit", args: { action: "add_clip", duration: 4 } },
      ], (last) => { media = media || mediaOf(last) || ""; return media ? { mediaId: media } : null; });
      assert.match(out, /pressed "\+" on "violet.png", by hand in the Video window/, out.slice(-1500));
      assert.ok(pointer > 0, "the agent's pointer was there");
      const clips = await clipsNow();
      assert.equal(clips.length, 1);
      assert.equal(clips[0].end - clips[0].start, 4, "as long as asked");
      clipId = clips[0].id;
    });

    await test("a split: the clip picked, the ruler clicked at the cut, Split pressed", async () => {
      const f = film("split");
      const out = await run("cut it at 2 seconds", [{ name: "video_edit", args: { action: "split", elementId: clipId, time: 2 } }]);
      await f.stop();
      assert.match(out, /picked the clip, clicked the ruler at the cut and pressed Split, by hand/, out.slice(-1500));
      const clips = await clipsNow();
      assert.deepEqual(clips.map((c) => [c.start, c.end]), [[0, 2], [2, 4]], lastLook.slice(-900));
      clipId = clips[0].id;
    });

    await test("a move: the clip dragged along the timeline", async () => {
      const second = (await clipsNow()).find((c) => c.start === 2)!;
      const f = film("move");
      const out = await run("move the second half later", [{ name: "video_edit", args: { action: "move", elementId: second.id, start: 3 } }]);
      await f.stop();
      assert.match(out, /dragged the clip to its place, by hand/, out.slice(-1500));
      assert.match(out, /by hand in the Video window/);
      assert.equal((await clipsNow()).find((c) => c.id === second.id)?.start, 3);
    });

    await test("a delete: the clip picked and Delete pressed on the tool bar", async () => {
      const out = await run("drop the first half", [{ name: "video_edit", args: { action: "delete", elementId: clipId } }]);
      assert.match(out, /picked the clip and pressed Delete, by hand in the Video window/, out.slice(-1500));
      assert.ok(!(await clipsNow()).some((c) => c.id === clipId));
    });
    clearInterval(watch);
  } finally {
    await browser.close();
    await app.stop();
  }
  console.log(`\n${passed} passed`);
}

main().catch((err) => { console.error(err); process.exit(1); });
