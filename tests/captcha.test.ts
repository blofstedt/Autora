/**
 * The CAPTCHA solver's arithmetic, and the reading of a model's answer.
 *
 * Everything here is the part that can be wrong without a browser: the two
 * pictures compared to find where a slider's piece belongs, the PNG decoder
 * under it, the settings folded out of arbitrary JSON, and a model's reply
 * turned into clicks. The clicking itself is only ever exercised on a real
 * page, which is where it belongs.
 *
 *   npx tsx tests/captcha.test.ts
 */
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { decodePng, findGap, type Bitmap } from "../server/captcha-images";
import { DEFAULT_CAPTCHA, mergeCaptcha, parseAnswer } from "../server/captcha";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    throw err;
  }
}

/** A PNG of `w` by `h` RGB, one row per entry of `rows` (rgb triples). */
function png(w: number, h: number, pixel: (x: number, y: number) => [number, number, number]): Buffer {
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y += 1) {
    const at = y * (1 + w * 3);
    raw[at] = 0;
    for (let x = 0; x < w; x += 1) {
      const [r, g, b] = pixel(x, y);
      raw[at + 1 + x * 3] = r;
      raw[at + 2 + x * 3] = g;
      raw[at + 3 + x * 3] = b;
    }
  }
  const chunk = (type: string, body: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type, "latin1"), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(typed) : crc32(typed));
    return Buffer.concat([length, typed, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Only needed where node's own crc32 is absent. */
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A bitmap of noise, from a seed, so the test is the same every run. */
function noise(w: number, h: number, seed = 7): Bitmap {
  const rgba = Buffer.alloc(w * h * 4, 255);
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state % 256;
  };
  for (let i = 0; i < w * h; i += 1) {
    const v = next();
    rgba[i * 4] = v;
    rgba[i * 4 + 1] = v;
    rgba[i * 4 + 2] = v;
  }
  return { w, h, rgba };
}

/** `piece` cut out of `background` at `at`. */
function cut(background: Bitmap, at: number, w: number, h: number): Bitmap {
  const rgba = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const from = (y * background.w + at + x) * 4;
      const to = (y * w + x) * 4;
      background.rgba.copy(rgba, to, from, from + 4);
    }
  }
  return { w, h, rgba };
}

await test("a PNG decodes to the pixels that went into it", () => {
  const bytes = png(6, 4, (x, y) => [x * 20, y * 40, 128]);
  const decoded = decodePng(bytes);
  assert.equal(decoded.w, 6);
  assert.equal(decoded.h, 4);
  const at = (x: number, y: number) => [...decoded.rgba.subarray((y * 6 + x) * 4, (y * 6 + x) * 4 + 4)];
  assert.deepEqual(at(0, 0), [0, 0, 128, 255]);
  assert.deepEqual(at(5, 3), [100, 120, 128, 255]);
});

await test("something that is not a PNG is refused rather than misread", () => {
  assert.throws(() => decodePng(Buffer.from("definitely not a picture")));
});

await test("the piece is found where it was cut from", () => {
  const background = noise(240, 80);
  const piece = cut(background, 137, 40, 80);
  // A strip with the piece drawn over it at the left, which is what a page
  // shows: the search has to skip that stretch, so it is told to start after.
  const strip = Buffer.from(background.rgba);
  for (let y = 0; y < 80; y += 1) {
    for (let x = 0; x < 40; x += 1) {
      piece.rgba.copy(strip, (y * 240 + x) * 4, (y * 40 + x) * 4, (y * 40 + x) * 4 + 4);
    }
  }
  const found = findGap({ w: 240, h: 80, rgba: strip }, piece, { from: 60 });
  assert.ok(found, "no gap found");
  assert.ok(Math.abs(found.x - 137) <= 2, `expected about 137, got ${found.x}`);
  assert.ok(found.confidence > 0.5, `confidence ${found.confidence}`);
});

await test("a piece that matches nowhere says so rather than pointing somewhere", () => {
  const background = noise(200, 60, 11);
  const piece = noise(30, 60, 99);
  const found = findGap(background, piece, { from: 40 });
  // There is always a best place; what must not happen is a confident one.
  assert.ok(!found || found.confidence < 0.5, `claimed confidence ${found?.confidence}`);
});

await test("the settings survive nonsense, and keep at least one backend", () => {
  const into = { ...DEFAULT_CAPTCHA, backends: [...DEFAULT_CAPTCHA.backends] };
  const merged = mergeCaptcha(into, { attempts: 900, backends: ["nonsense"], remoteUrl: "http://x/", enabled: false });
  assert.equal(merged.attempts, into.attempts, "an absurd attempt count was taken");
  assert.deepEqual(merged.backends, DEFAULT_CAPTCHA.backends, "an empty order was taken");
  assert.equal(merged.enabled, false);
  assert.equal(merged.remoteUrl, "http://x");
});

await test("a model's answer is read out of whatever prose it arrives in", () => {
  assert.deepEqual(parseAnswer('{"tiles":[1,5,9]}').tiles, [1, 5, 9]);
  assert.deepEqual(parseAnswer('```json\n{"tiles": [3]}\n```').tiles, [3]);
  assert.equal(parseAnswer('{"slide": 0.42}').slide, 0.42);
  assert.equal(parseAnswer('{"offset": 42}').slide, 0.42);
  assert.deepEqual(parseAnswer('{"points":[{"x":0.2,"y":0.3}]}').points, [{ x: 0.2, y: 0.3 }]);
  assert.equal(parseAnswer('{"tiles":[]}').tiles.length, 0);
});

await test("an unreadable answer is no answer, and says why", () => {
  assert.ok(parseAnswer("I would click the second square").why);
  assert.ok(parseAnswer("{not json at all}").why);
  assert.equal(parseAnswer('{"tiles":[99]}').tiles.length, 0, "a square that does not exist was taken");
});

console.log(`\n${passed} passed.`);
