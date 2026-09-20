import { useMemo, useRef, useState } from "react";
import type { AutoraEvent } from "../lib/types";
import { elapsed, labelFor, summarize } from "../lib/describe";
import { markersFor, positionOf } from "../lib/markers";
import type { Playback } from "../lib/playback";
import { IconPause, IconPlay } from "./Icons";

/**
 * The transport: play, speed, and a track that shows what it is scrubbing.
 *
 * This is the control the README promises -- "a scrub bar over the session, not
 * a log viewer" -- so it behaves like a video transport rather than a slider
 * that happens to change a number.
 */
export function Scrubber({
  events, cursor, playback, following, atHead, onSeek, onToggleFollow,
}: {
  events: AutoraEvent[];
  cursor: number;
  playback: Playback;
  following: boolean;
  atHead: boolean;
  onSeek: (index: number) => void;
  onToggleFollow: () => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [peek, setPeek] = useState<{ at: number; index: number } | null>(null);

  const markers = useMemo(() => markersFor(events), [events]);
  const progress = positionOf(cursor, events.length);
  const start = events[0]?.ts ?? 0;

  const peekEvent = peek ? events[peek.index] : null;

  const trackPoint = (clientX: number) => {
    const box = trackRef.current?.getBoundingClientRect();
    if (!box || box.width === 0 || events.length === 0) return null;
    const ratio = Math.min(Math.max((clientX - box.left) / box.width, 0), 1);
    const index = Math.min(
      Math.max(Math.round(ratio * events.length) - 1, 0),
      events.length - 1,
    );
    return { at: ratio * 100, index };
  };

  return (
    <div className="scrub">
      <button
        className="btn icon ghost transport"
        onClick={playback.toggle}
        disabled={events.length === 0}
        title={playback.playing ? "Pause (space)" : "Play (space)"}
        aria-label={playback.playing ? "Pause replay" : "Play replay"}
      >
        {playback.playing ? <IconPause size={14} /> : <IconPlay size={14} />}
      </button>

      <button
        className={`btn ghost speed ${playback.speed > 1 ? "on" : ""}`}
        onClick={playback.cycleSpeed}
        title="Playback speed"
        aria-label={`Playback speed ${playback.speed} times`}
      >
        {playback.speed}×
      </button>

      <div
        className="track"
        ref={trackRef}
        onMouseMove={(e) => setPeek(trackPoint(e.clientX))}
        onMouseLeave={() => setPeek(null)}
      >
        <span className="fill" style={{ width: `${progress}%` }} />

        {/* Notable moments. `aria-hidden` because the timeline rail already
            exposes every one of these as a real, focusable control. */}
        <span className="ticks" aria-hidden="true">
          {markers.map((m) => (
            <i
              key={m.index}
              className={`tick tone-${m.tone}`}
              style={{ left: `${m.at}%` }}
            />
          ))}
        </span>

        {peekEvent && (
          <>
            <span className="peek-line" style={{ left: `${peek!.at}%` }} aria-hidden="true" />
            <span
              className="peek"
              // Clamped so the card never hangs off either end of the track.
              style={{ left: `${Math.min(Math.max(peek!.at, 8), 92)}%` }}
            >
              <b>{labelFor(peekEvent)}</b>
              <span className="peek-text">{summarize(peekEvent) || "—"}</span>
              <span className="peek-at">+{elapsed(peekEvent.ts, start)}</span>
            </span>
          </>
        )}

        <input
          type="range"
          min={-1}
          max={Math.max(events.length - 1, 0)}
          value={cursor}
          aria-label="Session position"
          aria-valuetext={
            events.length > 0
              ? `Event ${cursor + 1} of ${events.length}`
              : "No events yet"
          }
          onChange={(e) => onSeek(Number(e.target.value))}
        />
      </div>

      <span className="counter">
        {cursor + 1} / {events.length}
      </span>

      {/* One control, two states. It used to be a label when following and a
          different button when not, so the thing you wanted to press was never
          in the same place twice. */}
      <button
        className={`follow ${following && atHead ? "on" : ""}`}
        onClick={onToggleFollow}
        aria-pressed={following && atHead}
        title={following && atHead ? "Stop following the live edge" : "Follow the live edge"}
      >
        <span className="dot" />
        {following && atHead ? "following" : "follow"}
      </button>
    </div>
  );
}
