/**
 * How often, in the terms a person thinks in: a date and a time, not five
 * fields in a fixed order.
 *
 * A cron expression can say far more than the four common shapes below, so
 * "custom" keeps the raw field for whatever else is wanted -- but almost every
 * schedule anyone actually sets is one of those four, and setting one should
 * not need a reference page. The cron underneath is still the source of truth:
 * this is a way of reading and writing it, not a second kind of schedule.
 *
 * Kept out of the component so the mapping can be tested on its own; a bug
 * here is a task that quietly runs on the wrong day.
 */

export type Recur =
  | { kind: "hourly"; minute: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; days: number[]; hour: number; minute: number }
  | { kind: "monthly"; day: number; hour: number; minute: number }
  | { kind: "custom" };

export const FREQS: { kind: Recur["kind"]; label: string }[] = [
  { kind: "hourly", label: "every hour" },
  { kind: "daily", label: "every day" },
  { kind: "weekly", label: "every week" },
  { kind: "monthly", label: "every month" },
  { kind: "custom", label: "custom" },
];

export const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** A weekday list as cron writes it: 1-5 rather than 1,2,3,4,5. */
const WEEKDAYS = "1-5";

export const clock = (hour: number, minute: number) =>
  `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

/** Cron read back as one of the four shapes, or custom when it is anything else. */
export function parseRecur(cron: string): Recur {
  const t = cron.trim();
  if (!t || t.startsWith("@")) return { kind: "custom" };
  const [mi, ho, dom, mon, dow] = t.split(/\s+/);
  if (mon !== "*" || dow === undefined) return { kind: "custom" };
  const minute = /^\d+$/.test(mi) ? Number(mi) : null;
  if (minute === null || minute > 59) return { kind: "custom" };
  if (ho === "*" && dom === "*" && dow === "*") return { kind: "hourly", minute };
  const hour = /^\d+$/.test(ho) ? Number(ho) : null;
  if (hour === null || hour > 23) return { kind: "custom" };
  if (dom === "*" && dow === "*") return { kind: "daily", hour, minute };
  if (dom === "*" && /^[\d,-]+$/.test(dow)) {
    const parts = dow.split(",").map((d) => (d === WEEKDAYS ? [1, 2, 3, 4, 5] : [Number(d)]));
    if (parts.every((set) => set.every((d) => Number.isInteger(d) && d >= 0 && d <= 6))) {
      return { kind: "weekly", days: parts.flat(), hour, minute };
    }
  }
  if (/^\d+$/.test(dom) && dow === "*" && Number(dom) >= 1 && Number(dom) <= 31) {
    return { kind: "monthly", day: Number(dom), hour, minute };
  }
  return { kind: "custom" };
}

/** The cron for a shape. Custom hands back whatever it already had. */
export function cronOf(r: Recur, fallback: string): string {
  switch (r.kind) {
    case "hourly":
      return `${r.minute} * * * *`;
    case "daily":
      return `${r.minute} ${r.hour} * * *`;
    case "weekly": {
      const days = [...new Set(r.days.length ? r.days : [1])].sort((a, b) => a - b);
      const field = days.join(",") === "1,2,3,4,5" ? WEEKDAYS : days.join(",");
      return `${r.minute} ${r.hour} * * ${field}`;
    }
    case "monthly":
      return `${r.minute} ${r.hour} ${r.day} * *`;
    default:
      return fallback;
  }
}
