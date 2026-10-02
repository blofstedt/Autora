import { useSyncExternalStore } from "react";

/**
 * What the person pointed at in a document's pages (components/OfficePages.tsx): a
 * piece of text on a page, or just the page. It goes with their next message to the
 * agent ("Pointing at ... on slide 2 of pitch.pptx"), which is how a phone edits.
 */
export type OfficePick = {
  session: string;
  file: string;
  kind: "docx" | "pptx" | "xlsx";
  page: number;
  /** The words tapped, or null for the page as a whole. */
  text: string | null;
  /** Where they sit on the page, in points from its top-left. */
  box: [number, number, number, number] | null;
  /** Which element (a deck's, by the id office_edit takes) or cell it is, when the document could say. */
  ref?: string | null;
  /** What to call a thing with no words of its own (a picture, a shape). */
  label?: string | null;
};

let pick: OfficePick | null = null;
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };

export function setOfficePick(next: OfficePick | null) {
  pick = next;
  emit();
}

export const getOfficePick = () => pick;
export const clearOfficePick = () => setOfficePick(null);

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export function useOfficePick(): OfficePick | null {
  return useSyncExternalStore(subscribe, () => pick, () => null);
}

const UNIT = { docx: "page", pptx: "slide", xlsx: "printed page" } as const;

/** What the chip says. */
export function pickLabel(p: OfficePick): string {
  const where = `${UNIT[p.kind]} ${p.page}`;
  if (p.text) return `“${p.text.length > 40 ? `${p.text.slice(0, 40)}…` : p.text}”`;
  return p.label ?? where;
}

/** The sentence that goes in front of the message. */
export function pickSentence(p: OfficePick): string {
  const where = `${UNIT[p.kind]} ${p.page} of ${p.file}`;
  const what = p.ref ? (p.kind === "xlsx" ? ` (cell ${p.ref})` : ` (element ${p.ref})`) : "";
  if (p.text) return `(Pointing at “${p.text.length > 200 ? `${p.text.slice(0, 200)}…` : p.text}”${what} on ${where}.)`;
  if (p.label) return `(Pointing at the ${p.label}${what} on ${where}.)`;
  return `(Pointing at ${where}.)`;
}
