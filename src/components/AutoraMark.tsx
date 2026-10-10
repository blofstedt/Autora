import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useThemeColors, type ThemeColors } from "../lib/theme";
import { lookColors, type AgentLook } from "../lib/agentlook";
import {
  BUILD_MS,
  CLOSE_AT,
  CLOSE_FADE,
  CLOSE_IN,
  CLOSE_ON,
  DRAWN_BOX,
  MARK,
  MIC_MS,
  MIC_OPEN,
  MIC_PATH,
  MIC_SHUT,
  MORPH_MS,
  SETTLE_MS,
  BLOOM_SPLINES,
  bloomOf,
  morphOf,
  restOf,
  type Closing,
  buildWait,
  caughtIn,
  morphPhase,
  settleHome,
  stackUnits,
  times,
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

/** When the three quarters fall in, how long a fall takes, and when they are
    gone again. The last one has settled by 0.50, which leaves a third of the
    turn in the state worth watching: not a diagram of a triangle, and not the
    triangle. BUILD_MS, CLOSE_AT and the rest of the close come from
    ../lib/mark, because where in a turn a build may be left depends on them. */
const LAY_FROM = 0.04;
const LAY_GAP = 0.085;
const FALL = 0.155;
const CLOSE_BY = 0.76;


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
 * Hold `settle` for a beat after work stops, and say where the mark was when
 * the work landed.
 *
 * The caller only knows whether the agent is busy; it should not have to run a
 * timer to give the ending somewhere to go. This turns the falling edge of
 * either busy state into a bloom that expires by itself. Only an ending that
 * lands at rest blooms: work that stops on a question, or on a failure, says
 * that instead.
 *
 * A build is held to its own close (useWholeTurn above), so it is already drawn
 * as the resting mark when its turn ends. A morph is a nine-second loop and the
 * work underneath it can land anywhere in it, which used to cut the mark --
 * open at the circle, most of the time -- back to the triangle a frame later,
 * at the very moment the reply arriving was worth marking. So the ending also
 * reports where in the cycle it was caught and how long coming home from there
 * takes, and the drawing closes from there first: a quarter of a cycle is the
 * most there ever is to come home from, and it is the whole of MORPH_CLOSE_MS,
 * so the close is the mark's own movement at one speed rather than a cut.
 *
 * `pulse` asks for the same bloom on demand: a counter, and each change plays
 * it once (someone came back to the tab; a memory was kept).
 */
function useFinish(state: MarkState, pulse = 0): { shown: MarkState; close: Closing | null } {
  const [finishing, setFinishing] = useState<{ close: Closing | null } | null>(null);
  const was = useRef(state === "working" ? "thinking" : state);
  const lastPulse = useRef(pulse);
  /** When the morph's animation started, on the clock the timers use. The
      animation restarts every time the mark is shown thinking (it is keyed by
      the state), and so does this. */
  const turning = useRef(0);

  useEffect(() => {
    const now = state === "working" ? "thinking" : state;
    if (now === "thinking" && was.current !== "thinking") turning.current = performance.now();
    const left = was.current === "thinking" || was.current === "building"
      ? now === "rest" || now === "live"
      : false;
    // Where the morph was caught, and how long coming home from there takes.
    // A mark caught all but on the triangle has nothing worth closing: caughtIn
    // says so, and the bloom alone says it better than a step of a hair would.
    const close = left && was.current === "thinking"
      ? caughtIn(morphPhase(turning.current, performance.now()))
      : null;
    was.current = now;
    const asked = pulse !== lastPulse.current;
    lastPulse.current = pulse;
    if (!left && !asked) return;
    setFinishing({ close });
    const timer = window.setTimeout(
      () => setFinishing(null),
      close === null ? SETTLE_MS : close.ms + SETTLE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [state, pulse]);

  const now = state === "working" ? "thinking" : state;
  if (now === "thinking" || now === "building" || now === "waiting" || now === "error") {
    return { shown: now, close: null };
  }
  return finishing ? { shown: "settle", close: finishing.close } : { shown: now, close: null };
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
  voice = null,
  look = null,
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
  /**
   * Who has the floor, in live mode -- and with it the shape of the mark.
   *
   * "you" is the microphone, standing up out of the triangle while the person
   * is being heard; "agent" is the triangle, while the console is the one
   * talking. Left out, the mark is whatever `state` says, which is what every
   * other place the app signs its name wants.
   *
   * The change between the two is drawn rather than cut (see MIC_OPEN in
   * lib/mark.ts), so the mark says who is speaking by becoming the thing that
   * is speaking, in the corner of the eye the conversation is already in.
   */
  voice?: "you" | "agent" | null;
  /** An agent of the Organization: its own shape and colours, the same
      movement. Left out, the mark is Autora's triangle in the brand's. */
  look?: AgentLook | null;
}) {
  const still = useStillness();
  const { shown, close } = useFinish(useWholeTurn(state, still), pulse);
  // Every instance needs its own gradient ids: two <defs> sharing an id on one
  // page is one gradient, and the second mark would quietly inherit the
  // first's animation.
  const uid = useId().replace(/:/g, "");
  const theme = useThemeColors();
  const own = look ? lookColors(look) : null;
  const colors: ThemeColors = own ? { ...theme, ...own.colors } : theme;
  const sides = look?.sides ?? 3;
  const REST = restOf(sides);
  const stack = useMemo(() => stackUnits(sides), [sides]);

  const busy = shown === "thinking" || shown === "building";
  const shifting = !still && (busy || shown === "live" || shown === "settle");

  /* Who held the floor last, so the change can be drawn once rather than
     looped: the shape is a state, not an animation. `at` only exists to give
     the <animate> a new key -- an element React leaves in place keeps playing
     the run it was given, and one that is replaced starts again. */
  const held = useRef(voice);
  const [change, setChange] = useState<{ to: "mic" | "triangle"; at: number } | null>(null);
  useEffect(() => {
    const now = voice ?? "agent";
    const was = held.current ?? "agent";
    held.current = voice;
    if (now === was) return;
    setChange({ to: now === "you" ? "mic" : "triangle", at: Date.now() });
  }, [voice]);


  return (
    <span
      className={`amark is-${shown} ${close !== null ? "is-closing" : ""} ${idle ? "is-idle" : ""} ${className}`.replace(/\s+/g, " ").trim()}
      style={{
        width: size,
        height: size,
        ...(attention ? { "--attention": attention.toFixed(2) } : {}),
        ...(own ? own.css : {}),
        /* How long this ending's way home takes: the bloom in styles.css waits
           for it, and it is as long as the mark has to travel. */
        ...(close !== null ? { "--morph-close-ms": `${close.ms}ms` } : {}),
      } as React.CSSProperties}
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

        {shown === "building" && !still && !voice ? (
          <g>
            {/* No ghost of the finished mark behind the stack: the three
                pieces landing are the whole of it, and a triangle already
                drawn behind them gives the ending away. */}

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
              {stack.map((p, i) => (
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
          <path
            className="amark-shape"
            d={voice === "you" ? MIC_PATH : REST}
            fill={`url(#g${uid})`}
          >
            {voice && !still && change !== null && (
              <animate
                key={`voice-${change.at}`}
                attributeName="d"
                values={change.to === "mic" ? MIC_OPEN : MIC_SHUT}
                dur={`${MIC_MS}ms`}
                repeatCount="1"
                fill="freeze"
                calcMode="linear"
              />
            )}
            {!voice && !still && busy && (
              <animate
                key={shown}
                attributeName="d"
                values={morphOf(sides)}
                dur={`${MORPH_MS}ms`}
                repeatCount="indefinite"
                calcMode="linear"
              />
            )}
            {!voice && !still && shown === "settle" && (
              <animate
                key={close === null ? "settle" : "settle-home"}
                attributeName="d"
                /* A settle that follows a morph is the way home and then the
                   bloom in one run; one from rest is the bloom alone. */
                {...(close === null
                  ? { values: bloomOf(sides).join(";"), dur: `${SETTLE_MS}ms`, keySplines: BLOOM_SPLINES }
                  : settleHome(close, sides))}
                repeatCount="1"
                fill="freeze"
                calcMode="spline"
              />
            )}
          </path>
        )}
      </svg>
    </span>
  );
}
