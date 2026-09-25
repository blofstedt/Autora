/**
 * Which tool calls the guard looks at.
 *
 * A cheap pre-filter, run on every call: only what passes it costs a Jev
 * decision. It decides whether to ask, never whether to block -- a match here
 * that is harmless is scored harmless and runs.
 */

/** Commands worth a second look. Cheap and deliberately broad: this only
    decides whether to ask Jev, never whether to block. */
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
  if (name === "terminal") return RISKY_COMMAND.test(String(args.command ?? ""));
  if (name === "http_request") {
    const method = String(args.method ?? "GET").toUpperCase();
    return !["GET", "HEAD", "OPTIONS"].includes(method);
  }
  return false;
}

/* ---- the irrecoverable tier ----------------------------------------------

   RISKY_COMMAND above is only a pre-filter for Jev: it decides whether to ask
   a model, never whether to ask the person, and with no Jev key the guard
   returns "off" and the call runs. That is right for ordinary work -- Autora
   runs in yolo mode on purpose -- and wrong for the handful of commands
   nothing can undo. So this tier is narrow, and needs no key, no model and no
   network: it matches only damage that is total and permanent. A match stops
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
 * Whether this call is one the person has to agree to, with no Jev, no key
 * and no model in the loop. Null for everything else -- which is nearly
 * everything.
 */
export function irreversible(name: string, args: Record<string, any>): Danger | null {
  if (name !== "terminal") return null;
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
