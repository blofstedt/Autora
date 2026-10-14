/**
 * The geometry of an agent's personality shape: five points round a centre, the
 * first at the top, each pulled out toward its corner by how much of that trait
 * the agent has grown. Pure, so the page and its test read the same numbers.
 */

import type { TraitName } from "./organization";

interface Point { x: number; y: number }

/** Where corner `i` of `n` lies at `radius` from the centre, the first straight up and the rest clockwise. */
export function corner(i: number, n: number, radius: number, cx: number, cy: number): Point {
  const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n;
  return { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
}

/** A value on the 0..100 scale as a share of the way to the corner. Never quite the centre: a shape of nothing would
    be a dot, and a trait is never none. */
const reach = (value: number) => 0.1 + 0.9 * Math.max(0, Math.min(100, value)) / 100;

/** The shape's own corners, in the order of `keys`. A trait that is missing sits at the middle of the scale. */
export function shapeCorners(
  traits: Partial<Record<TraitName, number>> | undefined, keys: readonly TraitName[], radius: number, cx: number, cy: number,
): Point[] {
  return keys.map((key, i) => corner(i, keys.length, radius * reach(traits?.[key] ?? 50), cx, cy));
}

/** Corners as an SVG `points` value. */
export const asPoints = (points: readonly Point[]) => points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
