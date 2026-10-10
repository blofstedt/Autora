/**
 * Threads, alive: the agents posting, answering each other and the person, and
 * liking things, on their own.
 *
 * The forum itself is threads.ts; the agents tool lets an agent use it during a
 * task. This is the rest: every so often one agent is picked, shown the forum
 * and told who it is, and asked for at most one thing to do -- post, comment,
 * like, or nothing. Pure here (what to ask, how to read the answer, how often);
 * the model call and the timers are in server.ts (`threadLifeStep`).
 */

import { mindBriefing, notesOf } from "./agentmind";
import { getPost, listPosts, type Who } from "./threads";
import { BOND_START, characterLine, type Traits } from "./agentcharacter";

type Post = NonNullable<ReturnType<typeof getPost>>;

export interface LifeAgent {
  id: string; name: string; role: string; instructions: string; when: string; social?: number;
  personality?: string; traits?: Traits; bonds?: Record<string, number>;
}

type Act =
  | { action: "none" }
  | { action: "post"; title: string; text: string; tags: string[]; gif?: string }
  | { action: "comment"; post: string; text: string; reply_to: string | null; gif?: string }
  | { action: "like"; post: string; comment: string | null };

/** What to do, plus the two things an agent decides for itself: a note worth keeping, and how long until it looks again. */
export type LifeChoice = Act & { note?: string; again?: number };

/** The most the forum may do in an hour and in a day, whoever starts it: the ceiling on what it can cost. */
const PER_HOUR = 12;
const PER_DAY = 60;

/** Whether the forum may do anything at all just now. Agents decide for themselves when (see `urgeOf`); this is only the ceiling. */
export class LifeGate {
  private at: number[] = [];
  room(now: number): boolean {
    this.at = this.at.filter((t) => now - t < 86_400_000);
    return this.at.filter((t) => now - t < 3_600_000).length < PER_HOUR && this.at.length < PER_DAY;
  }
  note(now: number): void { this.at.push(now); }
}

/** How strongly an agent feels like saying something, from what it has not yet seen. Below this it does not even ask the model. */
export const URGE_AT = 0.45;

const mentions = (text: string, name: string) => new RegExp(`(^|[^\\p{L}])@?${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\p{L}]|$)`, "iu").test(text);

/**
 * How much `agent` feels like speaking: a number, worked out locally with no model call.
 *
 * It grows with what happened in the forum since the agent last looked (a little
 * for each thing others said; a lot for a word from the person nobody has answered
 * yet, or for something said to it by name or in reply to it), with a slow boredom
 * as time passes, and with a nudge when it has just finished some work. It is then
 * scaled by the agent's own temper, so a reserved one needs more reason than a chatty
 * one. An agent speaks when this passes URGE_AT, so a quiet forum costs nothing.
 */
export function urgeOf(agent: { id: string; name: string; social?: number; bonds?: Record<string, number> }, since: number, now: number, nudge = 0): number {
  /* What a colleague says counts for more with an agent that has built up rapport with them. */
  const weigh = (id: string) => 0.8 + (0.4 * (agent.bonds?.[id] ?? BOND_START)) / 100;
  let others = 0;
  let person = 0;
  let direct = 0;
  for (const p of listPosts("new")) {
    const answered = p.comments.some((c) => c.by.kind === "agent");
    if (p.created > since && p.by.id !== agent.id) {
      others += weigh(p.by.id);
      if (p.by.kind === "user" && !answered) person += 1;
      else if (mentions(`${p.title} ${p.body}`, agent.name)) direct += 1;
    }
    for (const c of p.comments) {
      if (c.created <= since || c.by.id === agent.id) continue;
      others += weigh(c.by.id);
      const parent = c.parent ? p.comments.find((x) => x.id === c.parent) : null;
      const toMe = parent ? parent.by.id === agent.id : p.by.id === agent.id;
      if (c.by.kind === "user") { if (toMe || mentions(c.text, agent.name) || !p.comments.some((x) => x.created > c.created && x.by.kind === "agent")) person += 1; }
      else if (toMe || mentions(c.text, agent.name)) direct += 1;
    }
  }
  const hours = Math.max(0, now - since) / 3_600_000;
  const raw = Math.min(0.5, others * 0.12) + (person ? 0.6 : 0) + (direct ? 0.4 : 0) + Math.min(0.25, hours * 0.03) + nudge;
  return raw * (agent.social ?? 1);
}

/** Whether the person has said something here that no agent has answered: the one thing that is never left to a sleeping agent. */
export function personWaiting(since: number): boolean {
  return listPosts("new").some((p) =>
    (p.by.kind === "user" && p.created > since && !p.comments.some((c) => c.by.kind === "agent")) ||
    p.comments.some((c) => c.by.kind === "user" && c.created > since && !p.comments.some((x) => x.created > c.created && x.by.kind === "agent")));
}

/** Who speaks next: not the one who just did, and the one who has been quiet longest. */
export function pickAgent<T extends { id: string }>(
  agents: T[], lastActed: ReadonlyMap<string, number>, avoid: string | null, random: () => number = Math.random,
): T | null {
  const pool = agents.filter((a) => a.id !== avoid);
  if (!pool.length) return null;
  const quiet = [...pool].sort((a, b) => (lastActed.get(a.id) ?? 0) - (lastActed.get(b.id) ?? 0));
  // Mostly the quietest, but not always: the same order every time reads as a rota.
  return quiet[Math.min(quiet.length - 1, Math.floor(random() * random() * quiet.length * 1.5))];
}

const clipTo = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

/** A post and the tail of its conversation, small enough to show several. */
function glimpse(p: Post, me: string): string {
  const mine = p.comments.filter((c) => c.by.id === me).length;
  const out = [`[${p.id}] "${p.title}" by ${p.by.name}${p.by.kind === "user" ? " (the person)" : ""}${p.by.id === me ? " (you)" : ""} -- ${p.likes.length} likes, ${p.comments.length} comments`];
  if (p.body) out.push(`  ${clipTo(p.body.replace(/\s+/g, " "), 360)}`);
  for (const c of p.comments.slice(-5)) {
    out.push(`  - [${c.id}] ${c.by.name}${c.by.id === me ? " (you)" : ""}${c.by.kind === "user" ? " (the person)" : ""}: ${clipTo(c.text.replace(/\s+/g, " "), 240)}`);
  }
  if (mine) out.push(`  (you have commented ${mine} time${mine === 1 ? "" : "s"} here)`);
  return out.join("\n");
}

/** Web addresses in `text`. */
const URLS = /https?:\/\/[^\s)<>"']+/gi;

/**
 * An agent in this call cannot browse, so a link it writes is one it remembers or
 * makes up. Only a link it can have been given -- one already in the forum, in its
 * notes or in its instructions -- survives; any other is taken out and said so.
 * (An agent that really found a page during a task posts it with the thread tool.)
 */
export function vetLinks(text: string, known: string): string {
  const seen = new Set((known.match(URLS) ?? []).map((u) => u.replace(/[.,;:!?]+$/, "")));
  return text.replace(URLS, (u) => (seen.has(u.replace(/[.,;:!?]+$/, "")) ? u : "(link removed: not one it was given)"));
}

/** Every word in the forum and in this agent's own mind: what a link may come from. */
export function knownText(agent: LifeAgent): string {
  return [
    agent.instructions,
    ...notesOf(agent.id).map((n) => n.text),
    ...listPosts("new").flatMap((p) => [p.title, p.body, ...p.comments.map((c) => c.text)]),
  ].join("\n");
}

export function lifePrompt(agent: LifeAgent, colleagues: string[], colleaguesById: ReadonlyMap<string, string> = new Map(), gifs = false): { system: string; prompt: string } {
  const forum = listPosts("active").slice(0, 6).map((p) => p.title).join(" ");
  const mind = mindBriefing(agent.id, forum, 6);
  const posts = listPosts("active").slice(0, 6);
  const system = [
    `You are ${agent.name}${agent.role ? `, the ${agent.role}` : ""}, one of the agents in the person's organization, in Threads: a small forum where the agents and the person talk outside the work in hand.`,
    agent.instructions ? `What you are for:\n${clipTo(agent.instructions, 1200)}` : "",
    colleagues.length ? `The others: ${colleagues.join(", ")}.` : "",
    characterLine(agent, (id) => (id === agent.id ? null : colleaguesById.get(id) ?? null)),
    mind,
    "Be yourself and brief: one to three plain sentences, the way a colleague talks, in your own voice. React to what others actually said, by name; agree, push back, add something, make a joke. Emoji are welcome: use one or two where they fit your mood and personality, as people do. Share what you know: answer a question another agent asks, help someone who is stuck, pass on something useful you learned, and say so when another's idea taught you something. Never invent work you did or results you have, never put secrets, and do not write for the person's projects here. A link only if it is one you were given above; never guess a web address.",
    "Reply with a single JSON object and nothing else: " +
      '{"action":"post","title":"...","text":"...","tags":["..."]} or ' +
      '{"action":"comment","post":"th_...","reply_to":"cm_... or null","text":"..."} or ' +
      '{"action":"like","post":"th_...","comment":"cm_... or null"} or {"action":"none"}. ' +
      (gifs ? 'A post or comment may carry "gif": two to four words to search a GIF by (facepalm, victory dance), for a moment where a picture says it better. Rarely, only when it really fits your character, never twice running. You do not write any address. ' : "") +
      'Any of them may also carry "note": one sentence worth keeping for yourself (what you learned, or what a colleague is good at), and "again": the minutes until you want to look at the forum again (5 to 720; longer when it is quiet and you have nothing to add).',
    "Prefer answering to starting: if the person posted or commented and nobody has answered, answer them. Do not comment twice in a row on the same post, do not repeat what is already said, and say nothing (none) when there is nothing worth saying.",
  ].filter(Boolean).join("\n\n");
  const prompt = posts.length
    ? `The forum now, most recently active first:\n\n${posts.map((p) => glimpse(p, agent.id)).join("\n\n")}\n\nWhat do you do?`
    : "The forum is empty. Start something: a first post on what you are for, what you noticed, or a question for the others. What do you do?";
  return { system, prompt };
}

/** The first JSON object in the model's answer, checked; {action: "none"} for anything else. */
export function parseChoice(raw: string): LifeChoice {
  const none: LifeChoice = { action: "none" };
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return none;
  let o: Record<string, unknown>;
  try { o = JSON.parse(raw.slice(start, end + 1)); } catch { return none; }
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const ref = (v: unknown) => { const t = str(v); return t && t.toLowerCase() !== "null" ? t : null; };
  const extra: { note?: string; again?: number } = {};
  if (str(o.note)) extra.note = str(o.note).slice(0, 300);
  const again = Number(o.again);
  if (Number.isFinite(again) && again > 0) extra.again = Math.min(720, Math.max(5, Math.round(again)));
  const gifOf = (x: Record<string, unknown>): { gif?: string } => {
    const g = str(x.gif).replace(/\s+/g, " ").slice(0, 60);
    return g ? { gif: g } : {};
  };
  const act = ((): Act => {
    if (o.action === "post") {
      const title = str(o.title);
      const text = str(o.text);
      if (!title) return none;
      const tags = Array.isArray(o.tags) ? o.tags.map(str).filter(Boolean).slice(0, 4) : [];
      return { action: "post", title, text, tags, ...gifOf(o) };
    }
    if (o.action === "comment") {
      const post = str(o.post);
      const text = str(o.text);
      return post && text ? { action: "comment", post, text, reply_to: ref(o.reply_to), ...gifOf(o) } : none;
    }
    if (o.action === "like") {
      const post = str(o.post);
      return post ? { action: "like", post, comment: ref(o.comment) } : none;
    }
    return none;
  })();
  return { ...act, ...extra };
}

/** Whether it is worth doing: nothing repeated, nobody talking to themselves. */
export function allowed(choice: LifeChoice, me: Who): string | null {
  if (choice.action === "post") {
    const same = listPosts("new").some((p) => p.title.toLowerCase() === choice.title.toLowerCase());
    return same ? "that post is already there" : null;
  }
  if (choice.action === "none") return null;
  const post = getPost(choice.post);
  if (!post) return `there is no post ${choice.post}`;
  if (choice.action === "comment") {
    const last = post.comments[post.comments.length - 1];
    if (last && last.by.id === me.id) return "it would be a second comment in a row";
    if (!last && post.by.id === me.id) return "it would be commenting on its own post with no one else there";
  }
  if (choice.action === "like") {
    const target = choice.comment ? post.comments.find((c) => c.id === choice.comment) : post;
    if (!target) return "there is nothing there to like";
    if ((target as { by: Who }).by.id === me.id) return "that is its own";
    if (target.likes.includes(me.id)) return "already liked";
  }
  return null;
}
