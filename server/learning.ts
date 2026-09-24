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
}

/** Worth a look even with no tools run: the person telling it how to work. */
const INSTRUCTIVE = /\b(always|never|prefer|from now on|remember|don'?t|do not|stop|instead|i like|i want you to|next time|that'?s wrong|not what i)\b/i;

export function worthReflecting(input: { request: string; ranSomething: boolean; stopped: boolean; ok: boolean }): boolean {
  if (input.stopped || !input.ok) return false;
  return input.ranSomething || INSTRUCTIVE.test(input.request);
}

export const REFLECT_SYSTEM =
  "You review an AI agent's finished turn and decide what is worth remembering for " +
  "future sessions. You are strict: most turns teach nothing new. Output only JSON.";

export function reflectionPrompt(input: {
  request: string;
  previousReply: string;
  steps: string[];
  reply: string;
  recalled: MemoryRecord[];
  nearby: MemoryRecord[];
}): string {
  const show = (m: MemoryRecord) =>
    `- ${m.id} [${m.kind}${m.status === "provisional" ? ", unconfirmed" : ""}] ${m.title}: ${m.body.slice(0, 400)}`;
  return [
    input.previousReply ? `The agent's previous reply:\n${input.previousReply.slice(0, 1500)}\n` : "",
    `The person's request:\n${input.request.slice(0, 3000)}`,
    "",
    input.steps.length ? `What the agent did, in order:\n${input.steps.join("\n")}` : "The agent ran no tools.",
    "",
    `The agent's final reply:\n${input.reply.slice(0, 3000) || "(none)"}`,
    "",
    input.recalled.length ? `Memories it was given for this turn:\n${input.recalled.map(show).join("\n")}` : "It was given no memories.",
    input.nearby.length ? `\nOther memories on the same subject:\n${input.nearby.map(show).join("\n")}` : "",
    "",
    "Answer with JSON of exactly this shape:",
    `{"learned":[{"kind":"procedure|preference|fact","title":"...","body":"...","tags":["..."],"revises":"mem-id or null"}],"helped":["mem-id"],"misled":["mem-id"]}`,
    "",
    "learned: at most 3 items, only ones that will still be useful months from now in",
    "other sessions. A procedure is how something was actually done here once it worked:",
    "the exact commands, paths, settings and the gotcha that cost time. A preference is",
    "how the person wants things done, from what they said. A fact is something true",
    "about their machine, accounts or setup that was discovered. Never record the",
    "request itself, one-off results, anything secret (passwords, tokens, keys), or",
    "anything already in the memories above unless it corrects them -- then set",
    "\"revises\" to that memory's id and write the corrected version in full.",
    "helped: ids of given memories that the agent used and that proved right.",
    "misled: ids of given memories that proved wrong or out of date.",
    "Empty arrays are the usual, correct answer.",
  ].filter((l) => l !== undefined).join("\n");
}

/** Pull the JSON out of a reply and keep only well-formed parts. */
export function parseReflection(text: string, knownIds: Set<string>): Reflection {
  const empty: Reflection = { learned: [], helped: [], misled: [] };
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
  return { learned, helped: ids(raw?.helped), misled: ids(raw?.misled) };
}
