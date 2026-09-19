/**
 * The browser tab as a status light.
 *
 * A harness you leave open in a background tab should be able to tell you
 * something without being looked at: the agent is working, or it is blocked on
 * you. Both the title and the favicon carry the same state, because which one a
 * given browser shows depends on how many tabs are open.
 */
export type Chrome = "idle" | "working" | "live" | "approval" | "offline";

const DOT: Record<Chrome, string> = {
  idle: "#98a1b6",
  working: "#6e5bff",
  live: "#34d399",
  approval: "#fbbf24",
  offline: "#626a7e",
};

/** The brand mark from the header, with a status pip in the middle. */
const svg = (color: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<defs><linearGradient id="a" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="#6e5bff"/><stop offset="1" stop-color="#22d3ee"/>
</linearGradient></defs>
<rect x="2" y="2" width="28" height="28" rx="9.5" fill="url(#a)"/>
<circle cx="16" cy="16" r="6.5" fill="#08090d"/>
<circle cx="16" cy="16" r="3.4" fill="${color}"/>
</svg>`;

const PREFIX: Record<Chrome, string> = {
  idle: "",
  working: "● ",
  live: "",
  approval: "⚠ ",
  offline: "",
};

let applied: string | null = null;

export function paintChrome(state: Chrome, label: string) {
  const title = `${PREFIX[state]}${label ? `${label} — ` : ""}Autora`;
  if (document.title !== title) document.title = title;

  // Rewriting the href on every frame would have the browser re-decode the
  // same image, so only touch it when the state actually changes.
  if (applied === state) return;
  applied = state;
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  link.type = "image/svg+xml";
  link.href = `data:image/svg+xml,${encodeURIComponent(svg(DOT[state]))}`;
}

/**
 * A short chime, for an approval that lands while the tab is in the background.
 *
 * Synthesised rather than shipped as an asset: the UI has no runtime
 * dependencies and no network calls, and that should stay true of the one sound
 * it makes. Silently does nothing where autoplay policy forbids it.
 */
export function chime() {
  try {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.055, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);
    gain.connect(ctx.destination);
    for (const [freq, at] of [[784, 0], [1046.5, 0.09]] as const) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, now + at);
      osc.connect(gain);
      osc.start(now + at);
      osc.stop(now + 0.55);
    }
    window.setTimeout(() => void ctx.close(), 900);
  } catch {
    /* no audio device, or autoplay blocked -- the title and favicon still carry it */
  }
}
