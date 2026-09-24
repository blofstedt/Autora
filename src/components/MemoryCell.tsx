import type { MemoryTouch } from "../lib/derive";
import { BUCKETS, KIND_COLOR, type Bucket } from "../lib/memory";

const isBucket = (kind: string | null): kind is Bucket =>
  !!kind && BUCKETS.some((b) => b.kind === kind);

/**
 * The agent reaching into its memory, said where it happened.
 *
 * This replaced the always-on graph beside the chat: a map of everything the
 * agent knows, lighting up somewhere in the corner, told you less than one
 * line in the conversation saying which memories this turn actually used. It
 * sits with the reasoning of the reply it informed, or on its own line when
 * no reply has started yet. The
 * dot pulses a few times as it lands and then holds still, like the mark on
 * a finished reply. The full map is on the Mind page, one tap away.
 */
export function MemoryCell({
  cell,
  onOpen,
  inline = false,
}: {
  cell: MemoryTouch;
  onOpen?: () => void;
  /** Inside a reply, under its reasoning, rather than a line of its own. */
  inline?: boolean;
}) {
  const verb = cell.action === "written" ? "remembered" : "recalled";
  return (
    <button
      type="button"
      className={`mem-pulse is-${cell.action} ${inline ? "is-inline" : ""}`.trim()}
      onClick={onOpen}
      title="Open the Mind. Hover a memory to see why it was used."
    >
      {/* Keyed on seq so a merged recall pulses again when it grows. */}
      <span className="mem-pulse-dot" key={cell.seq} aria-hidden="true" />
      <span className="mem-pulse-verb">{verb}</span>
      {cell.items.map((item) => {
        const known = isBucket(item.kind);
        return (
          <span
            key={item.id}
            className={`mem-chip ${item.action === "forgotten" ? "is-gone" : ""}`.trim()}
            style={known ? ({ "--chip": KIND_COLOR[item.kind as Bucket] } as React.CSSProperties) : undefined}
            // Why this one: what it matched, or that it is pinned.
            title={item.reason ?? (item.action ? `${item.action}` : undefined)}
          >
            {known && <em>{item.kind}</em>}
            {item.title}
            {item.action && item.action !== "added" && <small>{item.action}</small>}
          </span>
        );
      })}
    </button>
  );
}
