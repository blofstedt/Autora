import type { AutoraEvent } from "./types";
import { labelFor, summarize, toneOf, type Tone } from "./describe";

/**
 * Notable moments, positioned along the scrub track.
 *
 * A flat progress bar tells you where you are but nothing about what you are
 * scrubbing through. Painting the errors, approvals, edits and prompts onto it
 * turns the bar into a contour of the session: three red marks bunched near the
 * end is a story the bar could not otherwise tell.
 */
export type Marker = {
  index: number;
  /** Percent along the track, matching the fill's own arithmetic. */
  at: number;
  tone: Exclude<Tone, "">;
  label: string;
  text: string;
};

/** When two marks land closer than this (in percent), the louder one wins --
    otherwise a session with 200 edits renders a solid green smear. */
const MIN_SPACING = 0.45;

const PRIORITY: Record<Exclude<Tone, "">, number> = { bad: 3, warn: 2, you: 1, good: 0 };

export function positionOf(index: number, total: number): number {
  if (total <= 0) return 0;
  return ((index + 1) / total) * 100;
}

export function markersFor(events: AutoraEvent[]): Marker[] {
  const out: Marker[] = [];
  for (let i = 0; i < events.length; i++) {
    const tone = toneOf(events[i]);
    if (tone === "") continue;
    const at = positionOf(i, events.length);
    const last = out[out.length - 1];
    if (last && at - last.at < MIN_SPACING) {
      // Collapse into the neighbour, keeping whichever is more worth seeing.
      if (PRIORITY[tone] > PRIORITY[last.tone]) {
        out[out.length - 1] = mark(events[i], i, at, tone);
      }
      continue;
    }
    out.push(mark(events[i], i, at, tone));
  }
  return out;
}

const mark = (e: AutoraEvent, index: number, at: number, tone: Exclude<Tone, "">): Marker => ({
  index, at, tone, label: labelFor(e), text: summarize(e),
});
