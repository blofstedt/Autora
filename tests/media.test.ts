/**
 * The media tool: ffmpeg for the media work, a speech service for transcripts,
 * OCR that falls back to the model's own eyes.
 *
 *   npx tsx tests/media.test.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const state = fs.mkdtempSync(path.join(os.tmpdir(), "autora-media-state-"));
process.env.AUTORA_STATE_DIR = state;
const media = await import("../server/media");
const { getArtifact, readArtifact } = await import("../server/artifacts");

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

if (!media.mediaTools().ffmpeg) {
  console.log("  skip  no ffmpeg on this host");
  process.exit(0);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "autora-media-files-"));
const video = path.join(work, "clip.mp4");
execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=duration=4:size=320x240:rate=10", "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-shortest", "-pix_fmt", "yuv420p", "-y", video]);
const silent = path.join(work, "mute.mp4");
execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=duration=1:size=64x64:rate=5", "-pix_fmt", "yuv420p", "-y", silent]);
const keys = { deepgram: "", openai: "" };
const run = (args: Record<string, any>, extra: Partial<Parameters<typeof media.runMedia>[0]> = {}) =>
  media.runMedia({ cwd: work, session: "s", args, keys, ...extra });

await test("info says what is in a file, and a text file is not media", async () => {
  const r = await run({ action: "info", file: "clip.mp4" });
  assert.equal(r.ok, true, r.summary);
  assert.match(r.summary, /video: h264, 320x240, 10 fps/);
  assert.match(r.summary, /audio: aac/);
  assert.match(r.summary, /0:04 long/);
  fs.writeFileSync(path.join(work, "x.txt"), "hello");
  assert.equal((await run({ action: "info", file: "x.txt" })).ok, false);
  assert.match((await run({ action: "info", file: "nope.mp4" })).summary, /There is no file/);
});

await test("frames are spread across the video, or taken at the times asked", async () => {
  const r = await run({ action: "frames", file: "clip.mp4", count: 3 });
  assert.equal(r.images.length, 3);
  assert.equal(r.images[0].data[0], 0xff); // a JPEG
  const at = await run({ action: "frames", file: "clip.mp4", at: ["0:01", 2.5] });
  assert.equal(at.images.length, 2);
  assert.match(at.summary, /0:01, 0:03/);
  assert.match((await run({ action: "frames", file: "x.txt" })).summary, /not media|no picture/);
});

await test("audio comes out as a file, and a video with no sound says so", async () => {
  const r = await run({ action: "audio", file: "clip.mp4", format: "wav" });
  assert.equal(r.ok, true, r.summary);
  assert.equal(r.files.length, 1);
  assert.equal(readArtifact(r.files[0].id)!.subarray(0, 4).toString(), "RIFF");
  assert.equal((await run({ action: "audio", file: silent })).ok, false);
});

await test("trim and convert make new files and leave the original", async () => {
  const t = await run({ action: "trim", file: "clip.mp4", start: 1, end: "0:03" });
  assert.equal(t.ok, true, t.summary);
  const tp = path.join(state, "trimmed.mp4");
  fs.writeFileSync(tp, readArtifact(t.files[0].id)!);
  const pr = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", tp], { encoding: "utf8" }));
  assert.ok(Math.abs(Number(pr.format.duration) - 2) < 0.5, `duration ${pr.format.duration}`);
  const c = await run({ action: "convert", file: "clip.mp4", format: "png", width: 100 });
  assert.equal(c.ok, true, c.summary);
  const png = readArtifact(c.files[0].id)!;
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  assert.equal(png.readUInt32BE(16), 100);
  assert.ok(fs.existsSync(path.join(work, "clip.mp4")));
  assert.match((await run({ action: "trim", file: "clip.mp4" })).summary, /needs a start/);
  assert.match((await run({ action: "trim", file: "clip.mp4", start: 3, end: 1 })).summary, /after start/);
  assert.match((await run({ action: "convert", file: "clip.mp4", format: "exe" })).summary, /format is one of/);
});

await test("transcription needs a key, and uses the speech service it has", async () => {
  assert.match((await run({ action: "transcribe", file: "clip.mp4" })).summary, /no speech service/);
  let url = "", auth = "", size = 0;
  const fakeFetch = (async (u: any, init: any) => {
    url = String(u); auth = init.headers.Authorization; size = init.body.byteLength ?? 0;
    return new Response(JSON.stringify({ results: { utterances: [{ start: 0.2, end: 1.5, transcript: "Hello there." }, { start: 62, end: 64, transcript: "Second thought." }] } }), { status: 200 });
  }) as unknown as typeof fetch;
  const r = await run({ action: "transcribe", file: "clip.mp4" }, { keys: { deepgram: "dg-key", openai: "" }, fetchImpl: fakeFetch });
  assert.equal(r.ok, true, r.summary);
  assert.match(url, /api\.deepgram\.com\/v1\/listen/);
  assert.equal(auth, "Token dg-key");
  assert.ok(size > 1000, "audio was sent");
  assert.match(r.summary, /\[0:00\] Hello there\./);
  assert.match(r.summary, /\[1:02\] Second thought\./);
  assert.match(String(readArtifact(r.files[0].id)), /Second thought/);
  const w = await run({ action: "transcribe", file: "clip.mp4", start: 10 }, { keys: { deepgram: "", openai: "sk-x" }, fetchImpl: (async (u: any) => {
    assert.match(String(u), /openai\.com/);
    return new Response(JSON.stringify({ segments: [{ start: 1, end: 2, text: " Offset words" }] }), { status: 200 });
  }) as unknown as typeof fetch });
  assert.match(w.summary, /\[0:11\] Offset words/);
  const fail = await run({ action: "transcribe", file: "clip.mp4" }, { keys: { deepgram: "k", openai: "" }, fetchImpl: (async () => new Response("no", { status: 401 })) as unknown as typeof fetch });
  assert.equal(fail.ok, false);
  assert.match(fail.summary, /401/);
});

await test("OCR reads with tesseract when there is one, and otherwise hands the picture to the model", async () => {
  const pic = path.join(work, "page.png");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=white:size=200x80", "-frames:v", "1", "-y", pic]);
  const r = await run({ action: "ocr", file: "page.png" });
  assert.equal(r.ok, true, r.summary);
  if (media.mediaTools().tesseract) assert.ok(typeof r.summary === "string");
  else {
    assert.equal(r.images.length, 1);
    assert.match(r.summary, /not installed/);
    assert.match(r.summary, /by eye/);
  }
});

await test("only the actions that make nothing but text or pictures count as looking", () => {
  for (const action of ["info", "frames", "ocr", "transcribe"]) assert.equal(media.mediaReadOnly({ action }), true, action);
  for (const action of ["audio", "trim", "convert", ""]) assert.equal(media.mediaReadOnly({ action }), false, action);
});

assert.ok(getArtifact);
console.log(`\n${passed} media cases passed.`);
process.exit(0);
