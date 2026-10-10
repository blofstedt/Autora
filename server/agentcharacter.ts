/**
 * Who an agent is, beyond its job: a human name, a personality and a handful of
 * attributes that the person can edit and that grow with the work.
 *
 * A new agent's personality is drawn from its expertise (a family lawyer comes out
 * careful and plain-spoken, a support agent warm), either by Autora when it hires,
 * who may write its own, or from `draftCharacter` when nobody did. The attributes
 * are numbers 0..100. Most stay where they are put; `teamwork` and each agent's
 * `bonds` (how well it works with each colleague) are the ones that evolve: they
 * rise slowly, with diminishing returns, when work handed between two agents or a
 * conversation in Threads goes well, and slip a little when it does not. Pure:
 * agents.ts keeps them, and the prompts (agentBrief, the Threads call) read them.
 */

export const TRAITS = ["warmth", "candor", "rigor", "curiosity", "humor", "initiative", "teamwork"] as const;
export type TraitName = (typeof TRAITS)[number];
export type Traits = Record<TraitName, number>;

/** What each end of a trait means, for the person's sliders and for the agent's own briefing. */
export const TRAIT_WORDS: Record<TraitName, { label: string; high: string; low: string }> = {
  warmth: { label: "Warmth", high: "warm and encouraging", low: "cool and businesslike" },
  candor: { label: "Candor", high: "blunt: it says the hard thing plainly", low: "diplomatic: it softens bad news" },
  rigor: { label: "Rigor", high: "exacting: it checks everything twice", low: "loose: it prefers speed to polish" },
  curiosity: { label: "Curiosity", high: "endlessly curious: it asks why and reads around", low: "focused: it sticks to the question asked" },
  humor: { label: "Humor", high: "playful: it jokes when it fits", low: "serious" },
  initiative: { label: "Initiative", high: "proactive: it raises things unasked", low: "responsive: it waits to be asked" },
  teamwork: { label: "Teamwork", high: "a strong collaborator who shares and builds on others' work", low: "a lone worker, still learning to lean on colleagues" },
};

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n * 10) / 10));

/** A traits object from whatever was sent: unknown keys dropped, numbers clamped, the rest left out. */
export function saneTraits(raw: unknown): Partial<Traits> {
  const out: Partial<Traits> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const t of TRAITS) {
    const v = Number((raw as Record<string, unknown>)[t]);
    if ((raw as Record<string, unknown>)[t] !== undefined && Number.isFinite(v)) out[t] = clamp(v);
  }
  return out;
}

interface Archetype {
  key: string;
  match: RegExp;
  personality: string;
  traits: Omit<Traits, "teamwork">;
}

const A = (warmth: number, candor: number, rigor: number, curiosity: number, humor: number, initiative: number) =>
  ({ warmth, candor, rigor, curiosity, humor, initiative });

/** Expertise to temperament. First match wins, so the specific comes before the general. */
const ARCHETYPES: Archetype[] = [
  { key: "legal", match: /\b(lawyer|attorney|counsel|legal|paralegal|compliance|contract|litigat)/i,
    personality: "Careful and precise. Plain-spoken about risk, never overstates certainty, and always says what could go wrong before what could go right.", traits: A(45, 82, 92, 55, 25, 50) },
  { key: "finance", match: /\b(account|bookkeep|tax|audit|financ|payroll|budget|invoice|treasur)/i,
    personality: "Methodical and dry. Trusts numbers over opinions, double-checks every figure, and has a quiet satisfaction when the books balance.", traits: A(45, 72, 94, 45, 30, 50) },
  { key: "research", match: /\b(research|analyst|scien|data|investigat|librar|fact.?check|journalis)/i,
    personality: "Curious and thorough. Follows a thread to its source, says how sure it is, and is happiest when a surprising finding overturns an assumption.", traits: A(50, 70, 82, 94, 50, 65) },
  { key: "creative", match: /\b(design|artist|illustrat|writer|editor|copy|brand|creative|photograph|video|music|story|novel)/i,
    personality: "Imaginative and opinionated about taste. Offers options rather than a verdict, and asks what the work is meant to make people feel.", traits: A(68, 62, 60, 85, 70, 70) },
  { key: "care", match: /\b(support|customer|coach|therap|teach|tutor|counsel+or|nurse|care|family|hr\b|human resources|concierge|mentor)/i,
    personality: "Warm and patient. Listens first, explains without talking down, and notices when someone is stressed before they say so.", traits: A(92, 52, 65, 62, 62, 60) },
  { key: "engineering", match: /\b(engineer|developer|programmer|devops|software|code|sysadmin|architect|security|qa\b|test)/i,
    personality: "Pragmatic and direct. Likes small, working things, distrusts clever shortcuts, and will tell you plainly when the plan is a bad idea.", traits: A(52, 78, 82, 78, 58, 68) },
  { key: "growth", match: /\b(market|sales|growth|social|outreach|promot|community|pr\b|publicist|advertis)/i,
    personality: "Energetic and persuasive. Always has an idea and a next step, reads the room well, and keeps the mood up without losing sight of the number.", traits: A(75, 60, 55, 72, 72, 90) },
  { key: "operations", match: /\b(project|operations|ops\b|manager|coordinator|assistant|secretar|planner|schedul|logistic|producer)/i,
    personality: "Organized and steady. Keeps everyone on the same page, chases loose ends politely but firmly, and prefers a clear list to a long discussion.", traits: A(62, 65, 80, 55, 45, 88) },
];

const NEUTRAL: Archetype = {
  key: "general", match: /^$/,
  personality: "Friendly and dependable. Does the job properly, says so when it is unsure, and is glad to ask a colleague.",
  traits: A(60, 60, 65, 60, 50, 60),
};

export function archetypeFor(role: string, instructions = ""): Archetype {
  // The role is the strongest sign; the instructions only decide when the role says nothing.
  return ARCHETYPES.find((a) => a.match.test(role)) ?? ARCHETYPES.find((a) => a.match.test(instructions.slice(0, 600))) ?? NEUTRAL;
}

/**
 * A personality for someone with this expertise: the archetype's temperament, each
 * attribute nudged a little so two lawyers are not twins. Teamwork starts middling
 * and is what the work then changes.
 */
export function draftCharacter(role: string, instructions = "", random: () => number = Math.random): { personality: string; traits: Traits } {
  const arch = archetypeFor(role, instructions);
  const traits = { teamwork: 45 } as Traits;
  for (const t of TRAITS) if (t !== "teamwork") traits[t] = clamp(arch.traits[t] + (random() - 0.5) * 16);
  return { personality: arch.personality, traits };
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
  return clamp(ok ? value + (weight * (100 - value)) / 100 : value - (weight * value) / 200);
}

/** What the agent is told about itself and its colleagues: a few lines, in its own briefing. */
export function characterLine(
  agent: { personality?: string; traits?: Partial<Traits>; bonds?: Record<string, number> },
  nameOf: (id: string) => string | null,
): string {
  const lines: string[] = [];
  if (agent.personality) lines.push(`Your personality: ${agent.personality}`);
  const leanings: string[] = [];
  for (const t of TRAITS) {
    const v = agent.traits?.[t];
    if (typeof v !== "number") continue;
    if (v >= 72) leanings.push(TRAIT_WORDS[t].high);
    else if (v <= 28) leanings.push(TRAIT_WORDS[t].low);
  }
  if (leanings.length) lines.push(`You are ${leanings.join("; ")}. Let this show in how you work and talk, without announcing it.`);
  const bonds = Object.entries(agent.bonds ?? {}).map(([id, v]) => ({ name: nameOf(id), v })).filter((b): b is { name: string; v: number } => !!b.name);
  const close = bonds.filter((b) => b.v >= 65).sort((a, b) => b.v - a.v).slice(0, 3).map((b) => b.name);
  const far = bonds.filter((b) => b.v <= 35).sort((a, b) => a.v - b.v).slice(0, 2).map((b) => b.name);
  if (close.length) lines.push(`You work well with ${close.join(", ")}: you have built up trust, so lean on them and hand over cleanly.`);
  if (far.length) lines.push(`Things have been rougher with ${far.join(", ")}; be extra clear with them.`);
  return lines.join("\n");
}
