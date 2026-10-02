/**
 * A colleague at the next desk: saying something about what you just did.
 *
 * While the agent is working it hears what the person does and answers in its
 * own words (see presence.ts). When it is not -- the turn is over and the person
 * is working in the PDF or the app -- this is what keeps it from being a tool
 * that sits silent: a short remark about what they just did, said once they
 * pause. It is a small, unwatched model call, so it is held back hard: only for
 * what is worth a word, with a gap between remarks and a cap an hour, and the
 * model can decline (SKIP). Never while a turn is running, and never when
 * nobody is looking.
 *
 * The decisions are pure and live here; the call and the event are in server.ts.
 */

import type { Touch } from "./presence";

/** Wait this long after the last thing they did, so a remark is about what they
    did and not about the first half of it. */
export const SETTLE_MS = 2_500;
/** At least this long between two remarks. */
export const GAP_MS = 25_000;
/** And no more than this many in an hour. */
export const PER_HOUR = 12;
/** A remark is about what they did lately. */
export const WINDOW_MS = 12_000;
export const MAX_REMARK = 160;

/** Kinds of touch that are worth a word. Moving a pointer or selecting is not. */
const WORTH = new Set(["move", "edit", "add", "remove", "pages", "click", "type", "navigate", "key", "choose"]);

export function worthRemarking(touches: readonly Touch[]): boolean {
  return touches.some((t) => WORTH.has(t.kind));
}

export class RemarkGate {
  private at: number[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  /** Whether one may be made now. */
  allowed(): boolean {
    const t = this.now();
    this.at = this.at.filter((x) => t - x < 3_600_000);
    const last = this.at[this.at.length - 1];
    if (last !== undefined && t - last < GAP_MS) return false;
    return this.at.length < PER_HOUR;
  }

  /** One was made (or tried): it counts. */
  made(): void {
    this.at.push(this.now());
  }
}

export const REMARK_SYSTEM = [
  "You are Autora, working in the same window as the person -- a collaborator at the next desk, not an assistant waiting for orders.",
  "They have just done something in what you are both working on. React to it the way a colleague would, in ONE short sentence of at most 18 words:",
  "notice it, say what you will leave alone or pick up next, or make a small useful observation about it.",
  "Be warm, specific and plain. No greeting, no emoji, no list, no quotation marks, no questions unless one is truly needed, no summary of what the screen shows.",
  "Do not narrate the obvious (\"you clicked a button\"). If there is genuinely nothing worth saying, answer with exactly: SKIP",
].join("\n");

export interface RemarkContext {
  /** What the person last asked the agent to do. */
  request: string;
  /** What the agent last said it was doing. */
  lastSaid: string;
  /** What they just did, oldest first. */
  actions: string[];
}

export function remarkPrompt(c: RemarkContext): string {
  const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
  return [
    c.request ? `What they last asked you to do: ${clip(c.request, 240)}` : "",
    c.lastSaid ? `What you last said you were doing: ${clip(c.lastSaid, 240)}` : "",
    "What they just did:",
    ...c.actions.slice(-6).map((a) => `- ${clip(a, 140)}`),
    "",
    "Your one short reply, in your own words (or SKIP):",
  ].filter((l) => l !== "").join("\n");
}

/** The model's reply as one plain remark, or null when it chose to say nothing. */
export function cleanRemark(raw: string): string | null {
  let t = String(raw ?? "").trim();
  if (!t || /^skip\b/i.test(t)) return null;
  // One line: a model that wrote a paragraph is given its first sentence.
  t = t.split(/\n+/)[0].trim();
  t = t.replace(/^["'“‘`*_\s]+|["'”’`*_\s]+$/g, "").trim();
  if (!t) return null;
  const sentence = /^(.+?[.!?])(\s|$)/.exec(t);
  if (sentence && t.length > MAX_REMARK) t = sentence[1];
  if (t.length > MAX_REMARK) t = `${t.slice(0, MAX_REMARK - 1).trimEnd()}…`;
  return t;
}
