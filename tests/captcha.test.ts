import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
import { webglArgs } from "../server/browser";
import {
  colourShare,
  decodePng,
  detailShare,
  encodePng,
  findGap,
  HUES,
  inkColour,
  legible,
  type Bitmap,
} from "../server/captcha-images";
import { DEFAULT_CAPTCHA, mergeCaptcha, parseAnswer, probeBitmap, wantedColour, wordPictures } from "../server/captcha";
import { identifyTiles, pictureNames } from "../server/captcha-labels";

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

await test("a lone number is a square, however the model wraps it", () => {
  // The sight test asks for {"tile":N}, and a model that does exactly that was
  // being judged blind: only lists were read, so vision stayed off for it.
  assert.deepEqual(parseAnswer('{"tile":4}').tiles, [4]);
  assert.deepEqual(parseAnswer('{"tile": 9}').tiles, [9]);
  assert.deepEqual(parseAnswer('{"tile":"4"}').tiles, [4]);
  assert.deepEqual(parseAnswer('Answer: {"tile":[4]}').tiles, [4]);
  assert.deepEqual(parseAnswer('{"tiles":"3, 7 and 9"}').tiles, [3, 7, 9]);
  assert.deepEqual(parseAnswer('{"tiles":[[1,2],3]}').tiles, [1, 2, 3]);
});

await test("nothing matching is an answer, and is not the same as no answer", () => {
  for (const said of ['{"tiles":[]}', '{"tile":[]}', 'None match: {"tiles": []}']) {
    const a = parseAnswer(said);
    assert.equal(a.none, true, said);
    assert.equal(a.why, undefined, said);
  }
  assert.equal(parseAnswer('{"tiles":[3]}').none, undefined);
  assert.equal(parseAnswer('{"tiles":[99]}').none, undefined, "a square that does not exist is not 'none'");
  assert.equal(parseAnswer('{"slide":null}').none, undefined);
  assert.ok(parseAnswer("{}").why, "saying nothing at all is still no answer");
});

await test("an unreadable answer is no answer, and says why", () => {
  assert.ok(parseAnswer("I would click the second square").why);
  assert.ok(parseAnswer("{not json at all}").why);
  assert.equal(parseAnswer('{"tiles":[99]}').tiles.length, 0, "a square that does not exist was taken");
});

await test("a square is scored by how much of the asked-for colour is in it", async () => {
  // Left half red, right half green, 64x32: a stop sign in one square and a
  // tree in the next, which is the whole of what the local backend reads.
  const shot = decodePng(png(64, 32, (x) => (x < 32 ? [200, 20, 20] : [20, 160, 40])));
  const left = { x: 0, y: 0, w: 32, h: 32 };
  const right = { x: 32, y: 0, w: 32, h: 32 };
  assert.equal(colourShare(shot, left, HUES.red), 1);
  assert.equal(colourShare(shot, left, HUES.green), 0);
  assert.equal(colourShare(shot, right, HUES.green), 1);
  assert.equal(colourShare(shot, right, HUES.red), 0);
  // Grey and pale pixels are paper, not a colour, however they are spelled.
  const grey = decodePng(png(16, 16, () => [200, 200, 200]));
  assert.equal(colourShare(grey, { x: 0, y: 0, w: 16, h: 16 }, HUES.red), 0);
});

await test("the colour a prompt asks for is read out of it, or not at all", () => {
  assert.equal(wantedColour("Select all squares with a red traffic light"), "red");
  assert.equal(wantedColour("Select all squares with a Stop Sign"), "red");
  assert.equal(wantedColour("Pick every picture with a green tree"), "green");
  assert.equal(wantedColour("Select all squares with a bus"), null, "a bus is not a colour");
  assert.equal(wantedColour("Select all with red or yellow cars"), null, "two colours decide nothing");
});

await test("the characters of a text CAPTCHA are read out of a reply", () => {
  assert.equal(parseAnswer('{"text":"7fq3"}').text, "7fq3");
  assert.equal(parseAnswer('{"letters":"a b c 9"}').text, "abc9");
  // A model asked for the letters often sends nothing else at all.
  assert.equal(parseAnswer("7fq3").text, "7fq3");
  assert.equal(parseAnswer('{"text":""}').text, undefined);
  assert.equal(parseAnswer('{"text":"ab"}').text, undefined, "two characters is not a CAPTCHA answer");
  assert.ok(parseAnswer("I would type the letters").why, "prose was taken as the characters");
});

await test("a picture of nothing is told apart from a picture of letters", () => {
  const blank = decodePng(png(64, 32, () => [255, 255, 255]));
  assert.ok(detailShare(blank) < 0.02, "a white rectangle was taken for a drawn CAPTCHA");
  const drawn = decodePng(png(64, 32, (x, y) => (y % 8 === 0 || x % 11 === 0 ? [0, 0, 0] : [255, 255, 255])));
  assert.ok(detailShare(drawn) > 0.02, "letters on white were taken for a blank picture");
});

await test("a browser is only told to use software WebGL when a driver is there", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vulkan-"));
  assert.deepEqual(webglArgs([dir]), [], "flags for a driver that is not installed");
  fs.writeFileSync(path.join(dir, "lvp_icd.x86_64.json"), "{}");
  assert.deepEqual(
    webglArgs([dir]),
    ["--use-angle=vulkan", "--ignore-gpu-blocklist"],
    "a machine with a Vulkan driver is left with a WebGL context",
  );
});

/** A CAPTCHA as the page draws it: one ink, and noise of every other hue. */
function noisyWords(w = 120, h = 40): Bitmap {
  const bm: Bitmap = { w, h, rgba: Buffer.alloc(w * h * 4) };
  const put = (x: number, y: number, r: number, g: number, b: number) => {
    const i = (y * w + x) * 4;
    bm.rgba[i] = r;
    bm.rgba[i + 1] = g;
    bm.rgba[i + 2] = b;
    bm.rgba[i + 3] = 255;
  };
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) put(x, y, 250, 250, 250);
  // A stroke of dark green letters, and a scatter of magenta noise over them.
  for (let x = 10; x < 40; x += 1) for (let y = 8; y < 30; y += 1) if ((x + y) % 7 < 4) put(x, y, 20, 90, 40);
  let seed = 7;
  for (let n = 0; n < 400; n += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    put(seed % w, (seed >> 8) % h, 230, 20, 200);
  }
  return bm;
}

await test("a PNG written from pixels is read back the same", () => {
  const bm = noisyWords(37, 19);
  const back = decodePng(encodePng(bm));
  assert.equal(back.w, 37);
  assert.equal(back.h, 19);
  assert.ok(back.rgba.equals(bm.rgba), "every pixel survives the round trip");
});

await test("the ink is the one colour the letters are drawn in", () => {
  const ink = inkColour(noisyWords());
  assert.ok(ink, "a picture with letters in one colour has an ink");
  assert.ok(ink!.g > ink!.r && ink!.g > ink!.b, "green letters read as green");
});

await test("cleaning a CAPTCHA leaves the letters and drops the noise", () => {
  const bm = noisyWords();
  const clean = legible(bm, 3);
  assert.equal(clean.w, 360, "enlarged three times over");
  assert.equal(clean.h, 120);
  const at = (x: number, y: number) => {
    const i = (y * clean.w + x) * 4;
    return [clean.rgba[i], clean.rgba[i + 1], clean.rgba[i + 2]];
  };
  assert.deepEqual(at(13 * 3, 8 * 3), [0, 0, 0], "a letter pixel is black");
  // Where the noise landed is not: it is neither the ink's hue nor darker paper.
  let noiseLeft = 0;
  for (let y = 0; y < clean.h; y += 3) for (let x = 0; x < clean.w; x += 3) {
    const i = (y * clean.w + x) * 4;
    if (clean.rgba[i] === 230 && clean.rgba[i + 1] === 20) noiseLeft += 1;
  }
  assert.equal(noiseLeft, 0, "no magenta noise survives");
});

await test("a words challenge is sent cleaned and enlarged", () => {
  const pictures = wordPictures(noisyWords(), 4);
  assert.equal(pictures.length, 2, "two readings of the same letters");
  const first = decodePng(pictures[0]);
  const second = decodePng(pictures[1]);
  assert.equal(first.w, 480);
  assert.equal(second.w, 480);
  // The page's own crop, enlarged: the noise is still there, untouched.
  let magenta = 0;
  for (let i = 0; i < second.rgba.length; i += 4) if (second.rgba[i] === 230 && second.rgba[i + 1] === 20) magenta += 1;
  assert.ok(magenta > 200, "the untouched reading keeps the page as it is");
});

await test("a page that names its squares is answered by reading the names", () => {
  // The squares carry their picture in the URL: what a person calls a carrot,
  // the page calls carrot.webp, and that is a reading rather than a guess.
  const vegetables = ["tomato", "carrot", "onion", "banana", "grape", "corn", "avocado", "potato", "eggplant"];
  const squares = vegetables.map((v, i) => ({ index: i + 1, label: `https://neal.fun/not-a-robot/vegetables/${v}.webp` }));
  assert.deepEqual(pictureNames(squares[1].label), ["carrot"]);
  assert.deepEqual(pictureNames(`url("tiles/traffic-light-3.webp") center/cover`), ["traffic", "light"]);
  assert.deepEqual(pictureNames("1x-tile-4.png?cache=9"), ["tile"], "digits and 1x are not a name");
  const veg = identifyTiles("Select all the squares with a Vegetable", squares);
  assert.deepEqual(veg?.indexes, [2, 3, 6, 8, 9], "carrot, onion, corn, potato and the eggplant that is allowed beside them");
  assert.deepEqual(veg?.names, ["carrot", "onion", "corn", "potato", "eggplant"]);
  // Tomato, banana, grape and avocado are the fruit of that grid, which is
  // exactly the mistake the colour scorer used to make for it.
  assert.deepEqual(identifyTiles("Select all the squares with a Fruit", squares)?.indexes, [1, 4, 5, 7]);
  // One picture cropped into cells names nothing: the model has to look.
  const sprite = vegetables.map((_, i) => ({ index: i + 1, label: "https://x/stop-signs/1.webp" }));
  assert.equal(identifyTiles("Select all the squares with a Stop Sign", sprite), null);
  // Everything or nothing is not an answer either.
  assert.equal(identifyTiles("Select all the squares with a Vegetable", squares.map((s) => ({ ...s, label: "carrot.webp" }))), null);
});

await test("a model is tested for eyes before it is asked to read a grid", () => {
  const png = encodePng(probeBitmap(4));
  const drawn = decodePng(png);
  assert.equal(drawn.w, 300);
  const ink = (x: number, y: number) => drawn.rgba[(y * drawn.w + x) * 4];
  assert.ok(ink(50, 150) < 80, "square 4 -- the middle of the left column -- is the inked one");
  assert.ok(ink(250, 250) > 240, "the other eight are left as paper");
  assert.notDeepEqual(probeBitmap(4).rgba, probeBitmap(9).rgba, "the question is different every time");
});

console.log(`\n${passed} passed.`);
