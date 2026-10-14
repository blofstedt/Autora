/**
 * @-mentions in the message box: typing "@" offers the agents by name, and a message that names one is
 * put to that agent (the server starts it; see `mentionedAgents` in server/agents.ts).
 *
 * Kept free of React so what matches what can be tested on its own.
 */

export type Mentionable = { id: string; name: string; role: string };

/** The "@word" being typed just before the caret: where it starts and what has been typed after the @. */
export function mentionAt(text: string, caret: number): { from: number; query: string } | null {
  const before = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  const m = /(^|[^\w@.])@([\w-]{0,30})$/.exec(before);
  if (!m) return null;
  return { from: before.length - m[2].length - 1, query: m[2] };
}

/** The agents a query could be: those whose name starts with it first, then those with it inside a name or role. */
export function mentionMatches<T extends Mentionable>(agents: readonly T[], query: string, max = 6): T[] {
  const q = query.toLowerCase();
  const starts = agents.filter((a) => a.name.toLowerCase().startsWith(q));
  const rest = q
    ? agents.filter((a) => !starts.includes(a) && (a.name.toLowerCase().includes(q) || a.role.toLowerCase().includes(q)))
    : [];
  return [...starts, ...rest].slice(0, max);
}

/** The text with the "@word" at `from` replaced by the whole name and a space, and where the caret goes. */
export function applyMention(text: string, caret: number, from: number, name: string): { text: string; caret: number } {
  const insert = `@${name} `;
  const after = text.slice(caret);
  return { text: `${text.slice(0, from)}${insert}${after.startsWith(" ") ? after.slice(1) : after}`, caret: from + insert.length };
}
