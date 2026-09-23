/**
 * Inline SVG icons.
 *
 * Hand-rolled rather than an icon package: this needs about fourteen glyphs,
 * and a dependency would ship several hundred. They share one grid (24px
 * viewBox, 1.75 stroke, round caps) so they sit together without looking
 * collected from different sets.
 */
type Props = { className?: string; size?: number };

const base = (size: number) => ({
  width: size,
  height: size,
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

export const IconSpark = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z" />
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

export const IconFlag = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M6 20.5V4M6 4.8h10.5l-1.8 3.6 1.8 3.6H6" />
  </svg>
);

export const IconPlus = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M12 5.5v13M5.5 12h13" />
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

export const IconPause = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M9.5 5.5v13M14.5 5.5v13" />
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

export const IconMic = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <rect x="9" y="2.75" width="6" height="11" rx="3" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0" />
    <path d="M12 17.5v3.75" />
  </svg>
);

export const IconMicOff = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M9 5.6A3 3 0 0 1 15 6v3.4M15 13.1a3 3 0 0 1-4.6.4" />
    <path d="M5.5 11a6.5 6.5 0 0 0 9.9 5.5M18.5 11v.6" />
    <path d="M12 17.5v3.75M3.5 3.5l17 17" />
  </svg>
);

/** Live voice: a waveform, since this is a conversation rather than a recording. */
export const IconWave = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M3 11v2M7.5 7.5v9M12 4.5v15M16.5 7.5v9M21 11v2" />
  </svg>
);

export const IconGrip = ({ size = 14, className }: Props) => (
  <svg {...base(size)} className={className}>
    <circle cx="8" cy="7" r="1.2" fill="currentColor" />
    <circle cx="8" cy="12" r="1.2" fill="currentColor" />
    <circle cx="8" cy="17" r="1.2" fill="currentColor" />
    <circle cx="16" cy="7" r="1.2" fill="currentColor" />
    <circle cx="16" cy="12" r="1.2" fill="currentColor" />
    <circle cx="16" cy="17" r="1.2" fill="currentColor" />
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

export const IconKeyboard = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <rect width="20" height="14" x="2" y="5" rx="2" />
    <line x1="6" y1="9" x2="6.01" y2="9" strokeWidth={2} />
    <line x1="10" y1="9" x2="10.01" y2="9" strokeWidth={2} />
    <line x1="14" y1="9" x2="14.01" y2="9" strokeWidth={2} />
    <line x1="18" y1="9" x2="18.01" y2="9" strokeWidth={2} />
    <line x1="8" y1="13" x2="16" y2="13" />
  </svg>
);

export const IconArrowLeft = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="m12 19-7-7 7-7" />
    <path d="M19 12H5" />
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

export const IconPanelRight = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
    <path d="M14 4.5v15" />
  </svg>
);
