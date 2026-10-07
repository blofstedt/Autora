/**
 * Handing a person's keys and taps to a page shown as video: the agent's
 * browser card (ScreencastCell) and the app window (AppPreview) both do it,
 * and both have to get the same phone keyboards right.
 */

/** Kept in a keyboard sink so a phone's backspace has something to delete:
    Android reports soft-keyboard keys as "Unidentified", and the only reliable
    sign of a backspace is the field getting shorter. */
export const SENTINEL = "\u200b";

/** Keys that are keys rather than text, forwarded by name. */
export const NAMED_KEYS = new Set([
  "Enter", "Tab", "Backspace", "Delete", "Escape", "ArrowUp", "ArrowDown",
  "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown",
]);

type FieldBox = readonly [number, number, number, number];

/** Whether a point on a page lands in one of its fields, with a little slack
    for a fingertip. */
export function inField(fields: readonly FieldBox[], x: number, y: number, slack = 6): boolean {
  return fields.some(([fx, fy, fw, fh]) =>
    x >= fx - slack && x <= fx + fw + slack && y >= fy - slack && y <= fy + fh + slack);
}
