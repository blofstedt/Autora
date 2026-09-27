/**
 * When not to be proactive.
 *
 * Everything else in this console is about being useful ahead of being asked:
 * jobs that outlive the turn, schedules that look at things and say when they
 * changed, agreements that stop the same question coming twice. The failure
 * mode of all of it is the same one -- something arriving at an hour nobody
 * wanted to hear from a machine. A nightly build notice at 03:40 is not
 * helpfulness, it is a notification someone cannot switch off.
 *
 * So: a window, in the person's own clock, during which nothing unprompted is
 * said. Not a shutdown: a question they ask at 03:40 is answered at 03:40,
 * schedules they set still run (that is them asking for it), and a job
 * started by hand still starts. What waits is the agent's own initiative --
 * the briefing about a job that finished, a note it wanted to leave, starting
 * something new on its own account. Held, not dropped: the next turn after
 * the window carries it in full.
 *
 * See server.ts for where the briefing is held back, and Settings for the two
 * times.
 */
export interface Proactivity {
  /** Off means the window is ignored: nothing is ever held. */
  quiet: boolean;
  /** Minutes since midnight, the person's local clock. */
  from: number;
  to: number;
}

export const DEFAULT_PROACTIVITY: Proactivity = { quiet: false, from: 23 * 60, to: 7 * 60 };

const DAY = 24 * 60;
/** A number of minutes, or null when it is not one. */
function minute(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  const whole = Math.round(n);
  return whole >= 0 && whole < DAY ? whole : null;
}

/** "23:30" (or 1410) into minutes, or null. What an <input type="time"> sends. */
export function parseTime(value: unknown): number | null {
  if (typeof value === "string" && value.includes(":")) {
    const [h, m] = value.split(":");
    const hours = minute(Number(h));
    const mins = minute(Number(m));
    if (hours === null || hours > 59 || mins === null || mins > 59) return null;
    return hours * 60 + mins;
  }
  return minute(value);
}

/** Minutes back out as "23:30", for a time input or a sentence. */
export function clockTime(minutes: number): string {
  const m = ((Math.round(minutes) % DAY) + DAY) % DAY;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/**
 * The window itself.
 *
 * A window that ends before it starts wraps midnight, which is the normal
 * case (23:00 to 07:00). From and to equal is not a window at all: said as a
 * whole day it would be the mute button this deliberately is not, so it is
 * read as off.
 */
export function inQuiet(when: number, p: Proactivity): boolean {
  if (!p.quiet) return false;
  if (p.from === p.to) return false;
  const date = new Date(when);
  const now = date.getHours() * 60 + date.getMinutes();
  return p.from < p.to ? now >= p.from && now < p.to : now >= p.from || now < p.to;
}

export function describe(p: Proactivity): string {
  if (!p.quiet) return "off: nothing the agent starts on its own is ever held back";
  if (p.from === p.to) return "off: the two times are the same, so there is no window";
  return `${clockTime(p.from)} to ${clockTime(p.to)}`;
}

/**
 * What the agent is told.
 *
 * Said in every turn, not only inside the window: it is worth more as
 * something to plan around -- do not schedule a watcher to shout at 3am --
 * than as a rule discovered at the moment it bites.
 */
export function quietBriefing(when: number, p: Proactivity): string {
  if (!p.quiet || p.from === p.to) return "";
  const now = inQuiet(when, p);
  const window = `${clockTime(p.from)}-${clockTime(p.to)}`;
  return now
    ? [
        `Their quiet hours are ${window}, and it is ${clockTime(new Date(when).getHours() * 60 + new Date(when).getMinutes())} -- inside them now.`,
        "Answer what they ask, and do the work of the turn, but start nothing new on your own account and leave no notes for later: anything unprompted is being held until the window ends, so a summary you write now they will read in the morning.",
      ].join("\n")
    : `Their quiet hours are ${window}. Do not start anything on your own account inside them, and do not set a schedule or a watch to speak in that window unless they asked for that time.`;
}

/** Field by field, so a settings file from before this existed still loads. */
export function mergeProactivity(current: Proactivity, patch: any): Proactivity {
  if (!patch || typeof patch !== "object") return current;
  if (typeof patch.quiet === "boolean") current.quiet = patch.quiet;
  const from = parseTime(patch.from);
  if (from !== null) current.from = from;
  const to = parseTime(patch.to);
  if (to !== null) current.to = to;
  return current;
}

