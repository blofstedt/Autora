import { useEffect, useId, useRef, useState } from "react";
import { useThemeColors, type ThemeColors } from "../lib/theme";
import {
  BLOOM,
  BUILD_MS,
  CLOSE_AT,
  CLOSE_FADE,
  CLOSE_IN,
  CLOSE_ON,
  DRAWN_BOX,
  MARK,
  REST,
  buildWait,
  morphFrames,
  stackUnits,
} from "../lib/mark";

/**
 * The Autora mark, alive.
 *
 * One drawing serves everywhere the app signs its name -- the header, the
 * agent's side of the conversation, the live button, the empty session -- and
 * it carries state by how it moves rather than by a second indicator parked
 * next to it. A blinking dot says "something is on"; a mark that breathes,
 * morphs and warms through the brand's colours says *what* is on, in the place
 * you were already looking.
 *
 * The shape itself is in lib/mark.ts -- one equilateral triangle with rounded
 * corners, the same geometry the favicon, the Umbrel tile and the home-screen
 * icons are rendered from. Seven states:
 *
 *   rest      still, cool, quietly lit -- nothing is happening
 *   live      slow breathing, the microphone is open
 *   thinking  it opens out into the circle inside it and closes again,
 *             twice, while it turns -- the model is working something out
 *   building  the mark stacks itself out of three quarters of itself, laid
 *             one at a time, and then closes on the mark and hands over
 *   settle    a single bloom as the work lands, then back to rest
 *   waiting   a slow, warm beckon -- it is stopped on something only you can do
 *   error     one dim shiver as a turn fails, then back to rest
 *
 * `thinking` and `building` are the two ways of being busy, and the difference
 * is worth the extra state: a mark that morphs is deliberating, one that is
 * assembling itself is doing. Callers that know only that the agent is busy
 * can keep passing "working", which is what the two of them replaced.
 *
 * The app's one presence (the mark in the sidebar) also takes `idle`: at rest
 * it breathes very slowly and now and then catches the light, so something
 * that is switched on never looks switched off. Only that one mark does it --
 * a thread full of breathing avatars would be wallpaper, not life.
 *
 * `settle` is the one worth explaining: a morph that simply stops is a
 * flinch, and the moment a reply finishes is exactly the moment worth
 * marking. So the end of the work plays a short outward bloom and falls back
 * to rest on its own -- the animation finishes rather than being switched off.
 *
 * The build is the other one. It is a loop of a fixed length, and the app stops
 * saying "building" as soon as the step it was showing comes back -- a tenth of
 * the way through a turn, if the step was quick -- which would leave a quarter
 * in the air and the gap open and cut to a morph that is a different shape at a
 * different moment. So a build is held for the rest of its turn, to the close
 * (see useWholeTurn and buildWait): the same mark the morph draws, no jump.
 */

export type MarkState =
  | "rest"
  | "live"
  | "thinking"
  | "building"
  | "settle"
  | "waiting"
  | "error"
  /** The name these two shared before they were told apart. Still accepted. */
  | "working";

/** How long the finishing bloom runs. Matches --settle-ms in styles.css. */
const SETTLE_MS = 900;

/** The morph, drawn as frames of the same 24 points. Twice round the cycle the
    mark opens out into the circle inside it and closes again, and all the while
    it turns; the loop has no seam because two thirds of a turn is a triangle's
    own symmetry, so the last frame is the first one with its corners renamed. */
const MORPH = morphFrames().join(";");
const MORPH_MS = 9000;

/** When the three quarters fall in, how long a fall takes, and when they are
    gone again. The last one has settled by 0.50, which leaves a third of the
    turn in the state worth watching: not a diagram of a triangle, and not the
    triangle. BUILD_MS, CLOSE_AT and the rest of the close come from
    ../lib/mark, because where in a turn a build may be left depends on them. */
const LAY_FROM = 0.04;
const LAY_GAP = 0.085;
const FALL = 0.155;
const CLOSE_BY = 0.76;

/** A keyTimes list, at the precision SVG is read at. */
const times = (t: number[]) => t.map((v) => v.toFixed(4)).join(";");

const STACK = stackUnits();

/** Brand violet, cyan and orchid, turning through each other. The green that
    used to mean "live" is deliberately absent -- state is carried by motion. */
const warm = (c: ThemeColors) => [c.accent, c.accent2, c.glow, c.accent].join(";");
const cool = (c: ThemeColors) => [c.accent2, c.glow, c.accent, c.accent2].join(";");

/** Someone who has asked for less motion gets a still mark, not a slower one. */
function useStillness(): boolean {
  const [still, setStill] = useState(false);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    const read = () => setStill(query.matches);
    read();
    query.addEventListener("change", read);
    return () => query.removeEventListener("change", read);
  }, []);
  return still;
}

/**
 * Hold `settle` for a beat after work stops.
 *
 * The caller only knows whether the agent is busy; it should not have to run a
 * timer to give the ending somewhere to go. This turns the falling edge of
 * either busy state into a bloom that expires by itself. Only an ending that
 * lands at rest blooms: work that stops on a question, or on a failure, says
 * that instead.
 *
 * `pulse` asks for the same bloom on demand: a counter, and each change plays
 * it once (someone came back to the tab; a memory was kept).
 */
function useFinish(state: MarkState, pulse = 0): MarkState {
  const [finishing, setFinishing] = useState(false);
  const was = useRef(state === "working" ? "thinking" : state);
  const lastPulse = useRef(pulse);

  useEffect(() => {
    const now = state === "working" ? "thinking" : state;
    const left = was.current === "thinking" || was.current === "building"
      ? now === "rest" || now === "live"
      : false;
    was.current = now;
    const asked = pulse !== lastPulse.current;
    lastPulse.current = pulse;
    if (!left && !asked) return;
    setFinishing(true);
    const timer = window.setTimeout(() => setFinishing(false), SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [state, pulse]);

  const now = state === "working" ? "thinking" : state;
  if (now === "thinking" || now === "building" || now === "waiting" || now === "error") return now;
  return finishing ? "settle" : now;
}

/**
 * Hold the build for the rest of its turn.
 *
 * The stack is a loop, so the app leaving `building` is not the same thing as
 * the animation being over: a step that comes back in 300ms ends it near the
 * start of a turn. This keeps the mark building until the turn reaches its
 * close -- the moment the loop has drawn the resting mark and is about to
 * breathe and start over, which is also the morph's first frame -- and only then
 * lets the state through. buildWait in lib/mark.ts works out how long that is;
 * this is the timer and the bookkeeping. The cost is at most one turn of the
 * mark saying "doing" a moment after the work stopped, and what it buys is an
 * animation that finishes rather than one that is switched off.
 *
 * Nothing is held when motion is off: the animation is not drawn then, and a
 * still mark has no turn to complete.
 */
function useWholeTurn(state: MarkState, still: boolean): MarkState {
  /** When this build began, on the same clock the timers use; null at rest. */
  const [started, setStarted] = useState<number | null>(null);

  useEffect(() => {
    if (still) {
      if (started !== null) setStarted(null);
      return;
    }
    if (state === "building") {
      setStarted((at) => at ?? performance.now());
      return;
    }
    if (started === null) return;
    const wait = buildWait(started, performance.now());
    if (wait <= 0) {
      setStarted(null);
      return;
    }
    const timer = window.setTimeout(() => setStarted(null), wait);
    return () => window.clearTimeout(timer);
  }, [state, started, still]);

  return state === "building" || (!still && started !== null) ? "building" : state;
}

/**
 * One quarter of the mark, arriving: it rises into its place from below, lands
 * with a squash, rights itself, and holds there until the three of them close.
 *
 * The squash is the whole trick. A piece that simply appears is a fade; a piece
 * that lands on its base with the weight of the drop in it is a thing being
 * stacked, and a two-axis scale is the only way to say that about a shape with
 * no limbs. It is over in a tenth of a second -- about as long as you can see it
 * without it turning into a cartoon.
 */
function StackPiece({ d, x, y, at, fill }: { d: string; x: number; y: number; at: number; fill: string }) {
  const land = at + FALL;
  const rise = [0, at, land, land + 0.05, land + 0.1, 1];
  const form = [0, at, land, land + 0.035, land + 0.075, land + 0.12, 1];
  const fade = [0, at, land, land + 0.03, CLOSE_AT, CLOSE_BY, 1];

  return (
    <g transform={`translate(${x.toFixed(3)} ${y.toFixed(3)})`}>
      <g>
        <animateTransform
          attributeName="transform"
          type="translate"
          dur={`${BUILD_MS}ms`}
          repeatCount="indefinite"
          calcMode="spline"
          keyTimes={times(rise)}
          keySplines="0 0 1 1;0.2 0.6 0.35 1;0.4 0 0.5 1;0.4 0 0.6 1;0 0 1 1"
          values="0 2.2;0 2.2;0 -0.12;0 0.07;0 0;0 0"
        />
        <g>
          <animateTransform
            attributeName="transform"
            type="scale"
            dur={`${BUILD_MS}ms`}
            repeatCount="indefinite"
            calcMode="spline"
            keyTimes={times(form)}
            keySplines="0 0 1 1;0.25 0 0.5 1;0.35 0 0.5 1;0.4 0 0.6 1;0.4 0 0.6 1;0 0 1 1"
            values="0.7 0.7;0.7 0.7;1.2 0.82;0.94 1.08;1.03 0.98;1 1;1 1"
          />
          <path d={d} fill={fill}>
            <animate
              attributeName="opacity"
              dur={`${BUILD_MS}ms`}
              repeatCount="indefinite"
              keyTimes={times(fade)}
              values="0;0;1;1;1;0;0"
            />
          </path>
        </g>
      </g>
    </g>
  );
}

export function AutoraMark({
  state = "rest",
  size = 16,
  className = "",
  idle = false,
  attention = 0,
  pulse = 0,
}: {
  state?: MarkState;
  size?: number;
  className?: string;
  /** The app's presence: breathe slowly at rest instead of holding still. */
  idle?: boolean;
  /** 0..1 -- how closely it is attending to you right now (typing). */
  attention?: number;
  /** Change it to play the settle bloom once. */
  pulse?: number;
}) {
  const still = useStillness();
  const shown = useFinish(useWholeTurn(state, still), pulse);
  // Every instance needs its own gradient ids: two <defs> sharing an id on one
  // page is one gradient, and the second mark would quietly inherit the
  // first's animation.
  const uid = useId().replace(/:/g, "");
  const colors = useThemeColors();

  const busy = shown === "thinking" || shown === "building";
  const shifting = !still && (busy || shown === "live" || shown === "settle");


  return (
    <span
      className={`amark is-${shown} ${idle ? "is-idle" : ""} ${className}`.replace(/\s+/g, " ").trim()}
      style={{ width: size, height: size, ...(attention ? { "--attention": attention.toFixed(2) } : {}) } as React.CSSProperties}
      aria-hidden="true"
    >
      <svg viewBox={`0 0 ${MARK.box} ${MARK.box}`} width={size} height={size} role="presentation">
        <defs>
          {/* Measured across the mark's own drawn box rather than each shape's,
              so the pieces of a mark still being built are coloured by where
              they sit and the finished thing matches the mark at rest. */}
          <linearGradient
            id={`g${uid}`}
            gradientUnits="userSpaceOnUse"
            x1={DRAWN_BOX.x0}
            y1={DRAWN_BOX.y0}
            x2={DRAWN_BOX.x1}
            y2={DRAWN_BOX.y1}
          >
            <stop offset="0" stopColor={colors.accent}>
              {shifting && <animate attributeName="stop-color" values={warm(colors)} dur="6s" repeatCount="indefinite" />}
            </stop>
            <stop offset="0.55" stopColor={colors.glow}>
              {shifting && <animate attributeName="stop-color" values={cool(colors)} dur="7.4s" repeatCount="indefinite" />}
            </stop>
            <stop offset="1" stopColor={colors.accent2}>
              {shifting && <animate attributeName="stop-color" values={warm(colors)} dur="5.4s" repeatCount="indefinite" />}
            </stop>
          </linearGradient>

          {/* The wash behind the mark: the same colours, spread and faded, so
              the glow is the mark's own light rather than a grey halo. */}
          <radialGradient id={`w${uid}`}>
            <stop offset="0" stopColor={colors.glow} stopOpacity="0.85" />
            <stop offset="1" stopColor={colors.accent} stopOpacity="0" />
          </radialGradient>
        </defs>

        <circle className="amark-wash" cx="16" cy="16" r="15" fill={`url(#w${uid})`} />

        {shown === "building" && !still ? (
          <g>
            {/* The shape they are making, so what three quarters are for is
                never in doubt -- and the ghost is the whole mark, including
                the middle the pieces leave open, which is where it arrives. */}
            <path
              className="amark-ghost"
              d={REST}
              fill="none"
              stroke={colors.accent}
              strokeWidth="0.6"
            >
              <animate
                attributeName="opacity"
                dur={`${BUILD_MS}ms`}
                repeatCount="indefinite"
                keyTimes="0;0.45;0.6;0.74;1"
                values="0.16;0.42;0.34;0;0"
              />
            </path>

            {/* The stack, breathing once it is up: held weight that is
                perfectly still reads as a picture, not as a thing. */}
            <g>
              <animateTransform
                attributeName="transform"
                type="translate"
                dur={`${BUILD_MS}ms`}
                repeatCount="indefinite"
                calcMode="spline"
                keyTimes="0;0.48;0.57;0.66;1"
                keySplines="0 0 1 1;0.4 0 0.3 1;0.4 0 0.6 1;0 0 1 1"
                values="0 0;0 0;0 -0.18;0 0;0 0"
              />
              {STACK.map((p, i) => (
                <StackPiece key={i} d={p.d} x={p.x} y={p.y} at={LAY_FROM + LAY_GAP * i} fill={`url(#g${uid})`} />
              ))}
            </g>

            {/* The close. The three stay put and fade where they are -- it is
                the gap between them that fills -- and the turn ends on the
                mark: the same shape, in the same gradient, that rest and the
                state after this one draw. So a build that reaches the end of
                its turn is a handover rather than a cut -- which is why the app
                is not allowed to stop it anywhere else (useWholeTurn above). */}
            <g>
              <animateTransform
                attributeName="transform"
                type="translate"
                dur={`${BUILD_MS}ms`}
                repeatCount="indefinite"
                calcMode="spline"
                keyTimes={times([0, CLOSE_AT, CLOSE_ON, 1])}
                keySplines="0 0 1 1;0.2 0.8 0.3 1;0 0 1 1"
                values="0 0.35;0 0.35;0 0;0 0"
              />
              <path className="amark-shape" d={REST} fill={`url(#g${uid})`}>
                <animate
                  attributeName="opacity"
                  dur={`${BUILD_MS}ms`}
                  repeatCount="indefinite"
                  calcMode="spline"
                  keyTimes={times([0, CLOSE_AT, CLOSE_IN, CLOSE_FADE, 1])}
                  keySplines="0 0 1 1;0.2 0.8 0.3 1;0 0 1 1;0.4 0 0.6 1"
                  values="0;0;1;1;0"
                />
              </path>
            </g>
          </g>
        ) : (
          <path className="amark-shape" d={REST} fill={`url(#g${uid})`}>
            {!still && busy && (
              <animate
                key={shown}
                attributeName="d"
                values={MORPH}
                dur={`${MORPH_MS}ms`}
                repeatCount="indefinite"
                calcMode="linear"
              />
            )}
            {!still && shown === "settle" && (
              <animate
                key="settle"
                attributeName="d"
                values={BLOOM.join(";")}
                dur={`${SETTLE_MS}ms`}
                repeatCount="1"
                fill="freeze"
                calcMode="spline"
                keySplines="0.2 0.9 0.2 1; 0.4 0 0.2 1; 0.4 0 0.2 1; 0.4 0 0.2 1"
              />
            )}
          </path>
        )}
      </svg>
    </span>
  );
}
