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

/** How long one pass of the cycle takes. */
export const MORPH_MS = 9000;

/** Frames the cycle is written out as: what the animation interpolates. */
const MORPH_STEPS = 30;

/** The cycle's own numbers, the same ones the frames have always been drawn
    from, gathered so the single-frame reader and the frame list cannot drift. */
const CYCLE = { breath: 0.3, turns: 2, pulses: 2 };

/** Where the shared docs for these live. */
type CycleOptions = {
  /**
   * How much of the shrinking the mark does not do.
   *
   * The circle drawn inside the triangle is a good deal smaller than the
   * triangle: same height it is not, and going all the way in reads as the mark
   * deflating rather than as the mark turning. A little scale on the way out
   * takes most of that back, so the mark breathes instead of shrinking. 0 is
   * the pure incircle, 1 is a circle as tall as the triangle was.
   */
  breath?: number;
  /**
   * How many thirds of a turn the cycle covers.
   *
   * Two, not one: the mark has to be sharp at turn 0, turn 120 and turn 240
   * degrees and nowhere else, and those three are the same picture only for
   * whole thirds. At one third the half-way sharp moment is the mark upside
   * down, which is not the mark. Three-fold symmetry is what keeps the loop
   * seamless either way.
   */
  turns?: number;
  /** How many times the mark opens out into the circle in one cycle. Each
      opening is two still moments -- the circle and the triangle -- and the
      cycle is drawn so that both of them are still. */
  pulses?: number;
};

/** Reads `options` over the cycle's own numbers. */
function cycle(options: CycleOptions = {}) {
  return { ...CYCLE, ...options };
}

/**
 * The mark's pose at one point in the cycle, as a path.
 *
 * The cycle is a function of the phase, not a list of pictures: the fillet
 * opens along a cosine, the shape turns, and both are read off at whatever
 * phase is asked for. `morphFrames` is this function sampled for the
 * animation; `morphClose` reads poses out of it directly, which is how the
 * close can start from the exact pose that is on screen rather than from the
 * nearest frame the animation happens to hold.
 */
export function morphFrame(p: number, options: CycleOptions = {}): string {
  const { breath, turns, pulses } = cycle(options);
  // 0 at the triangle, 1 at the circle, `pulses` times round the cycle.
  const open = Math.sin(Math.PI * pulses * p) ** 2;
  const fillet = MARK.fillet + (CIRCLE_FILLET - MARK.fillet) * open;
  // Drawn about the origin and moved afterwards, so the frame can be centred on
  // its own outline. A shape that is also turning has no fixed idea of
  // "half a fillet up": which corner is the apex changes, and with it the drawn
  // box, so a fixed offset would let the mark bob as it turned.
  const points = outlinePoints({
    cy: 0,
    fillet,
    scale: 1 + breath * open,
    turn: -Math.PI / 2 + (TAU / 3) * turns * p,
  });
  const [x0, y0, x1, y1] = bbox(points);
  const dx = MARK.cx - (x0 + x1) / 2;
  const dy = MARK.cy - (y0 + y1) / 2;
  return pathOf(points.map(([x, y]) => [x + dx, y + dy]));
}

/** The cycle as the list of frames the animation interpolates between. */
export function morphFrames(steps = MORPH_STEPS, options: CycleOptions = {}): string[] {
  const frames: string[] = [];
  for (let i = 0; i <= steps; i += 1) frames.push(morphFrame(i / steps, options));
  return frames;
}

/** The cycle as one values string: what a working mark is drawn from. */
export const MORPH = morphFrames().join(";");

/** How far round the cycle the mark is, having been turning since `startedAt`. */
export function morphPhase(startedAt: number, now: number): number {
  const turning = now - startedAt;
  return turning <= 0 ? 0 : (turning % MORPH_MS) / MORPH_MS;
}

/**
 * The nearest phase that draws the sharp mark: a whole pulse of the cycle,
 * where the fillet has closed back on the triangle.
 *
 * It is also the only place the mark may be left. A triangle has three-fold
 * symmetry, so every one of these is the same picture, and a close that ends on
 * one of them ends on the mark however the cycle was turning when it was asked.
 */
export function morphSharp(p: number, options: CycleOptions = {}): number {
  const { pulses } = cycle(options);
  return Math.min(1, Math.max(0, Math.round(p * pulses) / pulses));
}

/** How long the longest way home takes: a whole quarter of the cycle of it.
    Every close takes this long per quarter, so the mark comes home at one speed
    however far it has to travel. */
export const MORPH_CLOSE_MS = 700;

/** How many steps the way home is drawn in: 14 of 700ms is a frame every 50ms,
    which is as fine as the morph's own 30 frames in 9s and smoother than the
    mark ever moves under its own steam. */
export const MORPH_CLOSE_STEPS = 14;

/** How long the way home takes from the phase `from`, which is at most a
    quarter of the cycle and at least nothing at all.
 *
 * Coming home at one *speed* rather than in one time is what keeps it from
 * looking like either a snap or a stall: a mark caught at the circle is a
 * quarter of a cycle away and takes the whole of MORPH_CLOSE_MS, while one
 * caught a hair off the triangle is over almost at once, instead of a near miss
 * sitting still for as long as the long one does.
 */
export function morphCloseMs(from: number, options: CycleOptions = {}): number {
  const { pulses } = cycle(options);
  const furthest = 1 / (2 * pulses);
  return MORPH_CLOSE_MS * (Math.abs(morphSharp(from, options) - from) / furthest);
}

/**
 * The way home: frames that carry the mark from the pose on screen back to the
 * triangle, so an ending blooms from the mark rather than from a mark that was
 * switched off mid-turn.
 *
 * The poses are the cycle's own, read along the phase towards the nearest sharp
 * moment, so what plays is the movement the mark was already making, only
 * faster -- a quarter of a cycle is the most there ever is to come home from.
 * The phase is eased at both ends (a shape that arrives at the triangle still
 * travelling is the flinch this is here to avoid), which is why the caller can
 * interpolate the frames flat.
 *
 * It ends on the resting mark twice: once as the cycle draws it there, which is
 * the same picture with its corners renamed, and once as REST itself, because
 * that string is the frame the bloom begins from. A step between two identical
 * pictures is no step at all.
 */
export function morphClose(from: number, steps = MORPH_CLOSE_STEPS, options: CycleOptions = {}): string[] {
  const to = morphSharp(from, options);
  const frames: string[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    frames.push(morphFrame(from + (to - from) * (t * t * (3 - 2 * t)), options));
  }
  frames.push(REST);
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


/** How long the finishing bloom runs. Kept in step with --settle-ms in
    styles.css: the shape and the light behind it are animated apart and have to
    land together. */
export const SETTLE_MS = 900;

/** The bloom's own easing: a breath out, and a slower fall back to rest. */
export const BLOOM_SPLINES = "0.2 0.9 0.2 1; 0.4 0 0.2 1; 0.4 0 0.2 1; 0.4 0 0.2 1";

/** How short a way home is worth drawing at all. Shorter than this the mark was
    caught all but on the triangle, and the bloom on its own says it better than
    a step of a few hundredths of a unit would -- which also keeps every close's
    keyTimes far enough apart not to round onto one another. */
export const CLOSE_LEAST_MS = 90;

/** An ending that was caught mid-morph: the phase the mark was at, and how long
    coming home from there takes -- as long as it has to travel. */
export type Closing = { at: number; ms: number };

/** Numbers as an animation attribute wants them. */
export const times = (t: number[]) => t.map((v) => v.toFixed(4)).join(";");

/** Which phase the mark was at when the work ended, if the ending is to come
    home first, and how long that takes: null when there is nothing worth
    closing -- a mark already on the triangle, or one caught so near it that the
    bloom alone says it better. */
export function caughtIn(from: number, options: CycleOptions = {}): Closing | null {
  const ms = morphCloseMs(from, options);
  return ms >= CLOSE_LEAST_MS ? { at: from, ms } : null;
}

/**
 * The end of a turn that was caught mid-morph: the mark comes home, and the
 * bloom plays from the mark it lands on.
 *
 * One animation rather than two, because two `d` animations on the one path
 * fight over the attribute; the frame list is the close's followed by the
 * bloom's, and the keyTimes give the close the first share of the run. The
 * close's frames are already eased along the phase (see morphClose above), so
 * they are interpolated flat and the shape has no speed at either end of them.
 */
export function settleHome({ at, ms: closeMs }: Closing) {
  const close = morphClose(at);
  const share = closeMs / (closeMs + SETTLE_MS);
  const keys = close.map((_, i) => (i / (close.length - 1)) * share);
  // The bloom's own moments, placed in the share of the run left to it. Not
  // `Math.max(t, share)` and the like: a short close puts the bloom's first
  // moment *before* the close's last one, and the bloom would start over the
  // top of the close -- exactly the two animations fighting this avoids.
  keys.push(...[0.25, 0.5, 0.75, 1].map((t) => share + (1 - share) * t));
  return {
    values: [...close, ...BLOOM.slice(1)].join(";"),
    keyTimes: times(keys),
    keySplines: [...close.slice(1).map(() => "0 0 1 1"), ...BLOOM_SPLINES.split("; ")].join("; "),
    dur: `${closeMs + SETTLE_MS}ms`,
  };
}

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

/**
 * The building animation's clock.
 *
 * One turn is a fixed length and everything drawn during it -- the quarters
 * falling, the breath when they are up, the close -- is a fraction of that
 * length, so the length lives here, with the geometry, rather than in the
 * component that happens to play it. What matters beyond the length is where in
 * the turn the build may be left: that is `buildWait` below.
 */
export const BUILD_MS = 3400;

/**
 * The close, as fractions of a turn: from CLOSE_AT the three quarters are
 * drawn into the mark, by CLOSE_IN the mark is drawn, by CLOSE_ON it has
 * arrived in its place, and from CLOSE_FADE it begins to go -- the breath the
 * loop takes before it starts over.
 *
 * Between CLOSE_ON and CLOSE_FADE what is on screen is the resting mark: the
 * same shape, at the same size, in the same place, in the same gradient, which
 * is also the first frame of the thinking morph. That is what makes it the only
 * moment a build can be left without a jump, and components/AutoraMark.tsx
 * writes its close keyTimes from these numbers so that the drawing and the
 * rule cannot drift apart.
 */
export const CLOSE_AT = 0.66;
export const CLOSE_IN = 0.78;
export const CLOSE_ON = 0.8;
export const CLOSE_FADE = 0.93;

/**
 * How much longer the mark has to keep building, now that the work it was
 * showing is done.
 *
 * `started` is when the build began and `now` is the moment the app stopped
 * saying "building" -- any monotonic clock, in milliseconds. The answer is 0
 * when the mark may hand over at once, and otherwise the wait until it may.
 *
 * The stack is a loop, and the app's idea of when a build is over is not the
 * loop's: a step that comes back in 300ms ends it a tenth of the way round,
 * with a quarter still in the air, the gap open and the mark not yet made. Cut
 * there, the mark jumps into the morph, which is a different shape at a
 * different moment. Held to its close, the two agree and nobody sees the
 * change. The wait is never a whole turn (never more than ~3s): a build that
 * outlasts a turn is caught by the close of the next one.
 */
export function buildWait(started: number, now: number, ms = BUILD_MS): number {
  const turn = (((now - started) % ms) + ms) % ms;
  if (turn >= ms * CLOSE_ON && turn <= ms * CLOSE_FADE) return 0;
  const next = turn < ms * CLOSE_ON ? ms * CLOSE_ON : ms * (1 + CLOSE_ON);
  return next - turn;
}
