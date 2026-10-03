/**
 * Moving a cursor and typing the way a person does, for the windows that show
 * the agent working (the PDF editor's cues, the Office windows' cursor).
 *
 * It is the same motion the browser window's pointer has (server/human.ts):
 * an arc rather than a straight line, accelerating then slowing as it arrives,
 * a tremor that fades, now and then an overshoot that is corrected, a rest
 * before the click; and typing with uneven gaps, longer after a space or a
 * full stop, an occasional hesitation. Pure, so it is shared as it is by the
 * page and by the PDF editor (which imports this file) and can be tested.
 */

export type Point = { x: number; y: number };

const rand = (min: number, max: number) => min + Math.random() * (max - min);
/** Roughly normal, bounded. */
const gauss = (spread: number) => ((Math.random() + Math.random() + Math.random()) / 1.5 - 1) * spread;

/** Minimum-jerk easing: the velocity profile of a reaching arm. */
export const ease = (t: number) => t * t * t * (10 + t * (-15 + 6 * t));

function bezier(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}

function stroke(from: Point, to: Point, wobble = 1): Point[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return [to];
  const nx = -dy / dist;
  const ny = dx / dist;
  const bend = Math.min(dist * 0.35, 180) * (Math.random() < 0.5 ? -1 : 1);
  const c1 = { x: from.x + dx * rand(0.15, 0.4) + nx * bend * rand(0.3, 1), y: from.y + dy * rand(0.15, 0.4) + ny * bend * rand(0.3, 1) };
  const c2 = { x: from.x + dx * rand(0.6, 0.85) + nx * bend * rand(0, 0.6), y: from.y + dy * rand(0.6, 0.85) + ny * bend * rand(0, 0.6) };
  const steps = Math.round(Math.min(90, Math.max(12, 8 + Math.sqrt(dist) * rand(1.6, 2.6))));
  const points: Point[] = [];
  for (let i = 1; i <= steps; i++) {
    const p = bezier(from, c1, c2, to, ease(i / steps));
    const shake = wobble * (1 - i / steps) * 1.4;
    points.push({ x: p.x + gauss(shake), y: p.y + gauss(shake) });
  }
  points[points.length - 1] = to;
  return points;
}

/**
 * The points a hand takes from `from` to `to`, evenly spaced in time (the
 * easing is in where they fall), so playing them at a steady rate looks like
 * one reach. A long move sometimes overshoots and comes back.
 */
export function humanRoute(from: Point, to: Point): Point[] {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  if (dist > 220 && Math.random() < 0.35) {
    const over = rand(4, Math.min(22, dist * 0.06));
    const angle = Math.atan2(to.y - from.y, to.x - from.x) + gauss(0.35);
    const past = { x: to.x + Math.cos(angle) * over, y: to.y + Math.sin(angle) * over };
    return [...stroke(from, past), ...stroke(past, to, 0.3)];
  }
  return stroke(from, to);
}

/** How long a reach of this many pixels takes: longer moves take longer, but not in proportion. */
export const routeMs = (dist: number) => Math.round(Math.min(1100, Math.max(420, 330 + Math.sqrt(dist) * 32)) * rand(0.9, 1.15));

/** Where along a route it is, `t` from 0 to 1. */
export function along(route: readonly Point[], t: number): Point {
  if (route.length === 0) return { x: 0, y: 0 };
  const i = Math.min(route.length - 1, Math.max(0, Math.round(t * (route.length - 1))));
  return route[i];
}

/** A pause before pressing, the way a person rests on the target. */
export const restMs = () => Math.round(rand(80, 230));

/**
 * The wait before each character of `text`: uneven, longer after a space or
 * punctuation, now and then a hesitation. Scaled down so all of it fits in
 * `budgetMs` -- nobody wants to watch a paragraph typed at forty words a minute.
 */
export function typingDelays(text: string, budgetMs = 2600): number[] {
  const chars = Array.from(text);
  const raw = chars.map((ch) => {
    const base = /[\s.,;:!?@]/.test(ch) ? rand(70, 190) : rand(40, 125);
    return Math.random() < 0.05 ? base + rand(150, 380) : base;
  });
  const total = raw.reduce((a, b) => a + b, 0);
  const k = total > budgetMs ? budgetMs / total : 1;
  return raw.map((d) => Math.max(8, Math.round(d * k)));
}
