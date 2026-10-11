/**
 * Every part of the video editor, used by the agent, in a real browser with the
 * real editor: the typed tools (effects, masks, keyframes, shapes, stickers,
 * subtitles, tracks, scenes, bookmarks, settings, the editor's own actions and
 * panels, a picture of a frame) and the screen driver (read the screen, click a
 * control, type into a field), each checked against what the editor then says.
 *
 * Needs the editor built (npm run build); skips without a browser.
 *
 *   npx tsx tests/ui-video-all.test.ts
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
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.concat(Array.from({ length: w }, () => Buffer.from([110, 91, 255])))]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk("IEND", Buffer.alloc(0))]);
}

type Step = { tool: string; args: Record<string, unknown> | ((seen: string[]) => Record<string, unknown>); expect?: RegExp };

async function main() {
  const exe = process.env.AUTORA_BROWSER_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  if (!fs.existsSync(exe)) { console.log("  skip  no browser here"); return; }
  if (!fs.existsSync("dist/opencut-editor/index.html")) { console.log("  skip  the editor is not built (npm run build)"); return; }
  const app = await startApp();
  const browser = await chromium.launch({ executablePath: exe });
  try {
    const up = await fetch(`${app.base}/api/artifacts`, { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-File-Name": "violet.png" }, body: new Uint8Array(png()) });
    const picture = (await up.json()).artifact.id as string;
    const s = await app.newSession("Everything");
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${app.base}/?session=${s}`);
    await page.waitForSelector(".composer", { timeout: 20_000 });
    let cursors = 0;
    const watch = setInterval(() => {
      void page.locator(".app-pane[data-pane=video] .office-cursor-name").count().then((n) => { cursors += n; }).catch(() => undefined);
    }, 100);

    const results: string[] = [];
    /** Run steps as one turn of the agent; each step's result is what the next request carries. */
    const run = async (steps: Step[]): Promise<string[]> => {
      const out: string[] = [];
      let n = 0;
      app.decide = (req) => {
        if (/You check one action/.test(req.system)) return { text: '{"destructive": false, "requested": true}' };
        if (n > 0 && n <= steps.length) out[n - 1] = req.last;
        if (n >= steps.length) return { text: "Done." };
        const step = steps[n++];
        const args = typeof step.args === "function" ? step.args(results.concat(out)) : step.args;
        return { tools: [{ name: step.tool, args }] };
      };
      const events = await app.turn(s, "work on the video", 240_000);
      const failed = events.filter((e) => e.kind === "tool.error").map((e) => e.payload.error);
      steps.forEach((step, i) => {
        if (step.expect) assert.match(out[i] ?? failed[i] ?? "", step.expect, `${step.tool} ${JSON.stringify(typeof step.args === "function" ? "…" : step.args)}`);
      });
      results.push(...out);
      return out;
    };
    const idOf = (re: RegExp, seen: string[]) => {
      const all = seen.join("\n");
      const m = [...all.matchAll(re)].pop();
      assert.ok(m, `no ${re} in\n${all.slice(-600)}`);
      return m[1];
    };
    const clip = (seen: string[], kind = "image") => idOf(new RegExp(`\\b([0-9a-f-]{36})\\s+${kind} "violet`, "g"), seen);

    await test("the catalogs say what there is, and the clips go on the timeline", async () => {
      await run([
        { tool: "video_open", args: { new: "Everything" }, expect: /Project "Everything"/ },
        { tool: "video_import", args: { file: picture }, expect: /Imported image/ },
        { tool: "video_catalog", args: { topic: "effects" }, expect: /blur/i },
        { tool: "video_catalog", args: { topic: "masks" }, expect: /rectangle/ },
        { tool: "video_catalog", args: { topic: "graphics" }, expect: /rectangle/ },
        { tool: "video_catalog", args: { topic: "actions" }, expect: /toggle-snapping/ },
        { tool: "video_catalog", args: { topic: "settings" }, expect: /1920/ },
        { tool: "video_edit", args: (seen) => ({ action: "add_clip", mediaId: idOf(/as ([0-9a-f-]{36})/g, seen) }), expect: /image "violet/ },
        { tool: "video_edit", args: (seen) => ({ action: "add_clip", mediaId: idOf(/as ([0-9a-f-]{36})/g, seen), start: 5 }), expect: /image "violet/ },
      ]);
    });

    await test("effects, a mask and keyframes are the editor's own, and read back", async () => {
      const out = await run([
        { tool: "video_style", args: (seen) => ({ action: "effect_add", elementId: clip(seen), effectType: "blur" }), expect: /effectId/ },
        { tool: "video_style", args: (seen) => ({ action: "mask_add", elementId: clip(seen), maskType: "rectangle" }), expect: /Done \(mask_add\)/ },
        { tool: "video_style", args: (seen) => ({ action: "keyframe_set", elementId: clip(seen), property: "opacity", at: 0, value: 0 }), expect: /Done \(keyframe_set\)/ },
        { tool: "video_style", args: (seen) => ({ action: "keyframe_set", elementId: clip(seen), property: "opacity", at: 1, value: 1 }), expect: /Done/ },
        { tool: "video_style", args: (seen) => ({ action: "keyframes", elementId: clip(seen) }), expect: /opacity/ },
      ]);
      assert.match(out[4], /"time"/, "two keyframes on the clip");
    });

    await test("stickers, shapes, effect layers, subtitles, duplicates and visibility", async () => {
      await run([
        { tool: "video_edit", args: { action: "add_graphic", definitionId: "rectangle", start: 1, duration: 2 }, expect: /Done \(add_graphic\)/ },
        { tool: "video_edit", args: { action: "add_effect_layer", effectType: "blur", start: 2, duration: 2 }, expect: /Done \(add_effect_layer\)/ },
        { tool: "video_edit", args: { action: "add_subtitles", srt: "1\n00:00:00,500 --> 00:00:02,000\nHello there\n\n2\n00:00:02,500 --> 00:00:04,000\nSecond line\n" }, expect: /text "Hello there"/ },
        { tool: "video_edit", args: (seen) => ({ action: "duplicate", elementId: clip(seen) }), expect: /Done \(duplicate\)/ },
        { tool: "video_edit", args: (seen) => ({ action: "toggle_visibility", elementId: clip(seen) }), expect: /Done/ },
        { tool: "video_edit", args: { action: "add_sticker", stickerId: "shapes:circle", start: 0, duration: 1 }, expect: /Done|sticker/ },
      ]);
    });

    await test("tracks, bookmarks, scenes, settings, the editor's actions and panels", async () => {
      const out = await run([
        { tool: "video_project", args: { action: "track_add", type: "text" }, expect: /trackId/ },
        { tool: "video_project", args: { action: "bookmark_set", time: 1.5, note: "check this" }, expect: /check this/ },
        { tool: "video_project", args: { action: "scene_create", name: "Outro" }, expect: /sceneId/ },
        { tool: "video_project", args: { action: "scene_list" }, expect: /Outro/ },
        { tool: "video_project", args: { action: "settings", width: 1080, height: 1920, fps: 60 }, expect: /1080/ },
        { tool: "video_project", args: { action: "action", name: "toggle-snapping" }, expect: /Done/ },
        { tool: "video_project", args: { action: "panel", tab: "effects" }, expect: /effects/ },
      ]);
      assert.match(out[4], /"height": 1920/);
      const scene = (await run([{ tool: "video_project", args: { action: "scene_list" } }]))[0];
      const main = /"id": "([^"]+)",\s*"name": "Main scene"/.exec(scene)?.[1] ?? /"id": "([^"]+)"[^}]*"main": true/.exec(scene)?.[1];
      if (main) await run([{ tool: "video_project", args: { action: "scene_switch", sceneId: main }, expect: /Done/ }]);
    });

    await test("a moment of the video can be seen", async () => {
      const events = await (async () => {
        let n = 0;
        app.decide = (req) => /You check one action/.test(req.system) ? { text: '{"destructive": false, "requested": true}' } : n++ === 0 ? { tools: [{ name: "video_frame", args: { time: 1, width: 320 } }] } : { text: "Seen." };
        return app.turn(s, "show me a frame", 120_000);
      })();
      const call = events.find((e) => e.kind === "tool.result" || e.kind === "tool.error");
      assert.ok(call, "the tool answered");
      const sawPicture = app.seen.some((r) => JSON.stringify(r.messages).includes("data:image/png") || /"type":"image/.test(JSON.stringify(r.messages)));
      assert.ok(sawPicture || events.some((e) => e.kind === "media.image" || e.kind === "tool.image"), `a picture came back: ${JSON.stringify(events.filter((e) => e.kind.startsWith("tool")).map((e) => e.payload).slice(-2)).slice(0, 400)}`);
    });

    await test("the screen can be read, clicked and typed into like a person would", async () => {
      const out = await run([
        // Settings is not on the bar (a desktop's has room for thirteen): it is in All tools, one tap further, as the manual says.
        // (The click's answer lists the screen, so this is also the read.)
        { tool: "video_ui", args: { action: "click", label: "All tools" }, expect: /Export|controls/ },
        { tool: "video_ui", args: { action: "click", label: "Settings" }, expect: /controls/ },
        { tool: "video_ui", args: { action: "type", label: "Project name", text: "Typed by hand", enter: true }, expect: /Done \(type\)|Typed by hand/ },
        { tool: "video_look", args: {}, expect: /Typed by hand/ },
        { tool: "video_ui", args: { action: "press", key: "ArrowRight" }, expect: /Done/ },
      ]);
      assert.match(out[0], /\[\d+\]/, "controls come with numbers");
    });

    await test("every step was shown: the agent's cursor was on the screen", async () => {
      assert.ok(cursors > 5, `the cursor was seen ${cursors} times`);
    });

    clearInterval(watch);
    await sleep(200);
    const unexpected = errors.filter((e) => !/WebSocket|wasm|unreachable|GPU|WebGPU/i.test(e));
    assert.deepEqual(unexpected, [], "the page threw");
  } finally {
    await browser.close();
    await app.stop();
  }
  console.log(`\n${passed} passed`);
}

main().catch((err) => { console.error(err); process.exit(1); });
