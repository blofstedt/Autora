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
 * Six states:
 *
 *   rest     still, cool, quietly lit -- nothing is happening
 *   live     slow breathing, the microphone is open
 *   working  the points morph and the gradient turns, the model is writing
 *   settle   a single bloom as the work lands, then back to rest
 *   waiting  a slow, warm beckon -- it is stopped on something only you can do
 *   error    one dim shiver as a turn fails, then back to rest
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

export type MarkState = "rest" | "live" | "working" | "settle" | "waiting" | "error";

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
 * "working" into a bloom that expires by itself. Only an ending that lands at
 * rest blooms: work that stops on a question, or on a failure, says that
 * instead.
 *
 * `pulse` asks for the same bloom on demand: a counter, and each change plays
 * it once (someone came back to the tab; a memory was kept).
 */
function useFinish(state: MarkState, pulse = 0): MarkState {
  const [finishing, setFinishing] = useState(false);
  const was = useRef(state);
  const lastPulse = useRef(pulse);

  useEffect(() => {
    const left = was.current === "working" && (state === "rest" || state === "live");
    was.current = state;
    const asked = pulse !== lastPulse.current;
    lastPulse.current = pulse;
    if (!left && !asked) return;
    setFinishing(true);
    const timer = window.setTimeout(() => setFinishing(false), SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [state, pulse]);

  if (state === "working" || state === "waiting" || state === "error") return state;
  return finishing ? "settle" : state;
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

  const moving = !still && (shown === "working" || shown === "settle" || shown === "live");
  const morphing = !still && (shown === "working" || shown === "settle");

  // Working turns quickly and keeps going; the bloom runs once, slower, and
  // stops on the resting shape.
  const morph = shown === "settle"
    ? { values: BLOOM, dur: `${SETTLE_MS}ms`, repeat: "1" }
    : { values: MORPH, dur: "4.2s", repeat: "indefinite" };

  return (
    <span
      className={`amark is-${shown} ${idle ? "is-idle" : ""} ${className}`.replace(/\s+/g, " ").trim()}
      style={{ width: size, height: size, ...(attention ? { "--attention": attention.toFixed(2) } : {}) } as React.CSSProperties}
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
