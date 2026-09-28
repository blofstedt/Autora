import { useEffect, useId, useRef, useState } from "react";
import { useThemeColors, type ThemeColors } from "../lib/theme";
import { BLOOM, MARK, REST, flipFrames, stackingUnits } from "../lib/mark";

/**
 * The Autora mark, alive.
 *
 * One drawing serves everywhere the app signs its name -- the header, the
 * agent's side of the conversation, the live button, the empty session -- and
 * it carries state by how it moves rather than by a second indicator parked
 * next to it. A blinking dot says "something is on"; a mark that breathes,
 * flips and warms through the brand's colours says *what* is on, in the place
 * you were already looking.
 *
 * The shape itself is in lib/mark.ts -- one equilateral triangle with rounded
 * corners, the same geometry the favicon, the Umbrel tile and the home-screen
 * icons are rendered from. Seven states:
 *
 *   rest      still, cool, quietly lit -- nothing is happening
 *   live      slow breathing, the microphone is open
 *   thinking  it turns over on its own axis, again and again, and the
 *             gradient turns with it -- the model is working something out
 *   building  the mark stacks itself together out of smaller copies of
 *             itself, bottom row first, while colours run across the pieces
 *   settle    a single bloom as the work lands, then back to rest
 *   waiting   a slow, warm beckon -- it is stopped on something only you can do
 *   error     one dim shiver as a turn fails, then back to rest
 *
 * `thinking` and `building` are the two ways of being busy, and the difference
 * is worth the extra state: a mark that flips is deliberating, one that is
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

/** The flip, sampled from a rotation and looping seamlessly because its first
    and last frames are both the upright mark. */
const FLIP = flipFrames().join(";");
const FLIP_MS = 4600;

/** One turn of the building animation: stack up, hold, come apart, again. */
const BUILD_MS = 3600;

/** Below this the pieces are too small to be seen as pieces, so the mark is
    built from four rather than nine. */
const COARSE_BELOW = 22;
const FINE = stackingUnits(3);
const COARSE = stackingUnits(2);

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

/** One small copy of the mark, arriving: drops in from below, pops to size,
    holds the row it belongs to, and comes apart with the rest at the end. */
function Piece({ d, x, y, at, fill }: { d: string; x: number; y: number; at: number; fill: string }) {
  // Appears at `at`, has settled by `at + 0.13`, and dissolves at 0.86.
  const times = [0, at, at + 0.045, at + 0.13, 0.86, 1].map((t) => t.toFixed(3)).join(";");
  const ease = "0 0 1 1;0.16 1.15 0.32 1;0 0 1 1;0 0 1 1;0.4 0 0.6 1";

  return (
    <g transform={`translate(${x.toFixed(3)} ${y.toFixed(3)})`}>
      <g>
        <animateTransform
          attributeName="transform"
          type="translate"
          dur={`${BUILD_MS}ms`}
          repeatCount="indefinite"
          calcMode="spline"
          keyTimes={times}
          keySplines={ease}
          values="0 2.4;0 2.4;0 0;0 0;0 0;0 0.5"
        />
        <g>
          <animateTransform
            attributeName="transform"
            type="scale"
            dur={`${BUILD_MS}ms`}
            repeatCount="indefinite"
            calcMode="spline"
            keyTimes={times}
            keySplines={ease}
            values="0.4;0.4;1.16;1;1;0.82"
          />
          <path d={d} fill={fill}>
            <animate
              attributeName="opacity"
              dur={`${BUILD_MS}ms`}
              repeatCount="indefinite"
              keyTimes={times}
              values="0;0;1;1;1;0"
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
  const shown = useFinish(state, pulse);
  const still = useStillness();
  // Every instance needs its own gradient ids: two <defs> sharing an id on one
  // page is one gradient, and the second mark would quietly inherit the
  // first's animation.
  const uid = useId().replace(/:/g, "");
  const colors = useThemeColors();

  const busy = shown === "thinking" || shown === "building";
  const shifting = !still && (busy || shown === "live" || shown === "settle");

  const pieces = size < COARSE_BELOW ? COARSE : FINE;
  // The pieces arrive over the first 40% of the cycle, in order, with a small
  // stagger so the base row is laid before the row above it starts.
  const first = 0.05;
  const span = 0.38;

  return (
    <span
      className={`amark is-${shown} ${idle ? "is-idle" : ""} ${className}`.replace(/\s+/g, " ").trim()}
      style={{ width: size, height: size, ...(attention ? { "--attention": attention.toFixed(2) } : {}) } as React.CSSProperties}
      aria-hidden="true"
    >
      <svg viewBox={`0 0 ${MARK.box} ${MARK.box}`} width={size} height={size} role="presentation">
        <defs>
          {/* Measured across the mark's own box rather than each shape's, so
              the pieces of a mark still being built are coloured by where they
              sit and the finished thing matches the mark at rest. */}
          <linearGradient
            id={`g${uid}`}
            gradientUnits="userSpaceOnUse"
            x1="8.98"
            y1="9.74"
            x2="23.02"
            y2="22.28"
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
            {/* The shape it is heading for, so what the pieces are making is
                never in doubt while they are still arriving. */}
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
                keyTimes="0;0.05;0.45;0.86;1"
                values="0.18;0.4;0.3;0;0"
              />
            </path>
            {pieces.map((p, i) => (
              <Piece
                key={i}
                d={p.d}
                x={p.x}
                y={p.y}
                at={first + (span * i) / pieces.length}
                fill={`url(#g${uid})`}
              />
            ))}
          </g>
        ) : (
          <path className="amark-shape" d={REST} fill={`url(#g${uid})`}>
            {!still && busy && (
              <animate
                key={shown}
                attributeName="d"
                values={FLIP}
                dur={`${FLIP_MS}ms`}
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
