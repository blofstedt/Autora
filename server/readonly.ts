/**
 * Which calls of the program-like tools only look. Pure and tiny, so Plan mode
 * and the permission check (modes.ts) can ask without loading the tools.
 *
 * The rule is the same as for every tool: a call that is not known to be
 * looking is a change. A new action added to one of these tools is therefore
 * held back until it is added here on purpose.
 */

export const GIT_READ = new Set(["status", "diff", "log", "show", "blame", "branches", "stashes", "remotes"]);
export const LIBRARY_READ = new Set(["search", "list", "read"]);
/** Media actions that make nothing but text or pictures for the agent. */
export const MEDIA_READ = new Set(["info", "frames", "ocr", "transcribe"]);
export const FLOW_READ = new Set(["list", "show"]);

const action = (args: Record<string, any>) => String(args.action ?? "").trim().toLowerCase();

/** Whether one of these tools' calls only looks; null when `name` is not one of them. */
export function extraLooksOnly(name: string, args: Record<string, any>): boolean | null {
  switch (name) {
    case "git": return GIT_READ.has(action(args));
    case "library": return LIBRARY_READ.has(action(args));
    case "media": return MEDIA_READ.has(action(args));
    // The network log is a record of what already happened.
    case "browser_network": return true;
    case "browser_flow": return FLOW_READ.has(action(args));
    // Arbitrary code can do anything, like the terminal.
    case "python": return false;
    default: return null;
  }
}
