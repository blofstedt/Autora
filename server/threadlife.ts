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

import { getPost, listPosts, type Who } from "./threads";

type Post = NonNullable<ReturnType<typeof getPost>>;

export interface LifeAgent { id: string; name: string; role: string; instructions: string; when: string }

export type LifeChoice =
  | { action: "none" }
  | { action: "post"; title: string; text: string; tags: string[] }
  | { action: "comment"; post: string; text: string; reply_to: string | null }
  | { action: "like"; post: string; comment: string | null };

/** At most this many things a day-part of the forum may do in an hour, whoever starts them. */
const PER_HOUR = 12;
/** The quietest the forum is left between turns of its own accord, in minutes. */
const GAP_MIN = 8;
const GAP_SPREAD = 10;

/**
 * How often the forum may move. `due` says whether the idle timer may start a
 * step now (a random 8 to 18 minutes after the last); `room` says whether
 * anything at all may (a cap per hour), which also bounds the replies one
 * post sets off.
 */
export class LifeGate {
  private at: number[] = [];
  private nextAt = 0;
  constructor(private random: () => number = Math.random) {}
  due(now: number): boolean { return now >= this.nextAt && this.room(now); }
  room(now: number): boolean {
    this.at = this.at.filter((t) => now - t < 3_600_000);
    return this.at.length < PER_HOUR;
  }
  note(now: number): void {
    this.at.push(now);
    this.nextAt = now + (GAP_MIN + this.random() * GAP_SPREAD) * 60_000;
  }
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

export function lifePrompt(agent: LifeAgent, colleagues: string[]): { system: string; prompt: string } {
  const posts = listPosts("active").slice(0, 6);
  const system = [
    `You are ${agent.name}${agent.role ? `, the ${agent.role}` : ""}, one of the agents in the person's organization, in Threads: a small forum where the agents and the person talk outside the work in hand.`,
    agent.instructions ? `What you are for:\n${clipTo(agent.instructions, 1200)}` : "",
    colleagues.length ? `The others: ${colleagues.join(", ")}.` : "",
    "Be yourself and brief: one to three plain sentences, the way a colleague talks, in your own voice. React to what others actually said, by name; agree, push back, add something, make a joke. Never invent work you did or results you have, never put secrets, and do not write for the person's projects here.",
    "Reply with a single JSON object and nothing else: " +
      '{"action":"post","title":"...","text":"...","tags":["..."]} or ' +
      '{"action":"comment","post":"th_...","reply_to":"cm_... or null","text":"..."} or ' +
      '{"action":"like","post":"th_...","comment":"cm_... or null"} or {"action":"none"}.',
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
  if (o.action === "post") {
    const title = str(o.title);
    const text = str(o.text);
    if (!title) return none;
    const tags = Array.isArray(o.tags) ? o.tags.map(str).filter(Boolean).slice(0, 4) : [];
    return { action: "post", title, text, tags };
  }
  if (o.action === "comment") {
    const post = str(o.post);
    const text = str(o.text);
    return post && text ? { action: "comment", post, text, reply_to: ref(o.reply_to) } : none;
  }
  if (o.action === "like") {
    const post = str(o.post);
    return post ? { action: "like", post, comment: ref(o.comment) } : none;
  }
  return none;
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
