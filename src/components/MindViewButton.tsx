/**
 * The Mind's one switch between its two views: a small round icon that sits on the thing it changes
 * (the corner of the map, the toolbar of the buckets) instead of a row of its own. Its picture shows
 * where it goes: a few joined dots to open the map, a grid of tiles to go back to the buckets. It
 * pops in when it appears, and its lines draw themselves again when the pointer reaches it.
 */
export function MindViewButton({ to, onClick }: { to: "map" | "buckets"; onClick: () => void }) {
  const label = to === "map" ? "Show the map" : "Show the buckets";
  return (
    <button
      type="button"
      className={`mind-viewbtn is-${to}`}
      aria-label={label}
      title={label}
      onClick={onClick}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {to === "map" ? (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
          <path className="mvb-line" d="M6 7.5 12 16.5M6 7.5 17.5 6.5M12 16.5 17.5 6.5" />
          <circle className="mvb-dot" cx="6" cy="7.5" r="2.2" fill="currentColor" stroke="none" />
          <circle className="mvb-dot" cx="17.5" cy="6.5" r="2.2" fill="currentColor" stroke="none" />
          <circle className="mvb-dot" cx="12" cy="16.5" r="2.2" fill="currentColor" stroke="none" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
          <rect className="mvb-tile" x="4" y="4" width="7" height="7" rx="2" />
          <rect className="mvb-tile" x="13" y="4" width="7" height="7" rx="2" />
          <rect className="mvb-tile" x="4" y="13" width="7" height="7" rx="2" />
          <rect className="mvb-tile" x="13" y="13" width="7" height="7" rx="2" />
        </svg>
      )}
    </button>
  );
}
