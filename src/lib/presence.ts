/**
 * Small moments of the agent's presence that cross the page: a spark that
 * travels from one place to another (your message handed to it; something it
 * learned going into its Mind).
 *
 * Kept outside React because it is a one-off flourish on fixed positions,
 * not state: an element is made, flown with the Web Animations API, and
 * removed. It never runs for someone who asked for less motion, or in a tab
 * nobody is looking at, and whatever it announces has already happened by
 * the time it lands -- the spark is decoration on a real event, never the
 * event itself.
 */

export function motionAllowed(): boolean {
  if (typeof window === "undefined" || document.hidden) return false;
  return !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/** Where on screen an element is, if it is actually showing. */
function centre(el: Element | null): { x: number; y: number } | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** The first of these elements that is on screen. */
export function visible(...selectors: string[]): Element | null {
  for (const sel of selectors) {
    for (const el of Array.from(document.querySelectorAll(sel)).reverse()) {
      if (centre(el)) return el;
    }
  }
  return null;
}

/**
 * Fly a spark from one element to another along a gentle arc, then call
 * `onLand`. Calls it straight away (with no spark) when motion is off or
 * either end is not on screen, so callers never wait on decoration.
 */
export function flySpark(
  from: Element | null,
  to: Element | null,
  onLand?: () => void,
  tone: "accent" | "glow" = "accent",
): void {
  const a = centre(from);
  const b = centre(to);
  if (!a || !b || !motionAllowed() || typeof document.body.animate !== "function") {
    onLand?.();
    return;
  }
  const spark = document.createElement("span");
  spark.className = `fly-spark is-${tone}`;
  spark.setAttribute("aria-hidden", "true");
  document.body.appendChild(spark);

  // A quadratic arc: the midpoint lifted by a fraction of the distance, so a
  // long trip curves more than a short one.
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lift = Math.min(160, Math.hypot(dx, dy) * 0.28);
  const frames: Keyframe[] = [];
  for (let i = 0; i <= 12; i += 1) {
    const t = i / 12;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2 - lift;
    const x = (1 - t) ** 2 * a.x + 2 * (1 - t) * t * mx + t ** 2 * b.x;
    const y = (1 - t) ** 2 * a.y + 2 * (1 - t) * t * my + t ** 2 * b.y;
    const scale = t < 0.15 ? 0.4 + t * 4 : t > 0.85 ? 1 - (t - 0.85) * 4 : 1;
    frames.push({
      transform: `translate(${x - 5}px, ${y - 5}px) scale(${scale.toFixed(2)})`,
      opacity: t > 0.92 ? 0.4 : 1,
    });
  }
  const run = spark.animate(frames, { duration: 720, easing: "cubic-bezier(0.4, 0, 0.2, 1)" });
  const done = () => { spark.remove(); onLand?.(); };
  run.onfinish = done;
  run.oncancel = done;
}
