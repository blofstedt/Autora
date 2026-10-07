/**
 * Reading a CAPTCHA's picture without a vision model.
 *
 * Slider CAPTCHAs -- GeeTest's, Aliyun's, the generic "drag the piece into the
 * hole" widgets -- are not a question about meaning, they are a question about
 * pixels: the puzzle piece was cut out of the background a little way along it,
 * and where it was cut from is where it goes. That is arithmetic, not
 * inference, and it is worth doing here rather than paying a model to guess:
 * it is instant, it works with no network, no key and no model download, and
 * it is the same every time.
 *
 * Nothing is imported to do it. A Playwright screenshot is a PNG, and PNG is
 * inflate plus a per-row filter, both of which node already has; a dependency
 * for that would be a dependency for the sake of a dependency. What is left,
 * the matching itself, is a few lines of arithmetic over the two pictures.
 *
 * The pieces are in `Bitmap` form throughout: straight RGBA, row by row,
 * top to bottom, so every coordinate is an index and nothing is hidden behind
 * an abstraction that has to be right before the arithmetic can be checked.
 */
import zlib from "node:zlib";

export interface Bitmap {
  w: number;
  h: number;
  /** RGBA, four bytes per pixel, row-major. */
  rgba: Buffer;
}

/** One row of a PNG, back to unfiltered bytes. */
function unfilter(
  raw: Buffer,
  offset: number,
  width: number,
  stride: number,
  filter: number,
  prev: Buffer,
): { row: Buffer; next: number } {
  const row = Buffer.alloc(stride);
  for (let x = 0; x < stride; x += 1) {
    const value = raw[offset + x] ?? 0;
    const a = x >= width ? row[x - width] : 0;
    const b = prev[x] ?? 0;
    const c = x >= width ? (prev[x - width] ?? 0) : 0;
    let out: number;
    switch (filter) {
      case 0: out = value; break;
      case 1: out = value + a; break;
      case 2: out = value + b; break;
      case 3: out = value + ((a + b) >> 1); break;
      case 4: {
        // Paeth: whichever of left, up and up-left the gradient points at.
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        out = value + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
        break;
      }
      default: out = value;
    }
    row[x] = out & 0xff;
  }
  return { row, next: offset + stride };
}

/**
 * A PNG as RGBA pixels.
 *
 * Only what a screenshot actually is: 8 bits per channel, no interlacing, and
 * any of the four colour types. Anything else throws rather than being
 * silently misread -- a wrong answer here would be clicked on a real page.
 */
export function decodePng(png: Buffer): Bitmap {
  if (png.length < 8 || png.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let offset = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colour = 0;
  let interlace = 0;
  let palette: Buffer | null = null;
  const data: Buffer[] = [];

  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("latin1", offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8];
      colour = body[9];
      interlace = body[12];
    } else if (type === "PLTE") {
      palette = Buffer.from(body);
    } else if (type === "IDAT") {
      data.push(Buffer.from(body));
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }

  if (!width || !height) throw new Error("PNG has no size");
  if (depth !== 8) throw new Error(`PNG bit depth ${depth} is not supported`);
  if (interlace !== 0) throw new Error("interlaced PNG is not supported");
  // Channels in the file, and in the RGBA output.
  const channels = colour === 6 ? 4 : colour === 2 ? 3 : colour === 4 ? 2 : colour === 0 ? 1 : colour === 3 ? 1 : 0;
  if (!channels) throw new Error(`PNG colour type ${colour} is not supported`);

  const raw = zlib.inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4, 255);
  let prev: Buffer = Buffer.alloc(stride);
  let at = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = raw[at] ?? 0;
    const step = unfilter(raw, at + 1, channels, stride, filter, prev);
    const row = step.row;
    at = step.next;
    prev = row;
    for (let x = 0; x < width; x += 1) {
      const to = (y * width + x) * 4;
      const from = x * channels;
      if (colour === 6) {
        out[to] = row[from]; out[to + 1] = row[from + 1]; out[to + 2] = row[from + 2]; out[to + 3] = row[from + 3];
      } else if (colour === 2) {
        out[to] = row[from]; out[to + 1] = row[from + 1]; out[to + 2] = row[from + 2];
      } else if (colour === 4) {
        const g = row[from];
        out[to] = g; out[to + 1] = g; out[to + 2] = g; out[to + 3] = row[from + 1];
      } else if (colour === 0) {
        const g = row[from];
        out[to] = g; out[to + 1] = g; out[to + 2] = g;
      } else {
        const index = row[from] * 3;
        out[to] = palette?.[index] ?? 0;
        out[to + 1] = palette?.[index + 1] ?? 0;
        out[to + 2] = palette?.[index + 2] ?? 0;
      }
    }
  }
  return { w: width, h: height, rgba: out };
}

/** One pixel's luma, which is all the matching below needs. */
function luma(b: Bitmap, x: number, y: number): number {
  const i = (y * b.w + x) * 4;
  return 0.299 * b.rgba[i] + 0.587 * b.rgba[i + 1] + 0.114 * b.rgba[i + 2];
}

interface GapMatch {
  /** Where the piece belongs, in pixels along the background. */
  x: number;
  /** 0-1: how much better the winner is than the next plausible place. */
  confidence: number;
  /** Mean difference at the winner, on the same scale as pixel luma. */
  error: number;
}

/**
 * Where along the background the piece was cut from.
 *
 * The piece and the background are photographed separately -- the piece's own
 * element, and the strip behind it -- and the piece is then slid along the
 * background a pixel at a time, keeping the offset where the two agree best.
 * Where they agree, the piece is sitting over the hole it came from: the same
 * pixels, cut out and put back.
 *
 * Rows are sampled rather than every one, because a slider is a few hundred
 * pixels wide by a hundred tall and a fifth of the rows decides it just as
 * well, in a fifth of the time. Ties are broken by the offset's neighbours
 * being worse, which is what `confidence` reports.
 */
export function findGap(
  background: Bitmap,
  piece: Bitmap,
  /** `from`/`to` bound the search: the piece is drawn over the background at
      its own place, where it matches itself perfectly, so that stretch has to
      be left out or the answer is always "where it already is". */
  opts: { step?: number; from?: number; to?: number } = {},
): GapMatch | null {
  const pieceW = Math.max(4, Math.min(piece.w, Math.floor(background.w * 0.6)));
  const height = Math.min(background.h, piece.h);
  if (height < 4) return null;

  const rows: number[] = [];
  const step = Math.max(1, opts.step ?? 0);
  for (let y = step; y < height - step; y += Math.max(1, step || Math.max(1, Math.floor(height / 24)))) rows.push(y);

  const scores: number[] = [];
  const widest = Math.max(0, background.w - pieceW);
  const first = Math.max(0, Math.min(Math.round(opts.from ?? 0), widest));
  const last = Math.max(first, Math.min(Math.round(opts.to ?? widest), widest));
  for (let x = first; x <= last; x += 1) {
    let total = 0;
    for (const y of rows) {
      for (let i = 0; i < pieceW; i += 2) {
        total += Math.abs(luma(piece, i, y) - luma(background, x + i, y));
      }
    }
    scores.push(total / Math.max(1, rows.length * Math.ceil(pieceW / 2)));
  }
  if (!scores.length) return null;

  let best = 0;
  for (let i = 1; i < scores.length; i += 1) if (scores[i] < scores[best]) best = i;

  // The runner-up has to be a different place, not the neighbouring pixel of
  // the same place: a piece sits still at its answer, and only slopes off at
  // its edges.
  const margin = Math.max(3, Math.round(pieceW * 0.15));
  let runnerUp = Infinity;
  for (let i = 0; i < scores.length; i += 1) {
    if (Math.abs(i - best) <= margin) continue;
    if (scores[i] < runnerUp) runnerUp = scores[i];
  }
  const error = scores[best];
  const confidence =
    !Number.isFinite(runnerUp) || runnerUp <= 0 ? (error < 12 ? 0.8 : 0.2) : Math.max(0, Math.min(1, (runnerUp - error) / runnerUp));

  return { x: first + best, confidence, error };
}

/**
 * The same question, asked of one picture.
 *
 * Some sliders draw the piece's shadow on the background as well, and some
 * cover the background's own copy entirely, so the two-element version above
 * has nothing to compare. What is left in one picture is the hole: a rectangle
 * whose edges are darker than the scene around it, with the piece parked at
 * the left. Taking each column's darkness gives that rectangle's left edge as
 * the first strong vertical edge after the piece, which is where the piece
 * goes -- cruder than the match above, and reported as the weaker answer it
 * is, so the caller can prefer a vision model's judgement over it.
 */
export function findEdge(shot: Bitmap, pieceW: number): GapMatch | null {
  const from = Math.min(shot.w - 2, Math.max(2, Math.round(pieceW) + 2));
  if (from >= shot.w - 2 || shot.h < 8) return null;

  const columns: number[] = [];
  for (let x = 1; x < shot.w - 1; x += 1) {
    let total = 0;
    let counted = 0;
    for (let y = Math.floor(shot.h * 0.12); y < Math.floor(shot.h * 0.88); y += 3) {
      total += Math.abs(luma(shot, x + 1, y) - luma(shot, x - 1, y));
      counted += 1;
    }
    columns.push(total / Math.max(1, counted));
  }
  let best = from - 1;
  for (let i = from - 1; i < columns.length; i += 1) {
    // A hole's left edge is a step, not a texture: it has to beat the column
    // before it and after it, or it is the picture's own detail.
    if (columns[i] > columns[best]) best = i;
  }
  const strength = columns[best] ?? 0;
  if (strength < 6) return null;
  const mean = columns.reduce((a, b) => a + b, 0) / Math.max(1, columns.length);
  const confidence = Math.max(0, Math.min(0.6, (strength - mean) / Math.max(1, strength)));
  return { x: best + 1, confidence, error: strength };
}

/* ------------------------------------------------------------- colours -- */

/** A rectangle in the picture's own pixels. */
interface Patch {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The colours a "select all the pictures with..." prompt can name, as bands of
 * hue: red wraps the end of the wheel, so it is two bands and not one.
 */
export const HUES: Record<string, [number, number][]> = {
  red: [[345, 360], [0, 18]],
  orange: [[18, 42]],
  yellow: [[42, 68]],
  green: [[68, 165]],
  blue: [[165, 262]],
  purple: [[262, 300]],
  violet: [[262, 300]],
  pink: [[300, 345]],
  magenta: [[300, 345]],
};

/** Hue in degrees, and how colourful and how bright a pixel is, 0 to 1. */
function hsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  return { h, s: max === 0 ? 0 : d / max, v: max / 255 };
}

/**
 * How much of a rectangle is the given colour, 0 to 1.
 *
 * This is the cheap half of what a vision model does with "select all the
 * squares with a stop sign": a stop sign is red and almost nothing else in a
 * CAPTCHA's photograph is, so the squares holding one sort themselves out by
 * how much red is in them. It is arithmetic over a screenshot -- no key, no
 * network, no model -- and it either comes out clear or not at all: the caller
 * asks for a colour it can name, and anything muddy is left to the model.
 */
export function colourShare(shot: Bitmap, patch: Patch, bands: [number, number][], step = 2): number {
  const x0 = Math.max(0, Math.round(patch.x));
  const y0 = Math.max(0, Math.round(patch.y));
  const x1 = Math.min(shot.w, Math.round(patch.x + patch.w));
  const y1 = Math.min(shot.h, Math.round(patch.y + patch.h));
  let hit = 0;
  let seen = 0;
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const i = (y * shot.w + x) * 4;
      const { h, s, v } = hsv(shot.rgba[i], shot.rgba[i + 1], shot.rgba[i + 2]);
      seen += 1;
      // Pale and near-grey pixels are paper and shadow, not the object: a
      // colour has to be saturated and lit to count.
      if (s < 0.35 || v < 0.25) continue;
      if (bands.some(([lo, hi]) => h >= lo && h < hi)) hit += 1;
    }
  }
  return seen ? hit / seen : 0;
}

/**
 * How much of a rectangle is not one flat colour, 0 to 1.
 *
 * A picture that is about to be sent to a model is worth a look first: a
 * canvas a page has not drawn yet, a frame that came back white, a tab
 * Chromium has left unrendered -- all of them are a picture of nothing, and a
 * model asked to read one answers "nothing" at best and invents letters at
 * worst. Two per cent is well under what any drawn CAPTCHA has and well over
 * the stray pixel.
 */
export function detailShare(shot: Bitmap, patch?: Patch, step = 2): number {
  const x0 = Math.max(0, Math.round(patch?.x ?? 0));
  const y0 = Math.max(0, Math.round(patch?.y ?? 0));
  const x1 = Math.min(shot.w, Math.round(patch ? patch.x + patch.w : shot.w));
  const y1 = Math.min(shot.h, Math.round(patch ? patch.y + patch.h : shot.h));
  let sum = 0;
  let seen = 0;
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const i = (y * shot.w + x) * 4;
      sum += 0.299 * shot.rgba[i] + 0.587 * shot.rgba[i + 1] + 0.114 * shot.rgba[i + 2];
      seen += 1;
    }
  }
  if (!seen) return 0;
  const mean = sum / seen;
  let off = 0;
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const i = (y * shot.w + x) * 4;
      const luma = 0.299 * shot.rgba[i] + 0.587 * shot.rgba[i + 1] + 0.114 * shot.rgba[i + 2];
      if (Math.abs(luma - mean) > 25) off += 1;
    }
  }
  return off / seen;
}

/* ------------------------------------------------ a picture made legible -- */

/** A PNG again, from pixels: what the solver has enlarged and cleaned before
    a model is asked to read it has to be handed over as a file. */
export function encodePng(bm: Bitmap): Buffer {
  const stride = bm.w * 4;
  const raw = Buffer.alloc((stride + 1) * bm.h);
  for (let y = 0; y < bm.h; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none, so the decoder's own cost is nil
    bm.rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(bm.w, 0);
  ihdr.writeUInt32BE(bm.h, 4);
  ihdr[8] = 8; // bits per channel
  ihdr[9] = 6; // RGBA
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "latin1");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** The same picture, bigger, each pixel repeated.
 *
 * A CAPTCHA of distorted letters is barely twenty pixels tall on the page, and
 * a model asked to read glyphs that size answers "nothing" at best. Repeating
 * every pixel keeps the shapes exactly as drawn -- no smoothing, no invention
 * -- and a glyph four times the size is one a model reads. */
export function upscale(bm: Bitmap, factor: number): Bitmap {
  const f = Math.max(1, Math.round(factor));
  if (f === 1) return bm;
  const out: Bitmap = { w: bm.w * f, h: bm.h * f, rgba: Buffer.alloc(bm.w * f * bm.h * f * 4) };
  for (let y = 0; y < out.h; y += 1) {
    const sy = (y / f) | 0;
    for (let x = 0; x < out.w; x += 1) {
      const sx = (x / f) | 0;
      bm.rgba.copy(out.rgba, (y * out.w + x) * 4, (sy * bm.w + sx) * 4, (sy * bm.w + sx) * 4 + 4);
    }
  }
  return out;
}

/** Where a colour sits on the wheel, in degrees. */
function hueOf(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const span = max - min;
  if (!span) return -1;
  const raw = max === r ? (g - b) / span : max === g ? 2 + (b - r) / span : 4 + (r - g) / span;
  return ((raw * 60) % 360 + 360) % 360;
}

/**
 * The colour the letters are drawn in, when one colour owns the picture.
 *
 * A CAPTCHA of distorted letters is drawn in one ink, and the speckle thrown
 * over it is every colour at once: find the roundest thing in the picture and
 * the letters are it, whatever they happen to be drawn in. Returns null when
 * no single colour is enough of the picture to be the ink -- a photograph, a
 * grid of objects -- which is the honest answer, since isolating the wrong
 * colour would leave a blank where the question was.
 */
export function inkColour(bm: Bitmap): { r: number; g: number; b: number; share: number } | null {
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  let coloured = 0;
  for (let i = 0; i < bm.rgba.length; i += 4) {
    const r = bm.rgba[i];
    const g = bm.rgba[i + 1];
    const b = bm.rgba[i + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max - min < 45 || max < 60) continue; // grey, or too dark to have a hue
    coloured += 1;
    const key = Math.round(hueOf(r, g, b) / 15) % 24;
    const hit = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    hit.n += 1;
    hit.r += r;
    hit.g += g;
    hit.b += b;
    buckets.set(key, hit);
  }
  if (coloured < 40) return null;
  let best: { n: number; r: number; g: number; b: number } | null = null;
  for (const hit of buckets.values()) if (!best || hit.n > best.n) best = hit;
  if (!best) return null;
  const share = best.n / (bm.w * bm.h);
  // A sixth of the coloured pixels is a scattered speckle of one hue, not a
  // set of letters: insisting on more is what keeps this from painting a
  // rainbow photograph into two colours.
  if (best.n < 60 || best.n / coloured < 0.15) return null;
  return { r: best.r / best.n, g: best.g / best.n, b: best.b / best.n, share };
}

/**
 * The picture as a model can read it: enlarged, and with everything that is
 * not the ink taken out.
 *
 * What comes off the page is the letters and, over them, coloured noise the
 * whole point of which is to stop a model reading them. Every pixel is put
 * to the question -- is this the ink's colour, or is it nearer to paper -- and
 * answered as black or white, at the original resolution so the decision is
 * made on real pixels and then enlarged, where the edges stay where they were.
 */
export function legible(bm: Bitmap, factor = 4): Bitmap {
  const ink = inkColour(bm);
  const big = upscale(bm, factor);
  if (!ink) return big;
  // What the letters are drawn on: the brightest thing in the picture.
  let paper = 0;
  const step = Math.max(1, Math.round(Math.sqrt((bm.w * bm.h) / 4000)));
  let seen = 0;
  for (let i = 0; i < bm.rgba.length; i += 4 * step) {
    paper += 0.299 * bm.rgba[i] + 0.587 * bm.rgba[i + 1] + 0.114 * bm.rgba[i + 2];
    seen += 1;
  }
  paper = seen ? paper / seen : 255;
  const mono: Bitmap = { w: bm.w, h: bm.h, rgba: Buffer.alloc(bm.rgba.length) };
  for (let i = 0; i < bm.rgba.length; i += 4) {
    const r = bm.rgba[i];
    const g = bm.rgba[i + 1];
    const b = bm.rgba[i + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const chroma = max - min;
    let inkish = false;
    if (chroma >= 45 && max >= 60) {
      // Same hue as the ink, allowing for the shade the noise pushed it into.
      const near = Math.abs(hueOf(r, g, b) - hueOf(ink.r, ink.g, ink.b));
      inkish = Math.min(near, 360 - near) <= 40;
    } else if (max < paper * 0.75) {
      // No hue at all and darker than the paper: the ink's own edge.
      inkish = true;
    }
    const value = inkish ? 0 : 255;
    mono.rgba[i] = value;
    mono.rgba[i + 1] = value;
    mono.rgba[i + 2] = value;
    mono.rgba[i + 3] = 255;
  }
  return upscale(mono, factor);
}
