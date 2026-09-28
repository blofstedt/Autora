/**
 * The browser tab as a status light.
 *
 * A harness you leave open in a background tab should be able to tell you
 * something without being looked at: the agent is working, or it is blocked on
 * you. Both the title and the favicon carry the same state, because which one a
 * given browser shows depends on how many tabs are open.
 */
import { MARK, trianglePath } from "./mark";

export type Chrome = "idle" | "working" | "live" | "approval" | "offline" | "error";

const DOT: Record<Chrome, string> = {
  idle: "#98a1b6",
  working: "#6e5bff",
  live: "#34d399",
  approval: "#fbbf24",
  offline: "#626a7e",
  error: "#f87171",
};

/**
 * The tab, carrying the mark and the state.
 *
 * The mark is the app's triangle, the same one the header, the home screen and
 * the Umbrel tile draw: at 16 pixels a triangle still reads as the brand, which
 * is the only thing a tab strip has room to say. The tile carries the state --
 * idle is the brand as it is everywhere else (dark plate, the gradient mark),
 * and a state worth noticing is a flat plate behind a white mark, which reads
 * as a colour change at any size a tab gets.
 *
 * The state used to be a pip in the corner of the tile, which at 16 pixels sat
 * on the mark's own corner and left both illegible.
 */
const svg = (color: string, brand: boolean) => {
  // The ramp runs across the mark itself, not the plate: spread over the whole
  // 32px box it gives the triangle a slice of one colour and it comes out flat.
  const w = MARK.R * Math.sqrt(3) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<defs><linearGradient id="a" gradientUnits="userSpaceOnUse" x1="${(MARK.cx - w).toFixed(2)}" y1="${(MARK.cy - MARK.R).toFixed(2)}" x2="${(MARK.cx + w).toFixed(2)}" y2="${(MARK.cy + MARK.R).toFixed(2)}">
<stop offset="0" stop-color="#6e5bff"/><stop offset="50" stop-color="#22d3ee"/><stop offset="1" stop-color="#c06bff"/>
</linearGradient></defs>
<rect width="32" height="32" rx="7.5" fill="${brand ? "#0b0a14" : color}"/>
<path d="${trianglePath()}" fill="${brand ? "url(#a)" : "#fff"}"/>
</svg>`;
};

const PREFIX: Record<Chrome, string> = {
  idle: "",
  working: "● ",
  live: "",
  approval: "⚠ ",
  offline: "",
  error: "",
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
  // Idle is the brand as it is everywhere else; a state worth noticing
  // replaces it, which is what makes it noticeable.
  link.href = `data:image/svg+xml,${encodeURIComponent(
    svg(DOT[state], state === "idle"),
  )}`;
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
