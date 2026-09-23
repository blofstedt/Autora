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
