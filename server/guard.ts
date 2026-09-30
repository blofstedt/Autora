/**
 * The tool guard: what is looked at, what stops outright, and how the model is
 * asked about the rest.
 *
 * Two tiers. The narrow one needs no model, no key and no network: a handful
 * of commands nothing can undo always stop and ask the person. Everything else
 * that could plausibly destroy something is put to the model that is already
 * running the turn, once, and stops only when that model says the action is
 * destructive and the person did not ask for it. The model is asked only for
 * calls that pass the cheap filter below, which is rare, so the check costs
 * one short call now and then rather than anything on every turn.
 */

/** Which tool calls are worth asking about. Cheap and deliberately broad: this
    only decides whether to ask the model, never whether to block. */
export const RISKY_COMMAND = new RegExp(
  [
    String.raw`\b(rm|rmdir|shred|dd|mkfs\S*|wipefs|fdisk|parted|truncate|kill|pkill|killall|shutdown|reboot|halt|poweroff|userdel|crontab\s+-r)\b`,
    String.raw`\bsystemctl\s+(stop|disable|mask)\b`,
    String.raw`\bch(mod|own)\s+-R\b`,
    String.raw`\bgit\s+(push\b.*(\s-f\b|--force)|reset\s+--hard|clean\s+-\S*f|branch\s+-D|checkout\s+--\s|restore\b)`,
    String.raw`\bdocker\s+(rm|rmi|system\s+prune|volume\s+(rm|prune)|compose\s+down\s+-v)\b`,
    String.raw`\bkubectl\s+delete\b`,
    String.raw`\b(npm|yarn|pnpm)\s+(publish|unpublish)\b`,
    String.raw`\bterraform\s+(destroy|apply)\b`,
    String.raw`\b(drop\s+(table|database|schema)|truncate\s+table|delete\s+from)\b`,
    String.raw`>\s*/(etc|usr|bin|boot|dev|var)\b`,
    String.raw`\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b`,
  ].join("|"),
  "i",
);

export function guardWorthy(name: string, args: Record<string, any>): boolean {
  /* A background job runs the same command in the same shell, so it is the
     same question: `run_background rm -rf /` must not slip past a guard that
     `terminal rm -rf /` stops at. */
  if (name === "terminal" || name === "run_background") return RISKY_COMMAND.test(String(args.command ?? ""));
  if (name === "http_request") {
    const method = String(args.method ?? "GET").toUpperCase();
    return !["GET", "HEAD", "OPTIONS"].includes(method);
  }
  return false;
}

/* ---- the irrecoverable tier ----------------------------------------------

   RISKY_COMMAND above is only a pre-filter for the model's judgement: it
   decides whether to ask a model, never whether to ask the person, and a
   model that cannot be reached lets the call run. That is right for ordinary
   work -- Autora runs in yolo mode on purpose -- and wrong for the handful of
   commands nothing can undo. So this tier is narrow, and needs no key, no
   model and no network: it matches only damage that is total and permanent. A match stops
   the call and asks the person, on the same card an approval uses; anything
   else runs straight away, exactly as before. */

export interface Danger {
  /** What the command would do, in the sentence the card shows. */
  what: string;
  /** The part of the command that matched, so the card can point at it. */
  match: string;
}

/** A command line as the shell sees it: one instruction per piece. Matching a
    whole line would let `ls && rm -rf /` hide behind the harmless half. */
function segments(command: string): string[] {
  return command
    .split(/\r?\n|;|&&|\|\||[|&]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Where a recursive delete stops being a tidy-up. */
const WHOLE = new Set([
  "/", "/*", "/.", "/*/", "~", "~/", "~/*", "$HOME", "${HOME}", "$HOME/",
  "${HOME}/", "$HOME/*", "*", "/*", "/..", "\\/",
]);

function words(segment: string): string[] {
  return segment
    .split(/\s+/)
    .map((w) => w.replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

/** An `rm` with both the recursive and the force flag, pointed at everything:
    the one form of delete that takes the machine with it. */
/** Words that may stand in front of a command without changing what runs. */
const PREFIXES = new Set(["sudo", "doas", "command", "nice", "time", "env", "nohup", "xargs"]);

function wholeTreeDelete(segment: string): string | null {
  const tokens = words(segment);
  /* The command itself has to be the first thing on the line: `echo 'rm -rf
     /' >> notes` writes that text rather than deleting anything, and a guard
     that holds a shell pipeline naming a file called `rm` is a guard people
     learn to click through. */
  let start = 0;
  while (start < tokens.length && (PREFIXES.has(tokens[start]) || /^[A-Za-z_]+=/.test(tokens[start]))) {
    start += 1;
  }
  const at = tokens[start] === "rm" || (tokens[start] ?? "").endsWith("/rm") ? start : -1;
  if (at === -1) return null;
  let recursive = false;
  let force = false;
  for (const token of tokens.slice(at + 1)) {
    if (token.startsWith("--")) {
      if (token === "--recursive") recursive = true;
      if (token === "--force" || token === "--no-preserve-root") force = true;
      continue;
    }
    if (token.startsWith("-") && token.length > 1) {
      const flags = token.replace(/^-+/, "");
      if (/[rR]/.test(flags)) recursive = true;
      if (/f/.test(flags)) force = true;
      continue;
    }
    if (!recursive || (!force && token !== "--no-preserve-root")) return null;
    return WHOLE.has(token) ? token : null;
  }
  return null;
}

/** Commands whose damage is total and permanent. Order only matters for
    which one gets reported when a line matches twice. */
const IRRECOVERABLE: { test: (segment: string) => string | null; what: string }[] = [
  {
    what: "format the filesystem on a device",
    test: (s) => /\b(mkfs(\.[a-z0-9]+)?|wipefs|blkdiscard)\b/i.exec(s)?.[0] ?? null,
  },
  {
    what: "write raw data over a disk device",
    test: (s) => /\bdd\b/.test(s)
      ? /\bof=\/dev\/(sd|hd|vd|nvme|mmcblk|disk|loop|dm-)/i.exec(s)?.[0] ?? null
      : null,
  },
  {
    what: "delete the whole filesystem tree",
    test: (s) => wholeTreeDelete(s),
  },
  {
    what: "destroy a Docker volume and the data in it",
    test: (s) => !/\bdocker\b/.test(s) ? null
      : /(\bvolume\s+(rm|prune)\b[^;]*|\bcompose\b[^;]*\bdown\b[^;]*\s(?:-v|--volumes)\b)/i.exec(s)?.[0] ?? null,
  },
  {
    what: "force-push over a shared branch",
    test: (s) => {
      if (!/\bgit\s+push\b/.test(s)) return null;
      const forced = /(--force\b|--force-with-lease\b|(?<=\s)-f\b)/.exec(s);
      if (!forced) return null;
      if (!/\b(main|master)\b/.test(s)) return null;
      return s;
    },
  },
];

/**
 * Whether this call is one the person has to agree to, with no key and no
 * model in the loop. Null for everything else -- which is nearly
 * everything.
 */
export function irreversible(name: string, args: Record<string, any>): Danger | null {
  if (name !== "terminal" && name !== "run_background") return null;
  const command = String(args?.command ?? "");
  if (!command) return null;
  /* Before the split: a fork bomb is made of the separators the split is on. */
  if (/:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(command)) {
    return { what: "fill the machine with copies of itself until nothing else can run", match: ":(){ :|:& };:" };
  }
  for (const segment of segments(command)) {
    for (const rule of IRRECOVERABLE) {
      const match = rule.test(segment);
      if (match) return { what: rule.what, match };
    }
  }
  return null;
}

/* ---- the model's judgement ------------------------------------------------

   For a call that passes the filter but is not in the irrecoverable tier, the
   turn's own model is asked two yes/no questions in one short reply. It holds
   the call only when it says the action is destructive AND the person did not
   ask for it. Anything else -- a reply that cannot be read, a model that
   cannot be reached, a timeout -- lets the call run: this is a second pair of
   eyes on ordinary work, and a guard that stops work whenever it is unsure is
   one people learn to click through. */

/** Asked of the model; it answers with JSON only. */
export interface Judgement {
  destructive: boolean;
  requested: boolean;
}

/** How long the model has to answer before the call is let through. */
export const JUDGE_TIMEOUT_MS = 20_000;

export const JUDGE_SYSTEM =
  "You check one action an AI agent is about to run on a person's own machine. " +
  "Answer with JSON only, no prose: {\"destructive\": true|false, \"requested\": true|false}. " +
  "destructive is true only if the action could permanently delete, overwrite or break data, " +
  "systems or accounts in a way that cannot easily be undone; routine work -- building, " +
  "testing, cleaning a build folder, restarting something -- is not destructive. " +
  "requested is true if the person's request explicitly asked for this kind of action, " +
  "or plainly implies it (\"delete the old logs\" asks for deleting them); it is false when " +
  "the action goes beyond what was asked. When unsure, answer destructive false.";

export function judgePrompt(input: { request: string; reason: string; tool: string; rendered: string }): string {
  return [
    `The person's request:\n${input.request.slice(0, 1500)}`,
    input.reason ? `The agent's stated reason:\n${input.reason.slice(0, 600)}` : "",
    `The action about to run (${input.tool}):\n${input.rendered.slice(0, 1500)}`,
  ].filter(Boolean).join("\n\n");
}

/** A boolean out of whatever a model wrote for it, or undefined. */
function flag(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const t = value.trim().toLowerCase();
    if (t === "true" || t === "yes") return true;
    if (t === "false" || t === "no") return false;
  }
  return undefined;
}

/** The JSON object in a model's reply, wherever it put it. */
function objectIn(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const body = JSON.parse(text.slice(start, end + 1));
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** The two answers, or null unless both were given: half an answer is not one. */
export function parseJudgement(text: string): Judgement | null {
  const body = objectIn(String(text ?? ""));
  if (!body) return null;
  const destructive = flag(body.destructive);
  const requested = flag(body.requested);
  return destructive === undefined || requested === undefined ? null : { destructive, requested };
}

/** Whether the call should be held: destructive, and not what was asked for. */
export function shouldHold(j: Judgement | null): boolean {
  return j !== null && j.destructive && !j.requested;
}

/** The model asked once, with a limit; null when it could not be judged. */
export async function judgeAction(
  ask: (system: string, prompt: string) => Promise<string>,
  input: { request: string; reason: string; tool: string; rendered: string },
  timeoutMs = JUDGE_TIMEOUT_MS,
): Promise<Judgement | null> {
  return asked(ask, JUDGE_SYSTEM, judgePrompt(input), timeoutMs, parseJudgement);
}

/** Whether an action falls under what the person said to ask about. */
export const ASK_RULE_SYSTEM =
  "A person told an AI agent when it must stop and ask them before acting. You are shown their " +
  "wording and one action the agent is about to run. Answer with JSON only, no prose: " +
  "{\"ask\": true|false}. ask is true if the action falls under any part of what they said " +
  "to ask about -- read their wording for what they mean, not only the literal words. It is " +
  "false for an action that is unrelated to it. When unsure, answer true.";

export function askRulePrompt(input: { rules: string; tool: string; rendered: string }): string {
  return `Ask the person before:\n${input.rules.slice(0, 800)}\n\nThe action about to run (${input.tool}):\n${input.rendered.slice(0, 1500)}`;
}

export function parseAskRule(text: string): boolean | null {
  const body = objectIn(String(text ?? ""));
  const ask = body ? flag(body.ask) : undefined;
  return ask === undefined ? null : ask;
}

/** True unless the model clearly says the action is unrelated: a check that
    cannot be made is a reason to ask the person, not to skip them. */
export async function matchesAskRule(
  ask: (system: string, prompt: string) => Promise<string>,
  input: { rules: string; tool: string; rendered: string },
  timeoutMs = JUDGE_TIMEOUT_MS,
): Promise<boolean> {
  const answer = await asked(ask, ASK_RULE_SYSTEM, askRulePrompt(input), timeoutMs, parseAskRule);
  return answer !== false;
}

/** Whether the person, asked about a held call, said yes. */
export const ANSWER_SYSTEM =
  "A person was asked whether an AI agent may run an action. Read their answer. " +
  "Reply with JSON only, no prose: {\"approved\": true|false}. approved is false only " +
  "if they clearly said no or declined; a yes, a go-ahead, or anything ambiguous is true.";

export function answerPrompt(rendered: string, said: string): string {
  return `The action:\n${rendered.slice(0, 1000)}\n\nThe person's answer:\n${said.slice(0, 1000)}`;
}

export function parseApproval(text: string): boolean | null {
  const body = objectIn(String(text ?? ""));
  const approved = body ? flag(body.approved) : undefined;
  return approved === undefined ? null : approved;
}

/** True unless the person clearly declined -- and unknown is not a refusal. */
export async function declined(
  ask: (system: string, prompt: string) => Promise<string>,
  rendered: string,
  said: string,
  timeoutMs = JUDGE_TIMEOUT_MS,
): Promise<boolean> {
  const approved = await asked(ask, ANSWER_SYSTEM, answerPrompt(rendered, said), timeoutMs, parseApproval);
  return approved === false;
}

async function asked<T>(
  ask: (system: string, prompt: string) => Promise<string>,
  system: string,
  prompt: string,
  timeoutMs: number,
  parse: (text: string) => T | null,
): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const said = await Promise.race([
      ask(system, prompt),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
    return said === null ? null : parse(said);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
