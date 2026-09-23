import { useEffect, useId, useRef, useState } from "react";
import { useThemeColors, type ThemeColors } from "../lib/theme";

/**
 * The Autora mark, alive.
 *
 * One drawing serves everywhere the app signs its name -- the header, the
 * agent's side of the conversation, the live button, the empty session -- and
 * it carries state by how it moves rather than by a second indicator parked
 * next to it. A blinking dot says "something is on"; a mark that breathes,
 * turns and warms through the brand's colours says *what* is on, in the place
 * you were already looking.
 *
 * Four states:
 *
 *   rest     still, cool, quietly lit -- nothing is happening
 *   live     slow breathing, the microphone is open
 *   working  the points morph and the gradient turns, the model is writing
 *   settle   a single bloom as the work lands, then back to rest
 *
 * `settle` is the one worth explaining: a morph that simply stops is a
 * flinch, and the moment a reply finishes is exactly the moment worth
 * marking. So the end of the work plays a short outward bloom and falls back
 * to rest on its own -- the animation finishes rather than being switched off.
 */

export type MarkState = "rest" | "live" | "working" | "settle";

/** How long the finishing bloom runs. Matches --settle-ms in styles.css. */
const SETTLE_MS = 900;

const TAU = Math.PI * 2;

/**
 * A four-pointed spark on the 32-unit grid the icon set uses.
 *
 * Every variant is built from the same eight points in the same order, which
 * is what makes them morphable: SVG interpolates `d` pairwise, so two shapes
 * only blend if their commands line up one for one. Vary the radii and the
 * rotation, never the structure.
 */
function spark(outer: number, inner: number, turn = 0): string {
  const points: string[] = [];
  for (let i = 0; i < 8; i += 1) {
    const r = i % 2 === 0 ? outer : inner;
    const a = (i / 8) * TAU + turn;
    points.push(`${(16 + r * Math.sin(a)).toFixed(2)} ${(16 - r * Math.cos(a)).toFixed(2)}`);
  }
  return `M${points[0]}L${points.slice(1).join("L")}Z`;
}

const REST = spark(9, 2.6);

/** The morph loop. Opens and closes on REST so the cycle seams invisibly and
    so stopping mid-flight never lands far from where the mark sits at rest. */
const MORPH = [
  REST,
  spark(9.5, 4.1, 0.13),
  spark(8.1, 2.1, -0.11),
  spark(9.7, 3.4, 0.06),
  spark(8.6, 2.9, -0.05),
  REST,
].join(";");

/** The bloom: out, and softly back. */
const BLOOM = [REST, spark(10.4, 4.6, 0.09), spark(9.2, 3.0, 0.02), REST].join(";");

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
 * "working" into a bloom that expires by itself.
 */
function useFinish(state: MarkState): MarkState {
  const [finishing, setFinishing] = useState(false);
  const was = useRef(state);

  useEffect(() => {
    const left = was.current === "working" && state !== "working";
    was.current = state;
    if (!left) return;
    setFinishing(true);
    const timer = window.setTimeout(() => setFinishing(false), SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [state]);

  if (state === "working") return "working";
  return finishing ? "settle" : state;
}

export function AutoraMark({
  state = "rest",
  size = 16,
  className = "",
}: {
  state?: MarkState;
  size?: number;
  className?: string;
}) {
  const shown = useFinish(state);
  const still = useStillness();
  // Every instance needs its own gradient ids: two <defs> sharing an id on one
  // page is one gradient, and the second mark would quietly inherit the
  // first's animation.
  const uid = useId().replace(/:/g, "");
  const colors = useThemeColors();

  const moving = !still && (shown === "working" || shown === "settle" || shown === "live");
  const morphing = !still && (shown === "working" || shown === "settle");

  // Working turns quickly and keeps going; the bloom runs once, slower, and
  // stops on the resting shape.
  const morph = shown === "settle"
    ? { values: BLOOM, dur: `${SETTLE_MS}ms`, repeat: "1" }
    : { values: MORPH, dur: "4.2s", repeat: "indefinite" };

  return (
    <span
      className={`amark is-${shown} ${className}`.trim()}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <svg viewBox="0 0 32 32" width={size} height={size} role="presentation">
        <defs>
          <linearGradient id={`g${uid}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor={colors.accent}>
              {moving && (
                <animate
                  attributeName="stop-color"
                  values={warm(colors)}
                  dur="6s"
                  repeatCount="indefinite"
                />
              )}
            </stop>
            <stop offset="1" stopColor={colors.accent2}>
              {moving && (
                <animate
                  attributeName="stop-color"
                  values={cool(colors)}
                  dur="6s"
                  repeatCount="indefinite"
                />
              )}
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

        {/* A thread of the gradient orbiting the mark while it works. Dashed
            rather than solid so the rotation is legible at 20px. */}
        <circle
          className="amark-orbit"
          cx="16"
          cy="16"
          r="12.4"
          fill="none"
          stroke={`url(#g${uid})`}
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeDasharray="7 62"
        />

        <path className="amark-star" d={REST} fill={`url(#g${uid})`}>
          {morphing && (
            <animate
              // Remounted whenever the loop changes, so a bloom starts from
              // the top instead of inheriting the morph's clock.
              key={shown}
              attributeName="d"
              values={morph.values}
              dur={morph.dur}
              repeatCount={morph.repeat}
              fill="freeze"
              calcMode="spline"
              keySplines={
                shown === "settle"
                  ? "0.2 0.9 0.2 1; 0.4 0 0.2 1; 0.4 0 0.2 1"
                  : "0.4 0 0.2 1; 0.4 0 0.2 1; 0.4 0 0.2 1; 0.4 0 0.2 1; 0.4 0 0.2 1"
              }
            />
          )}
        </path>
      </svg>
    </span>
  );
}
