/**
 * The Autora mark, as geometry.
 *
 * One equilateral triangle with rounded corners -- the shape the app signs its
 * name with -- plus the few things it turns into while the agent works: it
 * flips over while it is thinking, and stacks itself together out of smaller
 * copies of itself while it is building something.
 *
 * Pure numbers, no React and no DOM, for two reasons. The app draws it, the
 * favicon in index.html draws it, the Umbrel tile draws it and
 * ui/scripts/make_icons.py draws it -- and a brand mark that is written out
 * five times is four marks waiting to disagree. And it can be imported by a
 * script, so the shape can be checked by rendering it rather than by squinting
 * at it.
 *
 * Every shape here is a *sampled* outline: the corner fillets are walked as a
 * fixed number of points rather than written as SVG `A` commands. That is what
 * makes them morphable. SVG interpolates two `d` strings only when the
 * commands line up one for one with a number in each place, and an arc's
 * large-arc/sweep flags are not numbers -- an arc whose handedness flips
 * halfway through an animation snaps. With the corners sampled, every shape is
 * the same `M`/`L`/`Z` and every frame between two of them is a plain
 * interpolation.
 */

/** Radians, and a 3-decimal coordinate -- finer than any screen draws. */
const TAU = Math.PI * 2;
const P = (n: number) => +n.toFixed(3);

/**
 * The mark on the 32-unit grid the rest of the icon set uses.
 *
 * Designed at 512 and scaled down (see ART), so the proportions are the
 * designer's, not a grid's: the circumradius is 30% of the box width and the
 * corner fillet is 16% of the circumradius -- a triangle that is properly a
 * triangle, with corners taken off rather than a triangle rounded into a
 * lozenge.
 *
 * `cy` is the box centre less half a fillet, which is the offset that centres
 * the shape you can actually see. The corners are the part of a triangle that
 * a fillet takes away, so the drawn silhouette is half a fillet shorter at the
 * apex than the ideal one; centring the ideal one leaves the mark sitting low.
 */
export const MARK = { box: 32, cx: 16, cy: 16 - 0.75, R: 9.375, fillet: 1.5 };

/** The art the mark was drawn at: a 512px master, r=24 fillets. */
export const ART = { box: 512, R: 150, fillet: 24 };

/** Points sampled per corner. 8 is where the fillet stops looking faceted. */
const STEPS = 8;

export type ShapeOptions = {
  /** Where the shape's centre goes. */
  cx?: number;
  cy?: number;
  /** Circumradius: the distance from the centre to a corner. */
  R?: number;
  /** Corner radius. 24 on the 512 scale, 1.5 on the 32 scale. */
  fillet?: number;
  /** Apex direction, in radians. -90 degrees is apex up, +90 apex down. */
  turn?: number;
  /** Uniform scale about the centre. */
  scale?: number;
  /** Vertical scale about the centre: 1 as drawn, 0 edge-on, -1 upside down. */
  squash?: number;
  /** Points per corner. */
  steps?: number;
};

/**
 * One triangle: apex up, corners rounded, centred on (cx, cy).
 *
 * `squash` and `scale` are applied before the shape is placed, so a squashed
 * mark stays in the middle of its box instead of sliding onto its edge -- and
 * a squash through zero is the flip: at 0 the mark is a horizontal line, and
 * past it the same points read upside down.
 */
export function trianglePath({
  cx = MARK.cx,
  cy = MARK.cy,
  R = MARK.R,
  fillet = MARK.fillet,
  turn = -Math.PI / 2,
  scale = 1,
  squash = 1,
  steps = STEPS,
}: ShapeOptions = {}): string {
  const radius = R * scale;
  const r = fillet * scale;
  // The circumcentre of a triangle whose bounding box is centred on the
  // origin: apex at -0.75R, base at +0.75R, so the centre is 0.25R down.
  const centre = [0, radius / 4];
  const vertices = [0, 1, 2].map((i) => {
    const a = turn + (i * TAU) / 3;
    return [centre[0] + radius * Math.cos(a), centre[1] + radius * Math.sin(a)];
  });

  // Where the fillet of each corner meets its two edges (r*sqrt(3) along each
  // edge from the corner), and the centre of the fillet arc (2r along the
  // corner's bisector, which is where the two tangents are equal).
  const inset = r * Math.sqrt(3);
  const toward = (from: number[], to: number[]): number[] => {
    const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
    return [from[0] + ((to[0] - from[0]) / length) * inset, from[1] + ((to[1] - from[1]) / length) * inset];
  };
  const corners = vertices.map((v, i) => {
    const prev = vertices[(i + 2) % 3];
    const next = vertices[(i + 1) % 3];
    const start = toward(v, prev);
    const end = toward(v, next);
    const bisector = [prev[0] - v[0] + (next[0] - v[0]), prev[1] - v[1] + (next[1] - v[1])];
    const length = Math.hypot(bisector[0], bisector[1]);
    const arc = [v[0] + (bisector[0] / length) * 2 * r, v[1] + (bisector[1] / length) * 2 * r];
    const a0 = Math.atan2(start[1] - arc[1], start[0] - arc[0]);
    const a1 = Math.atan2(end[1] - arc[1], end[0] - arc[0]);
    // The short way round: a fillet spans 180 minus the 60 degree corner.
    const sweep = (((a1 - a0 + Math.PI) % TAU) + TAU) % TAU - Math.PI;
    return { arc, a0, sweep };
  });

  // Corner after corner, each arc sampled from its incoming to its outgoing
  // tangent point; the straight edges are the lines between them.
  const points: number[][] = [];
  for (const { arc, a0, sweep } of corners) {
    for (let k = 0; k < steps; k += 1) {
      const a = a0 + (sweep * k) / (steps - 1);
      points.push([cx + arc[0] + r * Math.cos(a), cy + squash * (arc[1] + r * Math.sin(a))]);
    }
  }

  return `M${points.map(([x, y]) => `${P(x)} ${P(y)}`).join("L")}Z`;
}

/** The mark as it sits: apex up, nothing moving. */
export const REST = trianglePath();

/**
 * The flip, as frames: the mark turning over about its own horizontal axis the
 * way a card does when you turn it -- squashed edge-on and back out the other
 * way, landing upside down, then home again.
 *
 * The frames are sampled from a cosine, which is exactly the profile of a
 * rotation seen from the side, so a handful of them read as one continuous
 * turn. Going straight from the upright mark to the inverted one would instead
 * collapse it through its own centroid, which looks like a mistake rather than
 * a movement.
 */
export function flipFrames(steps = 6): string[] {
  const half: string[] = [];
  for (let i = 0; i < steps; i += 1) {
    half.push(trianglePath({ squash: Math.cos((Math.PI * i) / (steps - 1)) }));
  }
  const frames = [...half];
  for (let i = half.length - 2; i >= 1; i -= 1) frames.push(half[i]);
  return frames;
}

/** The settle bloom: a breath out and back, drawn as a frame sequence. */
export const BLOOM = [
  REST,
  trianglePath({ scale: 1.05 }),
  trianglePath({ scale: 1.12, squash: 0.95 }),
  trianglePath({ scale: 1.03 }),
  REST,
];

/**
 * The small copies that stack up into the mark, for the building animation.
 *
 * `rows` rows of the triangle's lattice. The mark's side is cut into `rows`
 * segments, which makes rows^2 copies exactly its own size and shape: 2 rows is
 * 4 copies, 3 rows is 9 -- as fine as the pieces can get and still be read as
 * pieces at the sizes the app draws the mark (a 16px mark gets 2 rows, a 24px
 * one 3).
 *
 * Ordered the way they arrive: the base row first, left to right, then the row
 * above it, so the mark builds itself up from the ground rather than fading in.
 */
export function stackingUnits(rows: number): { d: string; x: number; y: number }[] {
  const unit = MARK.R / rows;                          // one copy's circumradius
  const side = unit * Math.sqrt(3);                    // its side, and the lattice pitch
  const height = unit * 1.5;                           // its height, and the row pitch
  const left = MARK.cx - (MARK.R * Math.sqrt(3)) / 2;  // the mark's bottom-left corner
  const base = MARK.cy + MARK.R * 0.75;                // the mark's base line
  const up = trianglePath({ cx: 0, cy: 0, R: unit, fillet: MARK.fillet / rows });
  const down = trianglePath({ cx: 0, cy: 0, R: unit, fillet: MARK.fillet / rows, turn: Math.PI / 2 });

  const pieces: { d: string; x: number; y: number; row: number; at: number }[] = [];
  for (let row = 0; row < rows; row += 1) {
    const line = base - row * height;                  // the bottom edge of this row
    const start = left + (row * side) / 2;             // the row narrows by half a side a row
    for (let j = 0; j < rows - row; j += 1) {
      // Both orientations have their bounding box on the same band -- the
      // upright one from its base up, the inverted one hanging from the top
      // edge of the row -- so both go at the middle of that band. (A unit's
      // centroid is not the middle of its box; a triangle's is a quarter of
      // its height below it.)
      pieces.push({ d: up, x: start + (j + 0.5) * side, y: line - 0.75 * unit, row, at: j * 2 });
      if (j < rows - row - 1) {
        pieces.push({ d: down, x: start + (j + 1) * side, y: line - 0.75 * unit, row, at: j * 2 + 1 });
      }
    }
  }
  return pieces
    .sort((a, b) => a.row - b.row || a.at - b.at)
    .map(({ d, x, y }) => ({ d, x, y }));
}
