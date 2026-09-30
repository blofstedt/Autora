/**
 * Learning from a turn once it is over.
 *
 * The agent could always write things down with memory_write, but only if it
 * thought to in the middle of doing something else -- so mostly it did not,
 * and the fix it found on Tuesday was worked out again from scratch on
 * Friday. After a turn that did real work (or where the person said how they
 * like things done), a short background call looks back at it and answers
 * three questions: what is worth keeping, which recalled memories helped, and
 * which were wrong.
 *
 * What it keeps is `provisional`: shown in the thread with Keep and Discard,
 * recalled as "unconfirmed", and confirmed by the person or by working again
 * (see MemoryGraph.reinforce). A guess never silently becomes a fact.
 */

import type { MemoryRecord } from "./memory";

export interface Lesson {
  kind: "fact" | "preference" | "procedure";
  title: string;
  body: string;
  tags: string[];
  /** The memory this corrects or extends, when it does. */
  revises: string | null;
}

export interface Reflection {
  learned: Lesson[];
  helped: string[];
  misled: string[];
  /** What the person will most likely want next: offered as one-tap chips
      under the reply (see server/suggest.ts). */
  next: { label: string; prompt: string }[];
}

/** Worth a look even with no tools run: the person telling it how to work. */
const INSTRUCTIVE = /\b(always|never|prefer|from now on|remember|don'?t|do not|stop|instead|i like|i want you to|next time|that'?s wrong|not what i)\b/i;

/* ...or telling it about themselves and what they work on. "I hold 40 shares
   of ASML", "my server is the one in the attic", "we use Fastmail" were said
   once, ran no tool, and were gone by the next session -- so the person was
   asked the same things again, and every answer began from nothing. */
const TELLING = new RegExp(
  "\\b(i am an?|i'?m an?|i work|i own|i hold|i have an?|i use|we use|i run|i live|call me|" +
    "my (name|job|work|company|team|business|wife|husband|partner|son|daughter|kids?|family|" +
    "portfolio|holdings|watchlist|broker|account|bank|server|setup|home|house|car|project|" +
    "website|site|domain|email|budget|goal|plan|stack))\\b",
  "i",
);

export function worthReflecting(input: { request: string; ranSomething: boolean; stopped: boolean; ok: boolean }): boolean {
  // A turn the person stopped is not evidence of anything.
  if (input.stopped) return false;
  // A turn that ran tools and then went wrong is the one most worth looking
  // back at: the command that failed, the page that would not load. A turn
  // that never reached a tool is the provider having a bad day, not a lesson.
  if (!input.ok && !input.ranSomething) return false;
  return input.ranSomething || INSTRUCTIVE.test(input.request) || TELLING.test(input.request);
}

export const REFLECT_SYSTEM =
  "You review an AI agent's finished turn and decide what is worth remembering for " +
  "future sessions. You are strict: most turns teach nothing new. Output only JSON.";

export function reflectionPrompt(input: {
  request: string;
  previousReply: string;
  steps: string[];
  /** How each tool has been behaving lately, from server/toolhealth.ts. */
  trouble?: string;
  reply: string;
  recalled: MemoryRecord[];
  nearby: MemoryRecord[];
}): string {
  const show = (m: MemoryRecord) =>
    `- ${m.id} [${m.kind}${m.status === "provisional" ? ", unconfirmed" : ""}` +
    `${m.doubted ? ", found wrong before" : ""}] ${m.title}: ${m.body.slice(0, 400)}`;
  return [
    input.previousReply ? `The agent's previous reply:\n${input.previousReply.slice(0, 1500)}\n` : "",
    `The person's request:\n${input.request.slice(0, 3000)}`,
    "",
    input.steps.length ? `What the agent did, in order:\n${input.steps.join("\n")}` : "The agent ran no tools.",
    input.trouble
      ? `\nHow these tools have been behaving lately. A command or a site that keeps\nfailing is worth a lesson: the procedure that avoids it, not a note that it hurt.` +
        `\n${input.trouble}`
      : "",
    "",
    `The agent's final reply:\n${input.reply.slice(0, 3000) || "(none)"}`,
    "",
    input.recalled.length ? `Memories it was given for this turn:\n${input.recalled.map(show).join("\n")}` : "It was given no memories.",
    input.nearby.length ? `\nOther memories on the same subject:\n${input.nearby.map(show).join("\n")}` : "",
    "",
    "Answer with JSON of exactly this shape:",
    `{"learned":[{"kind":"procedure|preference|fact","title":"...","body":"...","tags":["..."],"revises":"mem-id or null"}],"helped":["mem-id"],"misled":["mem-id"],"next":[{"label":"...","prompt":"..."}]}`,
    "",
    "learned: at most 3 items, only ones that will still be useful months from now in",
    "other sessions. A procedure is how something was actually done here once it worked:",
    "the exact commands, paths, URLs, settings and the gotcha that cost time. When a step",
    "failed and a later one worked, that is the lesson: write the way that worked, and",
    "name the mistake to skip (\"not X: it fails with Y\"), so next time starts from the",
    "working way. A source that answered well -- the site, API or command that had the",
    "data, and how to ask it -- is a procedure too. A preference is how the person wants",
    "things done, from what they said. A fact is something durable that was said or",
    "discovered about the person, their work and interests, the people, projects and",
    "things they deal with, or their machine, accounts and setup. Never record the request",
    "itself, one-off results or figures that change by the day (a price, a count, today's",
    "status), anything secret (passwords, tokens, keys, account numbers), or anything",
    "already in the memories above unless it corrects them -- then set \"revises\" to that",
    "memory's id and write the corrected version in full.",
    "tags: the subject it belongs to (e.g. \"stocks\", \"docker\", \"email\", \"travel\"), the",
    "site's host name if a site was involved, and the names of things it is about -- these",
    "are the words it will be found by when the subject comes up again.",
    "helped: ids of given memories that the agent used and that proved right.",
    "misled: ids of given memories that proved wrong or out of date.",
    "next: at most 2 things the person would most likely ask for next, specific to this",
    "turn -- a closer look, the obvious follow-on, the other half of what they asked. The",
    "prompt is written as their request; the label is at most five words. Never something",
    "outward-facing (sending, posting, buying, deleting) and never what was just done.",
    "Empty arrays are the usual, correct answer for learned, helped and misled.",
  ].filter((l) => l !== undefined).join("\n");
}

/** Pull the JSON out of a reply and keep only well-formed parts. */
export function parseReflection(text: string, knownIds: Set<string>): Reflection {
  const empty: Reflection = { learned: [], helped: [], misled: [], next: [] };
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return empty;
  let raw: any;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return empty;
  }
  const ids = (v: unknown) =>
    Array.isArray(v) ? [...new Set(v.map(String).filter((id) => knownIds.has(id)))] : [];
  const learned: Lesson[] = [];
  for (const item of Array.isArray(raw?.learned) ? raw.learned.slice(0, 3) : []) {
    const kind = ["fact", "preference", "procedure"].includes(item?.kind) ? item.kind : null;
    const title = String(item?.title ?? "").trim();
    const body = String(item?.body ?? "").trim();
    if (!kind || !title || body.length < 12) continue;
    // A secret has no business in memory, however it got into the reply.
    if (/(password|passwd|api[_ -]?key|secret|token)\s*[:=]\s*\S{6,}/i.test(body)) continue;
    learned.push({
      kind,
      title: title.slice(0, 120),
      body: body.slice(0, 2000),
      tags: Array.isArray(item?.tags) ? item.tags.map(String).slice(0, 6) : [],
      revises: typeof item?.revises === "string" && knownIds.has(item.revises) ? item.revises : null,
    });
  }
  const next: Reflection["next"] = [];
  for (const item of Array.isArray(raw?.next) ? raw.next.slice(0, 2) : []) {
    const label = String(item?.label ?? "").replace(/\s+/g, " ").trim();
    const prompt = String(item?.prompt ?? "").trim();
    // A chip is a few words; a label that is a paragraph is not one.
    if (!label || !prompt || label.split(" ").length > 7) continue;
    // Nothing that speaks for the person or cannot be undone, whatever the model said.
    if (/\b(send|post|publish|buy|purchase|pay|delete|remove|tweet|reply to|email (him|her|them))\b/i.test(`${label} ${prompt}`)) continue;
    next.push({ label: label.slice(0, 60), prompt: prompt.slice(0, 600) });
  }
  return { learned, helped: ids(raw?.helped), misled: ids(raw?.misled), next };
}
