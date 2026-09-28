/**
 * The Autora mark, as geometry.
 *
 * One equilateral triangle with rounded corners -- the shape the app signs its
 * name with -- plus the few things it turns into while the agent works: it
 * opens out into the circle drawn inside it, and turns, while it is thinking,
 * and stacks itself together out of smaller copies of itself while it is
 * building something.
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
 * `cy` is the centre of the box the mark is drawn in. The shape goes half a
 * fillet above it, and that is done in `trianglePath` rather than here, because
 * the offset has to follow the fillet: see the note there.
 */
export const MARK = { box: 32, cx: 16, cy: 16, R: 9.375, fillet: 1.5 };

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
  /** Vertical scale about the centre: 1 as drawn, below 1 a little flattened. */
  squash?: number;
  /** Points per corner. */
  steps?: number;
};

/**
 * One triangle as points: apex up, corners rounded, placed on (cx, cy).
 *
 * The points, not the path string, because two of the things built on it have
 * to measure where the shape ended up -- the morph, which recentres every frame
 * on the outline you can actually see, and `bbox` below -- and neither can
 * measure a string. `trianglePath` is the same points joined up.
 *
 * `squash` and `scale` are applied before the shape is placed, so a squashed or
 * scaled mark stays in the middle of its box instead of sliding onto its edge.
 * The settle bloom is the one thing that uses them.
 */
export function outlinePoints({
  cx = MARK.cx,
  cy,
  R = MARK.R,
  fillet = MARK.fillet,
  turn = -Math.PI / 2,
  scale = 1,
  squash = 1,
  steps = STEPS,
}: ShapeOptions = {}): number[][] {
  const radius = R * scale;
  const r = fillet * scale;

  // What you actually see is half a fillet lower than the ideal triangle's
  // box, and a fillet is not the same size in every shape the mark turns into:
  // a fillet takes a whole radius off the apex, where the corner's bisector is
  // vertical, and nothing off the base, where the arc is tangent to it. So the
  // drawn silhouette's centre is half a fillet below the centre of the shape's
  // own box, at *every* fillet -- including the one where the mark is a circle
  // -- and the mark is placed half a fillet up to put what you see in the
  // middle of its box. Centring the ideal triangle instead is what left the app
  // icons sitting 0.75 units low on the 32 grid.
  const originY = cy ?? MARK.cy - r / 2;
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
      points.push([cx + arc[0] + r * Math.cos(a), originY + squash * (arc[1] + r * Math.sin(a))]);
    }
  }

  return points;
}

/** Points as an SVG path: nothing but M, L and Z, so any two outlines with the
    same number of points interpolate -- which is the whole reason the corners
    are sampled rather than written as arc commands. */
export function pathOf(points: number[][]): string {
  return `M${points.map(([x, y]) => `${P(x)} ${P(y)}`).join("L")}Z`;
}

/** The outline of one triangle, as an SVG path. */
export function trianglePath(options: ShapeOptions = {}): string {
  return pathOf(outlinePoints(options));
}

/** The box the points occupy: what you see, not the ideal shape behind it. */
function bbox(points: number[][]): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of points) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

/** The mark as it sits: apex up, nothing moving. */
export const REST = trianglePath();

/**
 * The box the mark at rest occupies on its own grid -- measured from the
 * outline rather than from the ideal triangle behind it, which is a fillet
 * taller at the apex and half a fillet wider.
 *
 * The tab icon and the app's own gradient are painted across this box rather
 * than across the whole 32 units: a ramp spread over the plate spends its middle
 * on empty background and hands the mark a slice of one colour, so the mark
 * comes out flat. Measured here so there is one answer to where the mark is,
 * rather than a literal in each of the two places that draw it.
 */
export const DRAWN_BOX = (() => {
  const [x0, y0, x1, y1] = bbox(outlinePoints());
  return { x0, y0, x1, y1 };
})();

/**
 * The fillet at which the mark stops being a triangle and is a circle.
 *
 * A corner's arc sits `2 * fillet` along the corner's bisector, and the
 * incenter of an equilateral triangle is `2 * inradius` along the same line, so
 * at a fillet of half the circumradius -- the inradius -- all three arcs share
 * a centre and the outline is exactly the circle drawn inside the triangle.
 * Nothing else has to move for the mark to become a circle: the corner angle is
 * 60 degrees however large the fillet is, so every frame of the morph is the
 * same 24 points and the interpolator has no work to do but between them.
 */
export const CIRCLE_FILLET = MARK.R / 2;

/**
 * The morph, as frames: the mark opening out into a circle and closing again,
 * twice, while it turns a third of a turn.
 *
 * There is no flip any more. Turning a triangle over edge-on is a squash, and a
 * shape that flattens to a line and comes back inverted reads as the mark
 * falling over rather than as work being done -- and because the flattening
 * happens on the mark's own horizontal axis, most of what you watch is a bar
 * rather than the mark.
 *
 * What it does instead is change *shape*. The corners open out until the mark
 * is the circle drawn inside it and close again, and the fillet follows a
 * cosine rather than a ramp, so the mark arrives at the circle and at the
 * triangle with no speed at all: the two still moments are the two shapes, and
 * the movement is entirely in between.
 *
 * The turn is a third of a turn per cycle. A triangle has three-fold symmetry,
 * so the last frame here is the first frame with its corners renamed -- the
 * same outline -- and the loop restarts with nothing to see. The gradient is
 * fixed in the mark's own box, so turning the shape walks its corners through
 * the colours rather than dragging the colours round with them.
 */
export function morphFrames(
  steps = 30,
  /**
   * How much of the shrinking the mark does not do.
   *
   * The circle drawn inside the triangle is a good deal smaller than the
   * triangle: same height it is not, and going all the way in reads as the mark
   * deflating rather than as the mark turning. A little scale on the way out
   * takes most of that back, so the mark breathes instead of shrinking. 0 is
   * the pure incircle, 1 is a circle as tall as the triangle was.
   */
  {
    pulses = 2,
    breath = 0.3,
    /**
     * How many thirds of a turn the cycle covers.
     *
     * Two, not one: the mark has to be sharp at turn 0, turn 120 and turn 240
     * degrees and nowhere else, and those three are the same picture only for
     * whole thirds. At one third the half-way sharp moment is the mark upside
     * down, which is not the mark. Three-fold symmetry is what keeps the loop
     * seamless either way.
     */
    turns = 2,
  }: { pulses?: number; breath?: number; turns?: number } = {},
): string[] {
  const frames: string[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const p = i / steps;
    // 0 at the triangle, 1 at the circle, `pulses` times round the cycle.
    const open = Math.sin(Math.PI * pulses * p) ** 2;
    const fillet = MARK.fillet + (CIRCLE_FILLET - MARK.fillet) * open;
    // Drawn about the origin and moved afterwards, so the frame can be centred
    // on its own outline. A shape that is also turning has no fixed idea of
    // "half a fillet up": which corner is the apex changes, and with it the
    // drawn box, so a fixed offset would let the mark bob as it turned.
    const points = outlinePoints({
      cy: 0,
      fillet,
      scale: 1 + breath * open,
      turn: -Math.PI / 2 + (TAU / 3) * turns * p,
    });
    const [x0, y0, x1, y1] = bbox(points);
    const dx = MARK.cx - (x0 + x1) / 2;
    const dy = MARK.cy - (y0 + y1) / 2;
    frames.push(pathOf(points.map(([x, y]) => [x + dx, y + dy])));
  }
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
  const centreY = MARK.cy - MARK.fillet / 2;           // the drawn mark's own centre
  const base = centreY + MARK.R * 0.75;                // the mark's base line
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

/**
 * The three upright quarters the mark is stacked from, in the order they are
 * laid: bottom left, bottom right, then the one that caps them.
 *
 * The same lattice, fillet and placement as the coarse half of
 * `stackingUnits(2)`, with the inverted fourth left out. The gap they leave is
 * the point: three of the four quarters are a mark with a triangle missing, so
 * when they close the shape they make is the real one -- something the viewer
 * could see coming from the moment the first piece landed, rather than a
 * reveal. Three pieces also survive the small sizes the app draws the mark at,
 * where nine would be speckle.
 */
export function stackUnits(): { d: string; x: number; y: number }[] {
  const unit = MARK.R / 2;                             // one quarter's circumradius
  const side = unit * Math.sqrt(3);                    // its side, and the lattice pitch
  const height = unit * 1.5;                           // its height, and the row pitch
  const left = MARK.cx - (MARK.R * Math.sqrt(3)) / 2;  // the mark's bottom-left corner
  const centreY = MARK.cy - MARK.fillet / 2;           // the drawn mark's own centre
  const base = centreY + MARK.R * 0.75;                // the mark's base line
  const up = trianglePath({ cx: 0, cy: 0, R: unit, fillet: MARK.fillet / 2 });

  return [
    { d: up, x: left + side / 2, y: base - 0.75 * unit },
    { d: up, x: left + (3 * side) / 2, y: base - 0.75 * unit },
    { d: up, x: MARK.cx, y: base - height - 0.75 * unit },
  ];
}
