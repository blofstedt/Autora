import { useCallback, useEffect, useRef, useState } from "react";
import type { AutoraEvent } from "./types";

/**
 * Timed replay over the event log.
 *
 * Scrubbing answers "what did step 12 look like"; playback answers "what was it
 * like to watch this". They are the same fold over the same events -- the only
 * thing this adds is a clock that advances the cursor at the pace the session
 * actually happened.
 *
 * Real gaps are clamped rather than honoured exactly: a session is mostly
 * bursts of activity separated by a 40-second `npm install`, and replaying that
 * wait verbatim is not fidelity, it is dead air.
 */
export const SPEEDS = [1, 2, 4, 8] as const;
export type Speed = (typeof SPEEDS)[number];

/** Longest pause we replay. Anything slower collapses to this. */
const MAX_GAP_MS = 1100;
/** Shortest. Streamed text deltas land microseconds apart; spread them out so
    the transcript types rather than appearing all at once. */
const MIN_GAP_MS = 14;
/** Cap on one frame's contribution, so a backgrounded tab does not bank ten
    seconds of budget and then fast-forward through half the session. */
const MAX_FRAME_MS = 100;

/** How long to wait before showing `events[index]`, in milliseconds. */
export function gapBefore(events: AutoraEvent[], index: number): number {
  if (index <= 0 || index >= events.length) return MIN_GAP_MS;
  // `ts` is wall-clock seconds and may go backwards across machines, so a
  // negative delta is not an error -- it just means "no wait".
  const delta = (events[index].ts - events[index - 1].ts) * 1000;
  if (!Number.isFinite(delta)) return MIN_GAP_MS;
  return Math.min(Math.max(delta, MIN_GAP_MS), MAX_GAP_MS);
}

export type Playback = {
  playing: boolean;
  speed: Speed;
  toggle: () => void;
  pause: () => void;
  cycleSpeed: () => void;
};

export function usePlayback(
  events: AutoraEvent[],
  cursor: number,
  seek: (index: number) => void,
  onReachEnd?: () => void,
): Playback {
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<Speed>(1);

  // The rAF loop reads these through refs so it is started once per play, not
  // torn down and rebuilt on every cursor change.
  const eventsRef = useRef(events);
  const cursorRef = useRef(cursor);
  const speedRef = useRef(speed);
  const endRef = useRef(onReachEnd);
  const seekRef = useRef(seek);
  eventsRef.current = events;
  cursorRef.current = cursor;
  speedRef.current = speed;
  endRef.current = onReachEnd;
  seekRef.current = seek;

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    let budget = 0;

    const tick = (now: number) => {
      budget += Math.min(now - last, MAX_FRAME_MS) * speedRef.current;
      last = now;

      const all = eventsRef.current;
      let next = cursorRef.current;
      // Spend the accumulated budget on as many events as it covers. A burst of
      // near-simultaneous events therefore lands in one frame, which is exactly
      // how it looked live.
      while (next < all.length - 1 && budget >= gapBefore(all, next + 1)) {
        budget -= gapBefore(all, next + 1);
        next += 1;
      }

      if (next !== cursorRef.current) {
        cursorRef.current = next;
        seekRef.current(next);
      }

      if (next >= all.length - 1) {
        // Caught up with the head. On a recording that is the end; on a live
        // session it means playback has become following, which is better
        // expressed by handing control back than by spinning on the last event.
        setPlaying(false);
        endRef.current?.();
        return;
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const toggle = useCallback(() => {
    setPlaying((on) => {
      if (on) return false;
      // Pressing play at the end replays from the top rather than doing nothing.
      if (cursorRef.current >= eventsRef.current.length - 1) seekRef.current(-1);
      return eventsRef.current.length > 0;
    });
  }, []);

  const pause = useCallback(() => setPlaying(false), []);
  const cycleSpeed = useCallback(
    () => setSpeed((s) => SPEEDS[(SPEEDS.indexOf(s) + 1) % SPEEDS.length]),
    [],
  );

  return { playing, speed, toggle, pause, cycleSpeed };
}
