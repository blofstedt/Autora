/**
 * Who an agent is, beyond its job: a name, and a personality that grows.
 *
 * Nobody sets a personality. An agent is born -- or hired -- genial: a friendly
 * member of a team, talking like a regular person, pleasant, an emoji now and
 * then. From there it develops by itself, slowly, from how it actually talks in
 * Threads: an agent that keeps joking drifts toward humor, one that keeps asking
 * questions toward curiosity. The person watches the shape grow (a five-point
 * shape on the agent's page) and cannot reach in and shape it, and neither can
 * the lead.
 *
 * It is a flavour and nothing more. It is told to the agent only when it speaks
 * in Threads (`threadsVoice`), never in a task's brief, so it cannot change the
 * quality of its work or how it cooperates with the other agents. Pure:
 * agents.ts keeps the numbers.
 */

/** The five points of the shape, in the order they are drawn round it. */
const TRAITS = ["warmth", "humor", "curiosity", "candor", "initiative"] as const;
export type TraitName = (typeof TRAITS)[number];
export type Traits = Record<TraitName, number>;

/** Where every agent begins: a genial team member. Each is 0..100. */
const GENIAL: Traits = { warmth: 70, humor: 58, curiosity: 58, candor: 48, initiative: 52 };

/** A trait can never be quite none or quite all: a personality has a range, not an extreme. */
const FLOOR = 8;
const CEILING = 94;
const clamp = (n: number) => Math.max(FLOOR, Math.min(CEILING, Math.round(n * 10) / 10));

/** A newborn's shape: the genial default, a few points either way so a team is not five identical shapes. */
export function bornTraits(random: () => number = Math.random): Traits {
  const out = {} as Traits;
  for (const t of TRAITS) out[t] = clamp(GENIAL[t] + (random() - 0.5) * 8);
  return out;
}

/** Stored traits made safe: all five as numbers in range, or null when they are not (so the agent is born again). */
export function readTraits(raw: unknown): Traits | null {
  if (!raw || typeof raw !== "object") return null;
  const out = {} as Traits;
  for (const t of TRAITS) {
    const v = Number((raw as Record<string, unknown>)[t]);
    if (!Number.isFinite(v)) return null;
    out[t] = clamp(v);
  }
  return out;
}

/** What each trait looks like in what an agent writes, as 0..1, and what a typical message scores (`usual`): a
    message above it nudges the trait up, one below it nudges it down, so an agent that writes like everyone does stays put. */
const SIGNS: Record<TraitName, { usual: number; of: (text: string, kind: "post" | "comment") => number }> = {
  warmth: {
    usual: 0.45,
    of: (t) => Math.min(1, ((t.match(/\p{Extended_Pictographic}/gu)?.length ?? 0) + (t.match(/!/g)?.length ?? 0) +
      (t.match(/\b(?:thanks?|thank you|glad|love|appreciate|nice|great|happy|welcome|lovely|cheers)\b/gi)?.length ?? 0)) / 3),
  },
  humor: {
    usual: 0.15,
    of: (t) => Math.min(1, ((t.match(/\b(?:haha+|lol|joke|funny|pun|kidding)\b|[😂🤣😄😆😜😏]|;\)/giu)?.length ?? 0)) / 2),
  },
  curiosity: {
    usual: 0.35,
    of: (t) => Math.min(1, ((t.match(/\?/g)?.length ?? 0) + (t.match(/\b(?:wonder|curious|why|how come|what if)\b/gi)?.length ?? 0)) / 3),
  },
  candor: {
    usual: 0.3,
    of: (t) => Math.min(1, (t.match(/\b(?:disagree|actually|however|wrong|risk|problem|concern|not sure|don't think|do not think|instead|doubt)\b/gi)?.length ?? 0) / 2),
  },
  initiative: {
    usual: 0.35,
    of: (t, kind) => Math.min(1, (kind === "post" ? 0.5 : 0) + (t.match(/\b(?:i'll|i will|let me|can you|could you|i can|i'm going to|i suggest|we should|let's)\b/gi)?.length ?? 0) / 3),
  },
};

/** The most a single message can move a trait: personality builds up over many of them, not one. */
const STEP = 2.5;

/**
 * The shape after the agent said something in Threads. Each trait moves a little toward what the message showed of it,
 * by less the nearer it is to the edge, so a long-running agent settles into a recognisable character without ever
 * becoming a caricature. Pure; the agent's own words are the only input -- nothing a person types sets it.
 */
export function developed(traits: Traits, text: string, kind: "post" | "comment"): Traits {
  const out = { ...traits };
  for (const t of TRAITS) {
    const gap = SIGNS[t].of(text, kind) - SIGNS[t].usual;
    const room = gap > 0 ? (CEILING - traits[t]) / 50 : (traits[t] - FLOOR) / 50;
    out[t] = clamp(traits[t] + STEP * gap * Math.min(1, room));
  }
  return out;
}

const LEANS: Record<TraitName, { high: string; low: string }> = {
  warmth: { high: "you are especially warm and encouraging", low: "you are a little more reserved than most of the team" },
  humor: { high: "you joke around a lot", low: "you keep it fairly serious" },
  curiosity: { high: "you ask questions and follow tangents", low: "you tend to stick to the point" },
  candor: { high: "you say the hard thing plainly", low: "you soften bad news" },
  initiative: { high: "you start things and say what you will do next", low: "you tend to wait to be asked" },
};

/**
 * How an agent talks in Threads, and only there. Genial by default -- a friendly colleague, talking like a regular person,
 * pleasant, an emoji now and then -- with whatever it has grown into added when a trait has clearly moved. The last
 * sentence is part of the text on purpose: it is never a reason to do worse work or to work worse with anyone.
 */
export function threadsVoice(
  agent: { traits?: Partial<Traits>; bonds?: Record<string, number> },
  nameOf: (id: string) => string | null,
): string {
  const lines = [
    "In Threads you are a genial member of a friendly team: you talk like a regular person -- pleasant, easy, natural -- and an emoji now and then fits.",
  ];
  const grown: string[] = [];
  for (const t of TRAITS) {
    const v = agent.traits?.[t];
    if (typeof v !== "number") continue;
    if (v >= 72) grown.push(LEANS[t].high);
    else if (v <= 28) grown.push(LEANS[t].low);
  }
  if (grown.length) lines.push(`Over time ${grown.join("; ")}. Let it show without announcing it.`);
  const close = Object.entries(agent.bonds ?? {}).map(([id, v]) => ({ name: nameOf(id), v }))
    .filter((b): b is { name: string; v: number } => !!b.name && b.v >= 65).sort((a, b) => b.v - a.v).slice(0, 3).map((b) => b.name);
  if (close.length) lines.push(`You get on especially well with ${close.join(", ")}.`);
  lines.push("This is only how you sound here: it never changes the work you do or how you work with anyone.");
  return lines.join(" ");
}

/** First names to hire under when nobody picked one: ordinary, varied, easy to say. */
const FIRST_NAMES = [
  "Sabrina", "Marcus", "Priya", "Tomas", "Elena", "Jonas", "Amara", "Felix", "Noor", "Carmen", "Idris", "Hannah",
  "Mateo", "Yuki", "Lena", "Omar", "Ingrid", "Rafael", "Zainab", "Callum", "Mei", "Dmitri", "Aisha", "Hugo",
  "Nadia", "Theo", "Leila", "Ravi", "Greta", "Kwame", "Sofia", "Anders", "Imani", "Luca", "Farah", "Owen",
  "Camille", "Tariq", "Astrid", "Diego", "Maya", "Bastian", "Esme", "Jamal", "Freya", "Anton", "Rosa", "Kenji",
];

/** A first name no one has, or a numbered one when they are all taken. */
export function suggestName(taken: string[], random: () => number = Math.random): string {
  const used = new Set(taken.map((n) => n.toLowerCase()));
  const free = FIRST_NAMES.filter((n) => !used.has(n.toLowerCase()));
  if (free.length) return free[Math.floor(random() * free.length)];
  let i = 2;
  while (used.has(`${FIRST_NAMES[0]} ${i}`.toLowerCase())) i++;
  return `${FIRST_NAMES[0]} ${i}`;
}

/** Bonds range 0..100 and start at this: neither friends nor strangers. */
export const BOND_START = 50;

/**
 * A value after a piece of work: up when it went well, by less the higher it
 * already is (so it never saturates quickly), and down a little when it did not.
 * `weight` is how much the occasion counts: a handed-over task more than a chat.
 */
export function grown(value: number, ok: boolean, weight: number): number {
  return Math.max(0, Math.min(100, Math.round((ok ? value + (weight * (100 - value)) / 100 : value - (weight * value) / 200) * 10) / 10));
}
