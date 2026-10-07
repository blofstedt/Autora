import { memo } from "react";

/**
 * One white mark per API vendor, for the spend bars.
 *
 * Drawn here as plain monochrome glyphs on a 24px grid, in `currentColor`, so
 * they take the bar's text colour and stay white on the dark theme without a
 * single image request. They are simplified renditions of each vendor's mark,
 * not the official artwork. A vendor without one gets a neutral coin, so a new
 * provider never leaves a hole in the row.
 */
const MARKS: Record<string, JSX.Element> = {
  /* A knot of three rounded squares, turned a third of a turn apart. */
  openai: (
    <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
      <rect x="6.2" y="6.2" width="11.6" height="11.6" rx="3.4" />
      <rect x="6.2" y="6.2" width="11.6" height="11.6" rx="3.4" transform="rotate(60 12 12)" />
      <rect x="6.2" y="6.2" width="11.6" height="11.6" rx="3.4" transform="rotate(120 12 12)" />
    </g>
  ),
  /* The four-point spark. */
  gemini: (
    <path
      fill="currentColor"
      d="M12 2.5c.4 5.2 4.3 9.1 9.5 9.5-5.2.4-9.1 4.3-9.5 9.5-.4-5.2-4.3-9.1-9.5-9.5 5.2-.4 9.1-4.3 9.5-9.5z"
    />
  ),
  /* A capital A, cut square. */
  anthropic: (
    <path
      fill="currentColor"
      d="M13.6 4.5h-3.2L4 19.5h3.3l1.2-3h7l1.2 3H20zM9.6 13.6 12 7.4l2.4 6.2z"
    />
  ),
  /* A whale, in profile, eye and blowhole. */
  deepseek: (
    <g>
      <path
        fill="currentColor"
        d="M2.5 12.6c0-3.6 3.3-6.3 7.4-6.3 2.6 0 4.6 1 5.9 2.6l4.7-2.6-1.2 4.9c.1.5.2 1 .2 1.4 0 3.2-3.6 5.9-8.3 5.9-4.7 0-8.7-2.2-8.7-5.9z"
      />
      <circle cx="8" cy="11.2" r="1.15" fill="#000" fillOpacity=".72" />
    </g>
  ),
  /* Two lines crossing and splitting: a router. */
  openrouter: (
    <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12h4.5c3 0 3-6 6-6H20M3 12h4.5c3 0 3 6 6 6H20" />
      <path d="m17.5 3.5 2.5 2.5-2.5 2.5M17.5 15.5 20 18l-2.5 2.5" />
    </g>
  ),
  /* An orca's dorsal fin rising from a wave. */
  orcarouter: (
    <g>
      <path fill="currentColor" d="M9 17.5c.4-4.7 2.6-9.1 6.4-12-.5 3.4.2 6.8 2.1 9.5-1.7.6-3.4 1.4-4.9 2.5z" />
      <path fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" d="M3 19.5c2 0 2-1 4-1s2 1 4 1 2-1 4-1 2 1 4 1 2-1 2-1" />
    </g>
  ),
  /* A machine of your own. */
  local: (
    <g fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3.5" y="4.5" width="17" height="6" rx="1.8" />
      <rect x="3.5" y="13.5" width="17" height="6" rx="1.8" />
      <path d="M7 7.5h.01M7 16.5h.01" />
    </g>
  ),
};

export const VendorLogo = memo(function VendorLogo({
  provider,
  size = 14,
  className,
}: {
  provider: string;
  size?: number;
  className?: string;
}) {
  const mark = MARKS[provider];
  return (
    <svg
      className={`vendor-logo ${className ?? ""}`.trim()}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      {mark ?? <circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" strokeWidth="1.8" />}
    </svg>
  );
});
