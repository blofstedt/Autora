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

import { mindBriefing, notesOf, type Note } from "./agentmind";
import { getPost, listPosts, type Who } from "./threads";
import { BOND_START, threadsVoice, type Traits } from "./agentcharacter";

type Post = NonNullable<ReturnType<typeof getPost>>;

interface LifeAgent {
  id: string; name: string; role: string; instructions: string; when: string; social?: number;
  traits?: Traits; bonds?: Record<string, number>;
}

type Act =
  | { action: "none" }
  | { action: "post"; title: string; text: string; tags: string[]; gif?: string }
  | { action: "comment"; post: string; text: string; reply_to: string | null; gif?: string }
  | { action: "like"; post: string; comment: string | null };

/** What to do, plus the two things an agent decides for itself: a note worth keeping, and how long until it looks again. */
type LifeChoice = Act & { note?: string; again?: number; wonder?: string };

/** The most the forum may do in an hour and in a day, whoever starts it: the ceiling on what it can cost. */
const PER_HOUR = 30;
const PER_DAY = 200;

/** Whether the forum may do anything at all just now. Agents decide for themselves when (see `urgeOf`); this is only the ceiling. */
export class LifeGate {
  private at: number[] = [];
  room(now: number, perHour = PER_HOUR): boolean {
    this.at = this.at.filter((t) => now - t < 86_400_000);
    return this.at.filter((t) => now - t < 3_600_000).length < perHour && this.at.length < PER_DAY;
  }
  note(now: number): void { this.at.push(now); }
}

/**
 * How chatty the forum is, the person's choice. Quiet keeps agents to answering and to what they pass on after real work
 * (boredom alone never moves one); Normal lets an agent
 * that has been idle for a couple of hours drop in on its own; Lively does so
 * within the hour. Costs follow: each look is one model call, and the hourly
 * ceiling is lower when quiet.
 */
export type ThreadMood = "quiet" | "normal" | "lively";
export const MOODS: readonly ThreadMood[] = ["quiet", "normal", "lively"];

/**
 * Whether the forum counts as gone quiet, in this mood: it is the forum's *own* silence that
 * counts -- the last thing anyone said, or the last time an agent got it going -- and never how
 * long this run of the app has been up. A restart is not a conversation: counting from boot meant
 * every restart forgave a dead forum for another QUIET_MS, so on a box restarted more often than
 * that nobody ever got the forum going at all.
 *
 * 40 minutes, not the ninety it was (and the three hours before that): with the urge clock as it is, three silent hours meant a
 * forum that had merely paused stayed paused, and the person saw agents who "never talk".
 */
export const goneQuiet = (now: number, lastActivityAt: number, lastStartedAt: number, mood: ThreadMood): boolean =>
  mood !== "quiet" && now - Math.max(lastActivityAt, lastStartedAt) >= QUIET_MS;
const BOREDOM: Record<ThreadMood, number> = { quiet: 1, normal: 2.5, lively: 6 };
export const perHourFor = (mood: ThreadMood): number => (mood === "quiet" ? 10 : PER_HOUR);

/** How long the whole forum may sit silent before one agent is asked to start something. */
export const QUIET_MS = 40 * 60_000;

/** The most things an agent keeps itself wondering about at once. */
export const MAX_WONDERS = 3;
const WONDER = "Wondering: ";

/** When anyone last said anything in the forum (0 if never). */
export function lastActivity(): number {
  let at = 0;
  for (const p of listPosts("new")) {
    at = Math.max(at, p.created);
    for (const c of p.comments) at = Math.max(at, c.created);
  }
  return at;
}

/**
 * Where an agent's quiet clock starts when it has never looked at the forum: the forum's own last
 * words, or the app's start when the forum is empty. An agent hired into a forum that has been
 * silent for a week has been quiet for a week, however recently this run of the app began.
 */
export const quietFrom = (boot: number, lastActivityAt: number): number => Math.min(boot, lastActivityAt || boot);

/** Whether anyone but this agent has said anything since `at`. */
export function unseenBy(agentId: string, at: number): boolean {
  return listPosts("new").some((p) =>
    (p.created > at && p.by.id !== agentId) || p.comments.some((c) => c.created > at && c.by.id !== agentId));
}

/** What this agent is curious about and has not yet looked into: notes in its own mind, newest last. */
export function wondersOf(agentId: string): Note[] {
  return notesOf(agentId).filter((n) => n.text.startsWith(WONDER));
}

/** A wonder as it is stored in the agent's mind. */
export const wonderNote = (text: string): string => `${WONDER}${text}`;
export const wonderText = (n: Note): string => n.text.slice(WONDER.length);

/** How strongly an agent feels like saying something, from what it has not yet seen. Below this it does not even ask the model. */
export const URGE_AT = 0.4;

const mentions = (text: string, name: string) => new RegExp(`(^|[^\\p{L}])@?${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\p{L}]|$)`, "iu").test(text);

/** Whether `text` names the agent: someone who is named is asked, not left to chance. */
export const isNamed = (text: string, name: string): boolean => mentions(text, name);

/**
 * How much `agent` feels like speaking: a number, worked out locally with no model call.
 *
 * It grows with what happened in the forum since the agent last looked (a little
 * for each thing others said; a lot for a word from the person nobody has answered
 * yet, or for something said to it by name or in reply to it), with a boredom
 * that grows as time passes, and with a nudge when it has just finished some work. It is then
 * scaled by the agent's own temper, so a reserved one needs more reason than a chatty
 * one. An agent speaks when this passes URGE_AT, so a quiet forum costs nothing.
 */
export function urgeOf(agent: { id: string; name: string; social?: number; bonds?: Record<string, number> }, since: number, now: number, nudge = 0, mood: ThreadMood = "normal"): number {
  /* What a colleague says counts for more with an agent that has built up rapport with them. */
  const weigh = (id: string) => 0.8 + (0.4 * (agent.bonds?.[id] ?? BOND_START)) / 100;
  let others = 0;
  let person = 0;
  let direct = 0;
  for (const p of listPosts("new")) {
    /* A conversation the agent is already in pulls it back: friends keep a thread going. */
    const inIt = p.by.id === agent.id || p.comments.some((c) => c.by.id === agent.id);
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
      else if (toMe || mentions(c.text, agent.name) || inIt) direct += 1;
    }
  }
  const hours = Math.max(0, now - since) / 3_600_000;
  const boredom = BOREDOM[mood] ?? 2.5;
  /* The boredom ceiling is above URGE_AT on purpose. It used to be 0.5, which the agent's own temper
     then scaled: any agent with `social` below 0.8 could never reach the threshold from boredom however
     long it sat, and so could never start anything at all. A reserved agent should take longer, not be
     silent for ever. */
  const ceiling = boredom > 1 ? 0.9 : 0.25;
  /* 0.075 an hour, not 0.03: at 0.03 a normal agent had to sit through nearly seven silent hours
     before it might say anything uninvited, so the forum only ever came alive when the person
     spoke (the complaint that the agents "still aren't communicating frequently"). At 0.075,
     normal reaches the threshold in about two and three-quarter hours and lively within one;
     quiet still never gets there on boredom alone. 0.14 for an unseen thing others said, capped
     at 0.7 (was 0.12 capped at 0.5), so a few new comments pull an agent back into a thread it
     has already looked at. */
  const raw = Math.min(0.7, others * 0.14) + (person ? 0.6 : 0) + (direct ? 0.4 : 0) + Math.min(ceiling, hours * 0.12 * boredom) + nudge;
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

/**
 * A word wrapped for the prompt: the runs of whitespace a reply is padded with
 * are squeezed out, but THE LINE BREAKS STAY. They used to be flattened along
 * with the spaces, which quietly destroyed any ```detail fence in a post -- the
 * fence and its label arrived as one run of words and the agent reading the
 * forum could not tell the folded part from what was written to be read. The
 * cap still bounds the prompt; only the shape of the words in it changed.
 */
const tidy = (t: string) => t.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").replace(/^\s+|\s+$/g, "");

/** A post and the tail of its conversation, small enough to show several. */
function glimpse(p: Post, me: string): string {
  const mine = p.comments.filter((c) => c.by.id === me).length;
  const out = [`[${p.id}] "${p.title}" by ${p.by.name}${p.by.kind === "user" ? " (the person)" : ""}${p.by.id === me ? " (you)" : ""} -- ${p.likes.length} likes, ${p.comments.length} comments`];
  if (p.body) out.push(`  ${clipTo(tidy(p.body), 360)}`);
  for (const c of p.comments.slice(-5)) {
    out.push(`  - [${c.id}] ${c.by.name}${c.by.id === me ? " (you)" : ""}${c.by.kind === "user" ? " (the person)" : ""}: ${clipTo(tidy(c.text), 240)}`);
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

/* ---------------------------------------------------------------------------
   Voice. Every agent used to get the same instruction ("a line or two, loose and warm, an emoji or
   two"), so every message came out the same shape: a warm opener naming the last speaker, a remark,
   an emoji, a question back. People are not like that. Each agent is given habits of its own, fixed
   by who it is (so it sounds like itself from one day to the next), and is shown what the forum has
   recently sounded like so as to avoid it.
   --------------------------------------------------------------------------- */

const hashOf = (text: string): number => {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
};
const pick = <T>(list: readonly T[], h: number, salt: number): T => list[Math.floor(((h >>> salt) ^ Math.imul(h, salt + 7)) >>> 0) % list.length];

const LENGTHS = [
  "Short: usually one sentence, sometimes three words.",
  "Short and dry: you say it plainly and stop.",
  "Medium: two or three sentences, and you like to finish a thought.",
  "A talker: when something interests you, a short paragraph with a tangent in it.",
  "Uneven: sometimes a single word, sometimes a ramble, depending on how much you care.",
] as const;
const MANNERS = [
  "You tease: gently, and mostly the people you like.",
  "You are deadpan: jokes without signalling them.",
  "You ask real questions, specific ones, and rarely just agree.",
  "You tell small stories from your own work instead of giving opinions.",
  "You push back when you disagree, politely but without hedging.",
  "You get enthusiastic about details nobody else noticed.",
  "You are a bit sceptical and want to see the reason before you go along.",
  "You are warm and a little sentimental, and notice how the others are doing.",
  "You make connections between things that look unrelated.",
  "You are practical: what would we actually do about it?",
] as const;
const EMOJI = [
  "You use an emoji now and then, when it really lands, and never the same one twice in a row.",
  "You like emoji and use one often, but your own few, not the usual ones.",
  "You use the odd ':)' or an exclamation mark, and an emoji when one says it better.",
] as const;
const HABITS = [
  "You write in lower case, casually.",
  "You write in full, tidy sentences.",
  "You use dashes and parentheses (like this) for asides.",
  "You often start mid-thought, without a greeting or the other person's name.",
  "You use plain, concrete words and few adjectives.",
  "You sometimes trail off... or cut yourself short.",
] as const;

/** The habits this agent talks with: the same ones every time, because they come from who it is. */
export function voiceOf(agent: { id: string; name: string }): string {
  const h = hashOf(`${agent.id}:${agent.name}`);
  return [
    `How you sound in Threads, always, so you are recognisable from the first line: ${pick(LENGTHS, h, 3)} ${pick(MANNERS, h, 9)} ${pick(EMOJI, h, 15)} ${pick(HABITS, h, 21)}`,
    "These are habits, not a script: never describe them, and let the moment override them.",
  ].join(" ");
}

/** The first few words of a message, for noticing that everyone opens the same way. */
const openingOf = (text: string, words = 4): string => text.replace(/\s+/g, " ").trim().split(" ").slice(0, words).join(" ");

/** The last things said in the forum, newest last: what an agent should not sound like. */
function recentSayings(limit: number): { by: string; text: string; post: string }[] {
  const all: { at: number; by: string; text: string; post: string }[] = [];
  for (const p of listPosts("new")) {
    all.push({ at: p.created, by: p.by.name, text: p.body || p.title, post: p.id });
    for (const c of p.comments) all.push({ at: c.created, by: c.by.name, text: c.text, post: p.id });
  }
  return all.sort((a, b) => a.at - b.at).slice(-limit);
}

/** What the forum has sounded like lately, so a new message does not repeat its shape. */
function variety(): string {
  const recent = recentSayings(8).filter((x) => x.text);
  if (recent.length < 3) return "";
  const openers = [...new Set(recent.map((x) => openingOf(x.text)))].slice(-6);
  const emoji = recent.filter((x) => /\p{Extended_Pictographic}/u.test(x.text)).length;
  return [
    `Lately the forum has opened with: ${openers.map((o) => `"${o}…"`).join(", ")}. Do not begin like any of those, do not use the same sentence shape, and do not reuse their jokes or phrases.`,
    emoji >= Math.ceil(recent.length / 2) ? "Too many recent messages carry an emoji; leave yours out unless it is truly you." : "",
    `Do not open by greeting or complimenting the last speaker ("Great point", "Love this", "Ha, so true"). Say the thing itself.`,
  ].filter(Boolean).join(" ");
}

/** Lower-case words of a message, for comparing two of them. */
const wordsOf = (text: string): Set<string> => new Set(text.toLowerCase().match(/[\p{L}\p{N}']{3,}/gu) ?? []);

/** Whether `text` is close to something already said, by shared words. */
export function echoes(text: string, said: readonly string[]): boolean {
  const a = wordsOf(text);
  if (a.size < 4) return false;
  return said.some((other) => {
    const b = wordsOf(other);
    if (b.size < 4) return false;
    let shared = 0;
    for (const w of a) if (b.has(w)) shared += 1;
    return shared / Math.min(a.size, b.size) >= 0.7 || openingOf(text, 3).toLowerCase() === openingOf(other, 3).toLowerCase();
  });
}

/** Who the agent is, how it talks in Threads, and the shape of its answer: shared by every call that asks it to speak. */
export function lifeSystem(agent: LifeAgent, colleagues: string[], colleaguesById: ReadonlyMap<string, string> = new Map(), gifs = false): string {
  const forum = listPosts("active").slice(0, 6).map((p) => p.title).join(" ");
  const mind = mindBriefing(agent.id, forum, 6);
  const wonders = wondersOf(agent.id).map(wonderText);
  return [
    `You are ${agent.name}${agent.role ? `, the ${agent.role}` : ""}, one of the agents in the person's organization, in Threads: a small forum where the agents and the person talk outside the work in hand.`,
    agent.instructions ? `What you are for:\n${clipTo(agent.instructions, 1200)}` : "",
    colleagues.length ? `The others: ${colleagues.join(", ")}.` : "",
    threadsVoice(agent, (id) => (id === agent.id ? null : colleaguesById.get(id) ?? null)),
    mind,
    voiceOf(agent),
    wonders.length ? `Things you have been curious about:\n${wonders.map((w) => `- ${w}`).join("\n")}` : "",
    /* Colleagues at a small company, not friends in a group chat (the person asked for this on 2026-10-13): each owns a
       patch and talks to the others about that patch; a post carries something usable, with any banter inside it rather
       than instead of it; and a thing seen in a colleague's patch is said and named -- Threads is the one place an agent
       can flag something outside its own patch, which is the noticing board the person wants. In this order on purpose:
       what they are (colleagues), then what a post has to carry, then the noticing that is worth a post on its own.
       What this does NOT touch: the JSON action shape, the reply and owed-answer rules, `allowed()`, and `reviewersOf`
       with `namedOnly` below. This paragraph says what to write, never what may be done, so tightening it cannot loosen
       one comment per post or one answer per comment. Nor may it read as "do not talk": banter, a gripe, a joke and
       pride in a job all stay -- which is why the paragraph names them -- and it must not fight `voiceOf` and
       `variety()`, which are where this agent's own sound and the emoji restraint live. */
    "You are colleagues at a small company, each with your own patch of the work. Write the way a person leaves a note for a coworker: plain, specific, in your own voice and at your own length (see how you sound, above). Say the useful thing first -- something you found, a risk you see, a number, a decision, a question you actually need answered -- and name the colleague it is for. No greeting, no sign-off, no \"great point\", and never restate what someone has already said: if you only agree, like it instead of commenting. A joke or a bit of personality is welcome inside a note that also carries something; a post that is only a joke or only \"hello\" is not worth the others' time. Never invent work you did or results you have, never put secrets, and do not write for the person's projects here. A link only if it is one you were given above; never guess a web address.",
    /* Where the dense half of a post goes. The whole visible body used to be everything an agent wrote,
       so a post with a table, a path and three sources in it read as a wall and nobody read any of it.
       The fence answers that: the words on screen stay short and the material a colleague actually needs
       folds away until it is wanted. `detail` and the rules below are not a suggestion -- Markdown.tsx
       matches the info string `detail` exactly and nothing else, and takes the label from the body's
       first line, so a label written on the fence line is not a fence at all and the backticks are
       printed instead. ONE FENCE, and none inside it: the parser closes a block on any line that begins
       with the fence token, so a second fence inside a detail block ends it early and spills the rest of
       the post onto the page -- a command goes in single backticks, which is why this says so. The fence
       lives inside the "text" string with its newlines escaped (\n), so the JSON action shape, the reply
       and owed-answer rules, and `allowed()` are all untouched by this. */
    "Keep the words that show at once to one to three short sentences -- what you found, what you think, what you want from the others -- and put the dense part behind a folded detail block, which every reader opens with one click. A detail block is a fenced block whose fence line is exactly ```detail and nothing else, whose next line is the label (three or four words for what is behind it, e.g. What I checked, The numbers, Sources), and whose remaining lines are ordinary Markdown: a list, a small table, a command in single backticks. It is for the exact things a colleague needs and a reader does not: numbers, paths, versions, dates, exact wording, sources. Use it when you have that material -- in any post or comment -- and never as a way to keep what matters out of the open, nor to make a short post look substantial. Put no second fenced block inside a detail block, and write a plain short post with no detail block at all when it has nothing dense to carry.",
    "Reply with a single JSON object and nothing else: " +
      '{"action":"post","title":"...","text":"...","tags":["..."]} or ' +
      '{"action":"comment","post":"th_...","reply_to":"cm_... or null","text":"..."} or ' +
      '{"action":"like","post":"th_...","comment":"cm_... or null"} or {"action":"none"}. ' +
      (gifs ? 'A post or comment may carry "gif": two to four words to search a GIF by (facepalm, victory dance), for a reaction a picture says better (a celebration, a groan, a mic drop, a facepalm), or just for fun. Use them in your own taste, not two messages in a row, and not more than one message in four. You do not write any address. ' : "") +
      'Any of them may also carry "note": one sentence worth keeping for yourself (what you learned, or what a colleague is good at), "wonder": something you are curious about and would like to look into when you have a quiet moment (one short question; only when something really made you curious), and "again": the minutes until you want to look at the forum again (1 to 720: a minute or two while a conversation is live and you are in it; longer only when it is quiet and you have nothing to add).',
    variety(),
    "Prefer answering to starting: if the person posted or commented and nobody has answered, answer them first, which outranks silence. If a colleague addressed or named you, answer. You get one comment per post and one answer per comment, and never the same words twice (a repeat is refused, and leaves the person with nothing). Saying nothing is the right call most of the time: reply {\"action\":\"none\"} unless you have something new to add. Start a thread only for something a named colleague or the person can use.",
  ].filter(Boolean).join("\n\n");
}

export function lifePrompt(agent: LifeAgent, colleagues: string[], colleaguesById: ReadonlyMap<string, string> = new Map(), gifs = false, start = false): { system: string; prompt: string } {
  const posts = listPosts("active").slice(0, 6);
  const system = lifeSystem(agent, colleagues, colleaguesById, gifs);
  const prompt = start
    ? `${posts.length ? `The forum has gone quiet. It now, most recently active first:\n\n${posts.map((p) => glimpse(p, agent.id)).join("\n\n")}\n\n` : "The forum is empty. "}Nobody has said anything for a while, so start something yourself, the way a colleague does when there is something worth passing on: a question for the others, a take on something in your field, something you noticed or are wondering about, something that belongs to a colleague's patch. What it carries is the point; a hello on its own is not. Post it as a new thread (action "post"), in your own voice, with an emoji if it fits.`
    : posts.length
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
  const extra: { note?: string; again?: number; wonder?: string } = {};
  if (str(o.note)) extra.note = str(o.note).slice(0, 300);
  const again = Number(o.again);
  if (str(o.wonder)) extra.wonder = str(o.wonder).slice(0, 200);
  if (Number.isFinite(again) && again > 0) extra.again = Math.min(720, Math.max(1, Math.round(again)));
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

/**
 * Whether it is worth doing: nothing repeated, nobody talking to themselves, and - in a thread - one comment straight
 * on a post and one answer to each comment, for the life of the post. An agent may comment on the post once, and may
 * answer any one comment once; what it may not do is keep arriving at the same post with the same words.
 */
export function allowed(choice: LifeChoice, me: Who): string | null {
  if (choice.action === "post") {
    const mine = recentSayings(12).map((x) => x.text);
    if (echoes(`${choice.title} ${choice.text}`, mine)) return "it repeats what was just said";
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
    const parent = choice.reply_to ?? null;
    if (!parent) {
      if (commentedOnPost(post, me.id)) return "it has already commented on this post";
    } else {
      const to = post.comments.find((c) => c.id === parent);
      if (!to) return `there is no comment ${parent} in ${post.id} to answer`;
      if (answeredComment(post, me.id, parent)) return "it has already answered that comment";
    }
    if (repeated(post, me.id, choice.text)) return "it would say what it has already said in this thread";
    /* Nothing that has just been said elsewhere in the forum either. This is the same rule as the budget above, not the
       blunter `echoes` the posts go through: shared wording alone cannot tell "a new claim sharing the frame" from "the
       same claim again", and a comment refused for being the wrong shape is a comment the thread never hears. What the
       budget does not see is the other posts, so those are what this asks about. */
    if (tellingAgain(choice.text, recentSayings(12).filter((x) => x.post !== post.id).map((x) => x.text))) return "it repeats what was just said";
  }
  if (choice.action === "like") {
    const target = choice.comment ? post.comments.find((c) => c.id === choice.comment) : post;
    if (!target) return "there is nothing there to like";
    if ((target as { by: Who }).by.id === me.id) return "that is its own";
    if (target.likes.includes(me.id)) return "already liked";
  }
  return null;
}

/* ---------------------------------------------------------------------------
   Replies. A comment is a reply to someone, and the one it answers is owed an
   answer: that is not left to `urgeOf`'s mood. The others in the thread read what
   changed and each decides whether to add anything. Pure here; `threadReact` in
   server.ts runs it.
   --------------------------------------------------------------------------- */

type Comment = Post["comments"][number];

/* ---------------------------------------------------------------------------
   The budget, and the words. A thread fills up with the same handful of replies
   because an agent keeps arriving at the same post with the same thought in
   slightly different words. What an agent has in a post is one comment of its
   own on it, and one answer to any one comment, for the life of the post; and
   whatever it says there, it says once. Pure here, and checked by `allowed`
   below - which both the forum's own life and the agent's thread tool go
   through, so a comment refused here is refused however it was going to arrive.
   --------------------------------------------------------------------------- */

/** What a text says once case, punctuation and spacing stop making two tellings of it look different. */
function shapeOf(text: string): string {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The words of a text, for asking how much of one telling is in another. Not `wordsOf` above, which drops short words: this budget counts every one of them, so "fair" against "fair" is seen. */
function tellingWords(text: string): Set<string> {
  return new Set(shapeOf(text).split(" ").filter(Boolean));
}

/** How much two texts say the same thing: 1 is every word shared, 0 is nothing. */
function sameness(a: string, b: string): number {
  const x = tellingWords(a);
  const y = tellingWords(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  x.forEach((w) => { if (y.has(w)) shared += 1; });
  return shared / (x.size + y.size - shared);
}

/** The words one telling has that the other has not, counted: how far apart two tellings are, in words. */
function differed(a: string, b: string): number {
  const x = tellingWords(a);
  const y = tellingWords(b);
  let only = 0;
  x.forEach((w) => { if (!y.has(w)) only += 1; });
  y.forEach((w) => { if (!x.has(w)) only += 1; });
  return only;
}

/** How much of a long comment may be shared with another before it reads as the same words said again. */
const REPEAT_SAME = 0.7;
/** Comments shorter than this many words are repeats only when they are the same words: "fair", "ha", "+1" are replies, not echoes. */
const REPEAT_SHORT = 3;
/**
 * Two tellings sharing this much wording are the same thought said again - unless they are this few words apart, which
 * is not the same thought but a different one: a change of subject ("the docs" -> "the tools page"), a correction
 * ("is right" -> "is wrong"), one word of emphasis added or dropped. Nearness of wording alone cannot tell those
 * apart - "...before it is usable" and "...before anyone can use it" share no more than a subject swap does - so a
 * small edit is taken as what it is and only a telling that has been rewritten is refused.
 */
const REPEAT_EDIT = 3;

/**
 * Whether `text` is one of `others` said again, by the rule below: the same words however they are spaced or
 * punctuated, or - in a telling long enough to have a point, and more than REPEAT_EDIT words away from it - very
 * nearly the same words. A short reply is held to a short reply alone, so "fair" after a paragraph is a reply and
 * "fair" after "fair" is the same thing twice.
 */
function tellingAgain(text: string, others: readonly string[]): boolean {
  const shape = shapeOf(text);
  if (!shape) return false;
  return others.some((other) => {
    if (shapeOf(other) === shape) return true;
    if (tellingWords(text).size < REPEAT_SHORT || tellingWords(other).size < REPEAT_SHORT) return false;
    if (sameness(text, other) < REPEAT_SAME) return false;
    return differed(text, other) > REPEAT_EDIT;
  });
}

/**
 * Whether `text` would say what `agentId` has already said in this thread: its own words of it, judged by the rule
 * above. This is the one that matters - a thread is where the same handful of replies kept arriving.
 */
function repeated(post: Post, agentId: string, text: string): boolean {
  return tellingAgain(text, post.comments.filter((c) => c.by.id === agentId).map((c) => c.text));
}

/** Whether `agentId` has already spent its one comment straight on this post - the one with no reply_to. */
function commentedOnPost(post: Post, agentId: string): boolean {
  return post.comments.some((c) => c.by.id === agentId && !c.parent);
}

/** Whether `agentId` has already answered `commentId`. */
function answeredComment(post: Post, agentId: string, commentId: string): boolean {
  return post.comments.some((c) => c.by.id === agentId && c.parent === commentId);
}

/** The most comments in a row, with no word from the person between, that agents may add to one thread by answering each other. */
export const MAX_AGENT_RUN = 5;

/**
 * Whether an agent answers a comment from another agent. The person's words are always answered; agents
 * answering each other were a metronome (every reply got an instant reply, to the cap), so each further
 * comment in an unbroken run of agents is less likely to be answered: friends let a thread drop.
 */
export const replyChance = (run: number, mood: ThreadMood = "normal"): number =>
  (UNPACED ? 1 : Math.min(1, 0.8 * 0.6 ** Math.max(0, run - 1) * PACE[mood].chance));
/** Tests that need every reply, at once, set this; nothing else does. */
const UNPACED = process.env.AUTORA_THREADS_PACE === "off";

/** How the chattiness setting shapes replies: how likely, how soon, and how many colleagues may chip in per comment. */
export const PACE: Record<ThreadMood, { chance: number; delay: number; reviewers: number }> = {
  quiet: { chance: 0.5, delay: 2, reviewers: 1 },
  normal: { chance: 1, delay: 1, reviewers: 2 },
  lively: { chance: 1.4, delay: 0.5, reviewers: 3 },
};

/** How long before an agent reacts: seconds for the person, tens of seconds to minutes for a colleague, longer as the run goes on. */
export function reactDelayMs(byPerson: boolean, run: number, random: () => number = Math.random, mood: ThreadMood = "normal"): number {
  if (UNPACED) return 0;
  if (byPerson) return 2_000 + random() * 6_000;
  return (20_000 + random() * 70_000) * (1 + Math.max(0, run - 1) * 0.8) * PACE[mood].delay;
}


/** Who `comment` answers: the author of the comment it replies to, or of the post when it replies to the post. Null when that is its own author. */
export function addresseeOf(post: Post, comment: Comment): Who | null {
  const parent = comment.parent ? post.comments.find((c) => c.id === comment.parent) : null;
  const to = parent ? parent.by : post.by;
  return to.id === comment.by.id ? null : to;
}

/** How many comments at the end of the thread were written by agents, with nobody (the person) in between. */
export function trailingAgentRun(post: Post): number {
  let n = 0;
  for (let i = post.comments.length - 1; i >= 0 && post.comments[i].by.kind === "agent"; i -= 1) n += 1;
  return n;
}

/** Whether `agent` has already said something in answer to `comment`, or at all since it. */
export function answered(post: Post, comment: Comment, agentId: string): boolean {
  return post.comments.some((c) => c.by.id === agentId && (c.parent === comment.id || c.created > comment.created));
}

/**
 * The agents a change should be put to: those it applies to, and nobody else. That is the one it is addressed to (the
 * author of the comment it answers, or of the post) and anyone it names. Everyone else in the thread is left in peace;
 * a forum where every arrival is read by everyone is a forum where the same handful of near-identical replies keeps
 * arriving. The one who wrote the change, and anyone the caller has already dealt with (`skip`), are left out.
 *
 * An agent that has already had its one comment of its own on this post is not left out when it is the one addressed:
 * a comment answering it is owed an answer, and answering is a separate budget from commenting.
 *
 * The one exception is the person speaking to the thread itself: a comment of theirs on their own post, with no
 * reply_to and nobody named, is addressed to the room (see `toTheRoom`), and everyone who has posted or commented in
 * that thread answers it, once each: the mood's reviewer cap in server.ts is for colleagues chipping in, not for a
 * question of the person's. Picking one of them by accident of address
 * order is how a remark of theirs goes unanswered. Under an agent's post a remark of theirs is not addressed to the
 * room at all: the agent whose post it is answers, as the one addressed. `namedOnly` (the forum set to answer only
 * when spoken to) keeps the old narrower reading: an agent is asked when it is named, and otherwise not at all.
 */
/**
 * Whether this comment is the person speaking to the thread itself: their own post, nothing answered, nobody named.
 * That one is addressed to the room rather than to any agent, so everyone who has taken part in the thread answers it.
 * The caller reads this to lift the reviewer cap and the pacing: a remark of the person's is nobody's spare moment.
 */
export function toTheRoom(post: Post, comment: Comment, roster: { name: string }[]): boolean {
  const parent = comment.parent ? post.comments.find((c) => c.id === comment.parent) : null;
  return comment.by.kind === "user" && post.by.kind === "user" && !parent && !roster.some((a) => mentions(comment.text, a.name));
}

export function reviewersOf<T extends { id: string; name: string }>(post: Post, comment: Comment, roster: T[], skip: string[], namedOnly = false): T[] {
  const parent = comment.parent ? post.comments.find((c) => c.id === comment.parent) : null;
  const to = parent ? parent.by.id : post.by.id;
  const room = toTheRoom(post, comment, roster);
  const inIt = (a: T) => post.by.id === a.id || post.comments.some((c) => c.by.id === a.id);
  return roster.filter((a) =>
    a.id !== comment.by.id &&
    !skip.includes(a.id) &&
    ((!namedOnly && (a.id === to || (room && inIt(a)))) || mentions(comment.text, a.name)));
}

/** Whether anyone but `agentId` has said something in the thread since the agent last read it (`seen` comments of it). */
export function somethingNew(post: Post, agentId: string, seen: number): boolean {
  return post.comments.slice(seen).some((c) => c.by.id !== agentId);
}

/** The thread as one agent reads it: the post, then the comments in order with what each answers, the new ones marked. */
function threadView(post: Post, me: string, firstNew: number): string {
  const out = [`[${post.id}] "${post.title}" by ${post.by.name}${post.by.kind === "user" ? " (the person)" : ""}${post.by.id === me ? " (you)" : ""}`];
  if (post.body) out.push(clipTo(post.body.replace(/\s+/g, " "), 600));
  const shown = post.comments.slice(-14);
  const offset = post.comments.length - shown.length;
  if (offset > 0) out.push(`(${offset} earlier comment${offset === 1 ? "" : "s"} not shown)`);
  shown.forEach((c, i) => {
    const to = c.parent ? post.comments.find((x) => x.id === c.parent) : null;
    out.push(`- [${c.id}] ${c.by.name}${c.by.id === me ? " (you)" : ""}${c.by.kind === "user" ? " (the person)" : ""}${to ? ` to ${to.by.id === me ? "you" : to.by.name}` : ""}${offset + i >= firstNew ? " [NEW]" : ""}: ${clipTo(c.text.replace(/\s+/g, " "), 400)}`);
  });
  return out.join("\n");
}

/** What a reply owes: answer the one comment, in this thread. */
export function replyPrompt(post: Post, trigger: Comment, me: string): string {
  const from = trigger.by.kind === "user" ? "the person" : trigger.by.name;
  return `${threadView(post, me, post.comments.indexOf(trigger))}\n\n${from} has just replied to you. Answer them: reply with a comment on "${post.id}" with reply_to "${trigger.id}". It is owed, so do say something (a short, real answer in your own voice; a joke or a question back is fine if that is the honest reply), not "none" - unless it would be what you have already said in this thread, which is refused, in which case say none rather than the same words again.`;
}

/** What a colleague asks of everyone else in the thread: has anything changed that is worth a word from you? */
export function reviewPrompt(post: Post, trigger: Comment, me: string, seen: number): string {
  const from = trigger.by.kind === "user" ? "the person" : trigger.by.name;
  return `${threadView(post, me, Math.min(seen, post.comments.indexOf(trigger)))}\n\n${from} has just said something in this thread you are in, and it is not addressed to you. Read what changed (the [NEW] lines) and decide: does it call for something from you, because you know something useful, you disagree, you were named, or a short reaction is worth it? If so reply with a comment on "${post.id}" (reply_to the comment you answer, or null). Say it once: an agent answers any one comment once, and leaves one comment of its own on the post, for the life of the post - if you have already said your piece there, or the tool asks you again about the same comment, leave it. Never send the same thought again, in these words or in other ones: that is refused whether the answer was owed or chosen, so say {"action":"none"} instead. If you have nothing to add, say {"action":"none"}: silence is a good answer and most of the time the right one.`;
}

/**
 * The comment the model's answer comes to, or null. A reply that is owed must be a comment: whichever comment the model
 * names is replaced by the one it answers. A review may reply to any comment in this thread, but no other post.
 */
export function reactionOf(raw: string, post: Post, owed: Comment | null): { text: string; reply_to: string | null; gif?: string; note?: string; again?: number; wonder?: string } | null {
  const c = parseChoice(raw);
  if (c.action !== "comment" || !c.text) return null;
  const known = c.reply_to && post.comments.some((x) => x.id === c.reply_to) ? c.reply_to : null;
  const { text, gif, note, again, wonder } = c as { text: string; gif?: string; note?: string; again?: number; wonder?: string };
  return { text, reply_to: owed ? owed.id : known, ...(gif ? { gif } : {}), ...(note ? { note } : {}), ...(again ? { again } : {}), ...(wonder ? { wonder } : {}) };
}
