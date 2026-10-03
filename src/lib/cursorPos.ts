/**
 * Where the agent's cursor is on screen right now, when the tool showing it can
 * say (the PDF's cues and the office apps' cursor report here), so the line it
 * is saying can sit beside it (components/ImmersiveChat.tsx). Viewport pixels.
 * A position older than a few seconds is no position: the cursor has gone.
 */
let at: { x: number; y: number; t: number } | null = null;

export function reportCursor(x: number, y: number) {
  at = { x, y, t: performance.now() };
}

export function clearCursor() {
  at = null;
}

/** The cursor, if it was seen moving in the last `ms`. */
export function recentCursor(ms = 3000): { x: number; y: number } | null {
  return at && performance.now() - at.t < ms ? { x: at.x, y: at.y } : null;
}
