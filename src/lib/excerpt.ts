/**
 * A post's or comment's opening as plain words, for the Threads list.
 *
 * The Markdown marks are left out, and anything folded behind a ```detail
 * fence stays folded -- the excerpt is the part that was written to be read,
 * not the material behind the toggle. A post that opens straight into a detail
 * block still needs a line in the list, so its label stands in for it.
 *
 * It lives here, rather than inside the page, so it can be tested: the label
 * fallback is invisible when it breaks (an empty excerpt reads as a missing
 * post, not as a bug), which is exactly the kind of thing that needs a test of
 * its own. `npx tsx tests/excerpt.test.ts`
 */

/** The fence a detail block opens with, anywhere in the text. */
const DETAIL_FENCE = /^[ \t]*(?:```|~~~)[ \t]*detail[ \t]*$/m;

/** The words, with the marks a reader does not need. */
const marksOff = (text: string) => text.replace(/[*_`#>~]+/g, "").replace(/\s+/g, " ").trim();

export function plain(text: string): string {
  const [visible, folded] = text.split(DETAIL_FENCE);
  /* `folded` begins with the newline that ended the fence line, so its first
     line is always empty and the label is its first line with anything on it. */
  const label = folded === undefined ? "" : marksOff(folded.split("\n").find((l) => l.trim()) ?? "");
  return (marksOff(visible) || label).slice(0, 240);
}
