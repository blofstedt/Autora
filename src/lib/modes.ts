/**
 * The two choices a chat carries, as the page knows them: how the agent works
 * (Build, Plan, Agent -- the selector in the message box) and what may run
 * without a yes (Yolo, Ask -- the selector in the header). The server decides
 * what each means (server/modes.ts); this is only what the page says. The
 * suggestions for "when to ask" are the same wording the server's checking
 * model reads, and tests/modes.test.ts holds the two files to each other.
 */
export type WorkMode = "build" | "plan" | "agent";
export type Permissions = "yolo" | "ask";

export const DEFAULT_WORK_MODE: WorkMode = "agent";
export const DEFAULT_PERMISSIONS: Permissions = "yolo";

export const WORK_MODES: { id: WorkMode; label: string; blurb: string }[] = [
  { id: "build", label: "Build", blurb: "Does the work straight away." },
  { id: "plan", label: "Plan", blurb: "Researches and writes a plan. Changes nothing." },
  { id: "agent", label: "Agent", blurb: "Plans first, then builds. Skips the plan for quick tasks." },
];

export const PERMISSIONS: { id: Permissions; label: string; blurb: string }[] = [
  { id: "yolo", label: "Yolo", blurb: "Calls run as they come. Only what nothing can undo stops to ask." },
  { id: "ask", label: "Ask", blurb: "Looking is free. Changes wait for your yes -- all of them, or only the ones you name." },
];

export const ASK_SUGGESTIONS: { id: string; label: string; rule: string }[] = [
  { id: "delete", label: "Deleting anything", rule: "deleting, overwriting or moving files, records or data" },
  { id: "send", label: "Sending messages", rule: "sending an email, chat message or post to anyone" },
  { id: "spend", label: "Spending money", rule: "spending money: purchases, paid API calls, subscriptions" },
  { id: "install", label: "Installing software", rule: "installing, updating or removing software or packages" },
  { id: "shell", label: "Running commands", rule: "running shell commands" },
  { id: "forms", label: "Forms and sign-ins", rule: "submitting forms, signing in or changing account settings on a website" },
  { id: "outside", label: "Outside the project", rule: "changing anything outside the current project or working folder" },
  { id: "network", label: "Anything that calls out", rule: "making requests that send data to another service" },
];

export const ASK_WHEN_MAX = 600;

/** Which suggestions the text already carries: a chip is "on" when its rule
    is in the words. */
export function hasRule(text: string, rule: string): boolean {
  return text.includes(rule);
}

/** Tap a chip: its rule goes into the words, or comes out of them. */
export function toggleRule(text: string, rule: string): string {
  if (hasRule(text, rule)) {
    return text
      .replace(rule, "")
      .replace(/(^|;\s*);?\s*/g, (_m, lead) => (lead ? "; " : ""))
      .replace(/^[;\s]+|[;\s]+$/g, "")
      .replace(/;\s*;/g, ";");
  }
  const base = text.trim().replace(/[;\s]+$/, "");
  return (base ? `${base}; ${rule}` : rule).slice(0, ASK_WHEN_MAX);
}
