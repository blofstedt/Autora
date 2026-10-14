/**
 * Telling a colleague something, at the end of the work.
 *
 * Threads used to be a forum the agents were polled to speak in: every few
 * minutes each was asked "do you feel like saying anything?", and mostly paid
 * to answer no. What went in was invented to fill the quiet, so it echoed.
 *
 * This is the other way round. When a piece of work ends -- a to-do list is
 * finished, or the chat has gone idle after real work -- the agent that did it
 * is asked once whether anything it found would change what a particular
 * colleague does. If so it posts, naming them, and the note is also put in that
 * colleague's own mind, which is recalled for them when it is relevant (no one
 * is woken, and nothing is read unless it matters). If not, nothing happens.
 * The default answer is nothing.
 *
 * Pure parts only: the prompt, reading the answer, and the limits. The model
 * call, the timers and the posting are in server.ts (`shareCheck`).
 */

export interface ShareColleague {
  id: string;
  name: string;
  role?: string;
  /** In plain words, when to call it: what it is good for. */
  when?: string;
}

export interface Share {
  to: ShareColleague[];
  title: string;
  text: string;
}

/** The fewest tool calls since the last check for a chat to count as work worth a look. Low on purpose. */
export const SHARE_MIN_CALLS = 4;
/** How long a chat sits idle after work before the check runs. */
export const SHARE_IDLE_MS = 20 * 60_000;

export const SHARE_SYSTEM =
  "You are an agent who has just finished some work for the person. You decide whether anything you learned should be passed " +
  "to a colleague. You are strict: most work teaches no colleague anything, and saying nothing is the usual, right answer. Output only JSON.";

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

export function sharePrompt(input: {
  agent: { name: string; role?: string };
  request: string;
  steps: string[];
  reply: string;
  colleagues: ShareColleague[];
}): string {
  const people = input.colleagues
    .map((c) => `- ${c.name}${c.role ? `, ${c.role}` : ""}${c.when ? ` -- ${clip(c.when, 160)}` : ""}`)
    .join("\n");
  return [
    `You are ${input.agent.name}${input.agent.role ? `, the ${input.agent.role}` : ""}. You have finished some work.`,
    `What the person asked for:\n${clip(input.request, 600)}`,
    input.steps.length ? `What you did, in short:\n${input.steps.slice(-12).join("\n")}` : "",
    input.reply ? `What you told them:\n${clip(input.reply, 700)}` : "",
    `Your colleagues:\n${people}`,
    "Did you find out something that a particular colleague above would act differently because of? Think of: a trap you hit and how " +
      "you got round it, how something in their area really works, a fact they would otherwise get wrong, a job that is now theirs to do. " +
      "NOT: a summary of what you did, anything only about this person's own files or private matters, anything the colleague would already know, " +
      "or something that is merely interesting. No colleague in mind means no post.",
    'Reply with only JSON. Nothing to pass on: {"share":false}. Otherwise: {"share":true,"to":["Name"],"title":"...","text":"..."}. ' +
      "to is one to three names from the list. title is a few plain words. text is one to three short sentences, written to them the way " +
      "you would leave a note for a coworker: the useful thing first, no greeting, no sign-off. Never put a secret, a password, or the person's private details in it.",
  ].filter(Boolean).join("\n\n");
}

/** The answer, checked: a share only if it names at least one real colleague and says something. */
export function parseShare(raw: string, colleagues: readonly ShareColleague[]): Share | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let o: Record<string, unknown>;
  try { o = JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
  if (o.share !== true) return null;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const text = str(o.text).slice(0, 600);
  const title = str(o.title).slice(0, 90);
  if (!text || !title) return null;
  const named = Array.isArray(o.to) ? o.to : typeof o.to === "string" ? [o.to] : [];
  const to: ShareColleague[] = [];
  for (const n of named) {
    const want = str(n).toLowerCase().replace(/^@/, "");
    const hit = colleagues.find((c) => c.name.toLowerCase() === want || c.id === want);
    if (hit && !to.includes(hit)) to.push(hit);
  }
  return to.length ? { to: to.slice(0, 3), title, text } : null;
}

/** The post body: the note, with the names it is for in front so a reader sees who it is to. */
export function shareBody(share: Share): string {
  return `${share.to.map((c) => `@${c.name}`).join(" ")} ${share.text}`;
}

/** The line put in a colleague's own mind. */
export function shareNote(from: string, share: Share): string {
  return `${from} passed this on (Threads): ${share.text}`;
}

const DAY = 86_400_000;

/**
 * How often the check may run at all, whatever happens: a gap between checks, and a ceiling per day. A check is one
 * small model call, so this is also the most the whole feature can cost.
 */
export class ShareGate {
  private at: number[] = [];
  constructor(private readonly perDay = 12, private readonly gapMs = Number(process.env.AUTORA_SHARE_GAP_MS ?? 10 * 60_000)) {}
  room(now: number): boolean {
    this.at = this.at.filter((t) => now - t < DAY);
    const last = this.at[this.at.length - 1];
    return this.at.length < this.perDay && (last === undefined || now - last >= this.gapMs);
  }
  note(now: number): void { this.at.push(now); }
}

/** A to-do list with something in it and nothing left to do. */
export function listFinished(list: { items: { status: string }[] } | null): boolean {
  return Boolean(list && list.items.length > 0 && list.items.every((i) => i.status === "completed"));
}
