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
