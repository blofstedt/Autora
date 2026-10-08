/**
 * Inline SVG icons.
 *
 * Kept inline rather than as an icon package: this needs about fifty glyphs,
 * and a dependency would ship several thousand. They share one grid (24px
 * viewBox, 1.75 stroke, round caps) so they sit together without looking
 * collected from different sets -- which is also the rule for adding one:
 * take the glyph from a stroke set on that same 24px grid and round-join
 * family (Lucide is the closest match; IconMask below came from it) instead
 * of inventing the geometry, so nothing lands beside the others looking odd.
 */
type Props = { className?: string; size?: number };

const base = (size: number) => ({
  width: size,
  height: size,
  // The size in Settings -> Appearance scales every icon: a CSS length beats
  // the width/height attributes, so this needs nothing at the call sites.
  style: {
    width: `calc(${size}px * var(--is, 1))`,
    height: `calc(${size}px * var(--is, 1))`,
  },
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
});

export const IconTerminal = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="m5 8 3.5 3.5L5 15" />
    <path d="M12.5 15.5H19" />
  </svg>
);

export const IconGlobe = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.5 12h17M12 3.5a15 15 0 0 1 0 17a15 15 0 0 1 0-17" />
  </svg>
);

export const IconImage = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
    <circle cx="8.75" cy="9.75" r="1.5" />
    <path d="m4 17 4.5-4.5a1.8 1.8 0 0 1 2.5 0L15 16.5m-1.5-1.5 1.75-1.75a1.8 1.8 0 0 1 2.5 0L20 15" />
  </svg>
);

export const IconFile = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M13.5 3.5H7a1.5 1.5 0 0 0-1.5 1.5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5z" />
    <path d="M13.5 3.5v5h5" />
  </svg>
);

export const IconUser = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <circle cx="12" cy="8" r="3.75" />
    <path d="M5 20a7 7 0 0 1 14 0" />
  </svg>
);

/** The brand mark, as a glyph: the same triangle the logo is, on the icon grid.
 *
 * One vertex up on a radius of 8.5 puts it at the weight of the ring and the
 * globe beside it; the round line joins round the corners for free. */
export const IconMark = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M12 3.5 19.36 16.25 4.64 16.25Z" />
  </svg>
);

export const IconCheck = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="m5 12.5 4.5 4.5L19 7" />
  </svg>
);

export const IconX = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
  </svg>
);

export const IconAlert = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M12 4.5 2.8 20h18.4z" />
    <path d="M12 10v4M12 17.2v.1" />
  </svg>
);

export const IconShield = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M12 3.2 5 6v6c0 4.3 2.9 7.4 7 8.8 4.1-1.4 7-4.5 7-8.8V6z" />
  </svg>
);

export const IconArrow = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);

export const IconStop = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <rect x="6.5" y="6.5" width="11" height="11" rx="2" />
  </svg>
);

export const IconPlay = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M8 5.5v13l11-6.5z" />
  </svg>
);

/** A film frame with a play mark: Autora Video. */
export const IconVideo = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <rect x="3.5" y="5.5" width="17" height="13" rx="2.5" />
    <path d="M10.5 9.5v5l4-2.5z" />
  </svg>
);

/** Nothing pinned, drawn rather than spelled: the fourth corner widget. */
export const IconMinus = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M6.5 12h11" />
  </svg>
);

export const IconPlus = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M12 5.5v13M5.5 12h13" />
  </svg>
);

/**
 * The incognito glyph is taken from Lucide (`hat-glasses`, ISC), not drawn here.
 * The in-house mask had a brim 18.4 wide over a body only 12 tall, so at the
 * 12-15px this is actually used at it read as a squashed bar. Lucide shares this
 * file s grid and finish (24px viewBox, round caps and joins) and tags this one
 * "incognito / private browsing", so it sits with the rest of the set.
 */
export const IconMask = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M14 18a2 2 0 0 0-4 0" />
    <path d="m19 11-2.11-6.657a2 2 0 0 0-2.752-1.148l-1.276.61A2 2 0 0 1 12 4H8.5a2 2 0 0 0-1.925 1.456L5 11" />
    <path d="M2 11h20" />
    <circle cx="17" cy="18" r="3" />
    <circle cx="7" cy="18" r="3" />
  </svg>
);

export const IconChevron = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="m9 5.5 6.5 6.5L9 18.5" />
  </svg>
);

export const IconClock = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7v5.2l3.2 2" />
  </svg>
);

export const IconMessage = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M20 4.5H4A1.5 1.5 0 0 0 2.5 6v9A1.5 1.5 0 0 0 4 16.5h2V20l4-3.5h10a1.5 1.5 0 0 0 1.5-1.5V6A1.5 1.5 0 0 0 20 4.5z" />
  </svg>
);

export const IconMonitor = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <rect x="2.5" y="3.5" width="19" height="13" rx="1.5" />
    <path d="M8.5 20.5h7M12 16.5v4" />
  </svg>
);

export const IconArrowDown = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M12 5v14" />
    <path d="m6 13 6 6 6-6" />
  </svg>
);

export const IconBrain = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <circle cx="7" cy="8" r="3" />
    <circle cx="17" cy="8" r="3" />
    <circle cx="12" cy="16.5" r="3" />
    <path d="M9.6 9.9 10.9 14M14.4 9.9 13.1 14M10 8h4" />
  </svg>
);

export const IconRepeat = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M4 9a5 5 0 0 1 5-5h9" />
    <path d="m15 1.5 3 2.5-3 2.5" />
    <path d="M20 15a5 5 0 0 1-5 5H6" />
    <path d="m9 17.5-3 2.5 3 2.5" />
  </svg>
);

/** A wrench: what the thread wears while it is doing something. The mark is
    the agent's signature, not a progress spinner, so the busy line gets a
    glyph of its own and the only mark in a conversation is the one beside the
    words. */
export const IconWrench = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M15.4 3.3a4.7 4.7 0 0 0-4.1 7.9l-.6.6-5.9 5.9a1.95 1.95 0 0 0 2.8 2.8l5.9-5.9.6-.6a4.7 4.7 0 0 0 5.9-6.7l-2.6 2.6-2.6-.6-.6-2.6z" />
  </svg>
);

export const IconGear = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M12 2.8v2.4M12 18.8v2.4M4.5 4.5l1.7 1.7M17.8 17.8l1.7 1.7M2.8 12h2.4M18.8 12h2.4M4.5 19.5l1.7-1.7M17.8 6.2l1.7-1.7" />
  </svg>
);

export const IconTrash = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M4 7h16" />
    <path d="M9 7V5h6v2" />
    <path d="M6.5 7 7.5 20h9L17.5 7" />
    <path d="M10.5 11v5M13.5 11v5" />
  </svg>
);

/** A paperclip: attach a file from this device. */
export const IconPaperclip = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M20 11.5 12.6 19a4.6 4.6 0 0 1-6.5-6.5l7.6-7.6a3.1 3.1 0 0 1 4.4 4.4l-7.6 7.6a1.6 1.6 0 0 1-2.2-2.2l6.9-6.9" />
  </svg>
);

/** A camera: take a photo here and attach it. */
export const IconCamera = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M3.5 8.5A1.5 1.5 0 0 1 5 7h2.2l1.2-2h7.2l1.2 2H19a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z" />
    <circle cx="12" cy="13" r="3.4" />
  </svg>
);

export const IconMic = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <rect x="9" y="2.75" width="6" height="11" rx="3" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0" />
    <path d="M12 17.5v3.75" />
  </svg>
);

export const IconSpeaker = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className} aria-hidden="true">
    <path d="M11 5 6 9H2v6h4l5 4V5Z" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7" />
    <path d="M19 4.9a10 10 0 0 1 0 14.2" />
  </svg>
);

/** The same speaker with its sound taken out: what the button turns into
    while it is reading, so a press that means "stop" says so. */
export const IconSpeakerOff = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className} aria-hidden="true">
    <path d="M11 5 6 9H2v6h4l5 4V5Z" />
    <path d="m16 9 6 6" />
    <path d="m22 9-6 6" />
  </svg>
);

/** Money, for the billing card: a coin rather than a dollar sign, because the
    page is also read where the bill is not in dollars. */
export const IconCoin = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <circle cx="12" cy="12" r="8.4" />
    <path d="M14.4 9.3a3 3 0 0 0-2.4-1.1c-1.4 0-2.4.8-2.4 1.9 0 2.5 4.8 1.3 4.8 3.8 0 1.1-1 1.9-2.4 1.9a3 3 0 0 1-2.4-1.1" />
    <path d="M12 6.6v1.6M12 15.8v1.6" />
  </svg>
);

export const IconKey = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="m21 2-2 2m-1.5 1.5L14 9l-1.5-1.5-3 3L8 9l-1.5 1.5" />
    <circle cx="7.5" cy="15.5" r="4.5" />
  </svg>
);

export const IconLock = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </svg>
);

export const IconEye = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

export const IconEyeOff = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
    <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
    <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
    <line x1="2" x2="22" y1="2" y2="22" />
  </svg>
);

export const IconCopy = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <rect width="13" height="13" x="8" y="8" rx="2" ry="2" />
    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
  </svg>
);

export const IconPin = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M9 4h6l-1 6 3.5 3.5V15h-11v-1.5L10 10z" />
    <path d="M12 15v5" />
  </svg>
);

export const IconSearch = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.3-4.3" />
  </svg>
);

export const IconBot = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <rect x="3" y="11" width="18" height="10" rx="2" />
    <circle cx="12" cy="5" r="2" />
    <path d="M12 7v4" />
    <line x1="8" y1="16" x2="8.01" y2="16" strokeWidth={2} />
    <line x1="16" y1="16" x2="16.01" y2="16" strokeWidth={2} />
  </svg>
);

export const IconMousePointer = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="m3 3 7.07 16.97 2.51-7.39 7.39-2.51L3 3z" />
    <path d="m13 13 6 6" />
  </svg>
);

export const IconArrowLeft = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="m12 19-7-7 7-7" />
    <path d="M19 12H5" />
  </svg>
);

export const IconTable = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 10h18M3 15h18M9 4v16" />
  </svg>
);

export const IconSlides = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M12 16v4M8 20h8M7 9h6M7 12h10" />
  </svg>
);

export const IconStar = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    {/* The star's ink spans y 3 to 19.9, so its middle is a little above the box's: shifted down to sit in the middle of a button. */}
    <path transform="translate(0 .55)" d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" />
  </svg>
);

export const IconArrowRight = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="m12 5 7 7-7 7" />
    <path d="M5 12h14" />
  </svg>
);

export const IconRotateCcw = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5" />
  </svg>
);


export const IconMaximize = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M14.5 4.5h5v5M9.5 19.5h-5v-5M19.5 4.5l-6 6M4.5 19.5l6-6" />
  </svg>
);

export const IconMinimize = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M19.5 9.5h-5v-5M4.5 14.5h5v5M14.5 9.5l6-6M9.5 14.5l-6 6" />
  </svg>
);

export const IconArrowUp = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M12 19V5M6 11l6-6 6 6" />
  </svg>
);

export const IconSliders = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M4.5 7h9M17.5 7h2M4.5 17h3M11.5 17h8" />
    <circle cx="15.5" cy="7" r="2" />
    <circle cx="9.5" cy="17" r="2" />
  </svg>
);

export const IconList = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M9 6.5h10.5M9 12h10.5M9 17.5h10.5" />
    <circle cx="5" cy="6.5" r="0.9" fill="currentColor" />
    <circle cx="5" cy="12" r="0.9" fill="currentColor" />
    <circle cx="5" cy="17.5" r="0.9" fill="currentColor" />
  </svg>
);

export const IconScroll = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <rect x="4.5" y="3.5" width="15" height="17" rx="2" />
    <path d="M8 8h8M8 12h8M8 16h5" />
  </svg>
);

export const IconChart = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M4 20h16" />
    <path d="M7 16.5v-5M12 16.5v-9M17 16.5v-3" />
  </svg>
);

export const IconZap = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M13 3.5 5.5 13.5h6l-1 7 7.5-10h-6z" />
  </svg>
);

export const IconPlug = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M9 3.5v4M15 3.5v4" />
    <path d="M6.5 7.5h11v3a5.5 5.5 0 0 1-11 0z" />
    <path d="M12 16v4.5" />
  </svg>
);

export const IconServer = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <rect x="4" y="4" width="16" height="7" rx="1.5" />
    <rect x="4" y="13" width="16" height="7" rx="1.5" />
    <path d="M7.5 7.5h.01M7.5 16.5h.01" />
  </svg>
);

export const IconPalette = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M12 3.5a8.5 8.5 0 0 0 0 17c1.2 0 1.8-.8 1.8-1.7 0-1.2-1-1.6-1-2.6 0-1 .8-1.7 1.8-1.7h2.1a3.8 3.8 0 0 0 3.8-3.8C20.5 7 16.7 3.5 12 3.5z" />
    <circle cx="7.8" cy="11" r="1" fill="currentColor" />
    <circle cx="10.5" cy="7.3" r="1" fill="currentColor" />
    <circle cx="15" cy="7.5" r="1" fill="currentColor" />
  </svg>
);

export const IconMenu = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </svg>
);

export const IconDownload = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M12 4v11M7 10.5l5 5 5-5M5 19.5h14" />
  </svg>
);

export const IconEdit = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M14.5 5.5l4 4L9 19H5v-4z" />
  </svg>
);

export const IconFolder = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M3.5 7A1.5 1.5 0 0 1 5 5.5h4l2 2.25h8A1.5 1.5 0 0 1 20.5 9.25V17A1.5 1.5 0 0 1 19 18.5H5A1.5 1.5 0 0 1 3.5 17z" />
  </svg>
);

export const IconUpload = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M12 15.5V4.5M7 9l5-5 5 5M5 19.5h14" />
  </svg>
);

export const IconNotebook = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M2 6h4M2 10h4M2 14h4M2 18h4" />
    <rect x="4" y="2" width="16" height="20" rx="2" />
    <path d="M16 2v20" />
  </svg>
);

export const IconCode = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="m16 18 6-6-6-6M8 6l-6 6 6 6" />
  </svg>
);

export const IconSparkle = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M12 3.5l1.9 5.1a2 2 0 0 0 1.2 1.2l5.1 1.9-5.1 1.9a2 2 0 0 0-1.2 1.2L12 20.5l-1.9-5.1a2 2 0 0 0-1.2-1.2L3.8 12.3l5.1-1.9a2 2 0 0 0 1.2-1.2z" />
  </svg>
);
