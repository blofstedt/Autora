/**
 * Moving the mouse the way a hand does.
 *
 * Bot checks -- reCAPTCHA's checkbox, hCaptcha, Cloudflare Turnstile -- score
 * the pointer long before they score the click. A cursor that teleports to the
 * exact centre of a box and clicks in the same millisecond is the easiest tell
 * there is. A person's pointer curves, accelerates then slows as it arrives,
 * wobbles a little, sometimes overshoots and corrects, lands a few pixels off
 * centre, rests before pressing and holds the button for a human length of
 * time. This file produces that, with fresh randomness every time, so no two
 * paths are alike.
 *
 * It is also simply easier to watch: a pointer that travels is a pointer you
 * can follow on the live feed.
 */

type Page = any;
export type Point = { x: number; y: number };

const rand = (min: number, max: number) => min + Math.random() * (max - min);

/** Roughly normal, from three uniforms: cheap and bounded, which a true
    Gaussian is not. */
const gauss = (spread: number) =>
  ((Math.random() + Math.random() + Math.random()) / 1.5 - 1) * spread;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/** Minimum-jerk easing: the velocity profile of a reaching arm. */
const ease = (t: number) => t * t * t * (10 + t * (-15 + 6 * t));

function bezier(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}

/** One curved stroke from `from` to `to`, as a list of points. */
function stroke(from: Point, to: Point, wobble = 1): Point[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return [to];

  // Control points pushed off the straight line, to the same side more often
  // than not, so the path is an arc rather than a zigzag.
  const nx = -dy / dist;
  const ny = dx / dist;
  const bend = Math.min(dist * 0.35, 180) * (Math.random() < 0.5 ? -1 : 1);
  const c1 = {
    x: from.x + dx * rand(0.15, 0.4) + nx * bend * rand(0.3, 1),
    y: from.y + dy * rand(0.15, 0.4) + ny * bend * rand(0.3, 1),
  };
  const c2 = {
    x: from.x + dx * rand(0.6, 0.85) + nx * bend * rand(0, 0.6),
    y: from.y + dy * rand(0.6, 0.85) + ny * bend * rand(0, 0.6),
  };

  // Fitts: longer moves take more samples, but not linearly more.
  const steps = Math.round(Math.min(90, Math.max(12, 8 + Math.sqrt(dist) * rand(1.6, 2.6))));
  const points: Point[] = [];
  for (let i = 1; i <= steps; i++) {
    const p = bezier(from, c1, c2, to, ease(i / steps));
    // Tremor, fading out as the hand arrives.
    const shake = wobble * (1 - i / steps) * 1.4;
    points.push({ x: p.x + gauss(shake), y: p.y + gauss(shake) });
  }
  points[points.length - 1] = to;
  return points;
}

/** A path that sometimes overshoots and comes back, as fast moves do. */
export function humanPath(from: Point, to: Point): Point[] {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  if (dist > 220 && Math.random() < 0.35) {
    const over = rand(4, Math.min(22, dist * 0.06));
    const angle = Math.atan2(to.y - from.y, to.x - from.x) + gauss(0.35);
    const past = { x: to.x + Math.cos(angle) * over, y: to.y + Math.sin(angle) * over };
    return [...stroke(from, past), ...stroke(past, to, 0.3)];
  }
  return stroke(from, to);
}

/** Somewhere inside a box, biased toward the middle, never on the edge. */
export function pointIn(box: { x: number; y: number; w: number; h: number }): Point {
  const spreadX = Math.max(1, box.w * 0.18);
  const spreadY = Math.max(1, box.h * 0.18);
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  return {
    x: Math.round(clamp(cx + gauss(spreadX), box.x + box.w * 0.2, box.x + box.w * 0.8)),
    y: Math.round(clamp(cy + gauss(spreadY), box.y + box.h * 0.2, box.y + box.h * 0.8)),
  };
}

/** Travel the pointer along a humanlike path, at a varying pace. */
export async function humanMove(page: Page, from: Point, to: Point): Promise<Point> {
  const path = humanPath(from, to);
  // Overall speed varies per move: some people are brisk, some are not.
  const pace = rand(0.7, 1.4);
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    await page.mouse.move(p.x, p.y);
    // Slower at the start and the end of a stroke, faster through the middle.
    const t = i / path.length;
    const edge = 1 + 1.6 * Math.abs(t - 0.5);
    await sleep(rand(5, 11) * pace * edge);
  }
  return to;
}

/** Move there, rest, press, hold, release. */
export async function humanClick(
  page: Page,
  from: Point,
  to: Point,
  opts: { button?: "left" | "right" | "middle"; before?: () => Promise<void> } = {},
): Promise<Point> {
  await humanMove(page, from, to);
  await sleep(rand(70, 240));
  await opts.before?.();
  await page.mouse.down({ button: opts.button ?? "left" });
  await sleep(rand(55, 150));
  await page.mouse.up({ button: opts.button ?? "left" });
  return to;
}

/** A few idle movements, the way a pointer drifts while someone reads. */
export async function wander(page: Page, from: Point, bounds: { width: number; height: number }) {
  let at = from;
  const moves = 1 + Math.floor(Math.random() * 3);
  for (let i = 0; i < moves; i++) {
    const next = {
      x: Math.round(Math.min(bounds.width - 10, Math.max(10, at.x + gauss(bounds.width * 0.25)))),
      y: Math.round(Math.min(bounds.height - 10, Math.max(10, at.y + gauss(bounds.height * 0.25)))),
    };
    at = await humanMove(page, at, next);
    await sleep(rand(120, 450));
  }
  return at;
}

/** Type with uneven gaps between keys. Long text goes faster, because nobody
    wants to watch a paragraph typed at forty words a minute. */
export async function humanType(page: Page, text: string) {
  if (text.length > 120) {
    await page.keyboard.type(text, { delay: 8 });
    return;
  }
  for (const ch of text) {
    await page.keyboard.type(ch);
    const pause = /[\s.,@]/.test(ch) ? rand(60, 180) : rand(35, 120);
    await sleep(Math.random() < 0.05 ? pause + rand(150, 400) : pause);
  }
}
