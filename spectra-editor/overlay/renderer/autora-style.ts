// Autora (phone): the colour and thickness the phone's option tray sets for the next mark.
//
// Spectra keeps its colour for new annotations in React state inside the canvas view and has no setting for how thick a
// new pen stroke or shape outline is. The phone's tray (src/autora/phone.tsx) is a separate React root, so what it picks
// is held here, in a module the canvas view and the page cells read. Nothing in it is set unless the tray sets it, so
// on a desktop every read answers "no preference" and Spectra behaves exactly as before.

export type WidthMode = 'ink' | 'shape' | 'inkhighlight';

const widths: Partial<Record<WidthMode, number>> = {};
let color: string | null | undefined;
const listeners = new Set<() => void>();

const emit = (): void => listeners.forEach((fn) => fn());

/** The colour the tray chose for new marks: a hex string, null for "each tool's own", undefined when never set. */
export function getAutoraColor(): string | null | undefined {
  return color;
}

export function setAutoraColor(next: string | null): void {
  if (color === next) return;
  color = next;
  emit();
}

/** Thickness in PDF points the tray chose for a mark kind, or undefined for Spectra's own. */
export function getAutoraWidth(mode: WidthMode): number | undefined {
  return widths[mode];
}

export function setAutoraWidth(mode: WidthMode, points: number): void {
  widths[mode] = points;
  emit();
}

export function subscribeAutoraStyle(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Whether this window has Autora's interface (`html.autora-rail-ui`, set by src/autora/rail.tsx before the first paint): the phone's and the desktop's both. */
export function isAutoraUi(): boolean {
  return document.documentElement.classList.contains('autora-rail-ui');
}

export type Detect = 'word' | 'line';
let detect: Detect = 'word';

/** What a tap with the Redact tool takes: the word under the finger, or the whole line it is on. */
export function getAutoraDetect(): Detect {
  return detect;
}

export function setAutoraDetect(next: Detect): void {
  detect = next;
  emit();
}
