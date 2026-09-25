/**
 * Slash commands: things typed into the box that are said to Autora itself
 * rather than to the agent.
 *
 * Kept free of React so what matches what can be tested on its own.
 */

export type CommandId =
  | "stop" | "new" | "retry" | "continue" | "remember" | "close" | "live"
  | "config" | "mind" | "cron" | "sessions" | "system";

export type Command = {
  id: CommandId;
  /** What is typed after the slash. */
  name: string;
  /** One line, shown beside it in the menu. */
  hint: string;
  /** Takes the rest of the line as its argument; picking it from the menu
      leaves the box open for that rather than running at once. */
  arg?: string;
  /** Only offered while a turn is running. */
  whileRunning?: boolean;
};

export const COMMANDS: Command[] = [
  { id: "stop", name: "stop", hint: "Stop the agent now", whileRunning: true },
  { id: "continue", name: "continue", hint: "Carry on from where it stopped" },
  { id: "retry", name: "retry", hint: "Send your last message again" },
  { id: "remember", name: "remember", hint: "Save something to memory", arg: "…" },
  { id: "new", name: "new", hint: "Start a new session" },
  { id: "close", name: "close", hint: "Close the browser" },
  { id: "live", name: "live", hint: "Start live voice chat" },
  { id: "sessions", name: "sessions", hint: "Open the session list" },
  { id: "mind", name: "mind", hint: "Open what Autora remembers" },
  { id: "cron", name: "cron", hint: "Open scheduled jobs and watchers" },
  { id: "config", name: "config", hint: "Open settings and API keys" },
  { id: "system", name: "system", hint: "Open status and logs" },
];

/** A draft read as a command: the name so far, and anything after it. */
export function parseCommand(draft: string): { name: string; arg: string; typingName: boolean } | null {
  const match = /^\/([a-z-]*)(?:(\s+)([\s\S]*))?$/i.exec(draft);
  if (!match) return null;
  return { name: match[1].toLowerCase(), arg: (match[3] ?? "").trim(), typingName: !match[2] };
}

/** What the menu offers for this draft: nothing unless the name is still
    being typed, and then the commands it could still become. */
export function suggest(draft: string, running: boolean): Command[] {
  const parsed = parseCommand(draft);
  if (!parsed || !parsed.typingName) return [];
  return COMMANDS
    .filter((c) => running || !c.whileRunning)
    .filter((c) => c.name.startsWith(parsed.name));
}

/** The command a finished draft names, if it names one exactly. A path like
    "/etc/hosts" or an unknown word is not a command and goes to the agent as
    written. */
export function resolve(draft: string): { command: Command; arg: string } | null {
  const parsed = parseCommand(draft.trim());
  if (!parsed) return null;
  const command = COMMANDS.find((c) => c.name === parsed.name);
  return command ? { command, arg: parsed.arg } : null;
}
