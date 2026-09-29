/**
 * How much this chat may do on its own.
 *
 * Autora runs in yolo mode on purpose: a call runs and is shown as it runs,
 * and only the handful of commands nothing can undo stop to ask. That is the
 * right default for a machine you are watching, and the wrong one for the two
 * moments that matter -- a chat where you want to see the plan before anything
 * is touched, and a chat where something is being changed for real.
 *
 * So the mode is a property of the chat, not of the install: set once for the
 * conversation you are in, shown in the header, and changed there. Nothing
 * here is a permission the agent can grant itself -- the mode is written by
 * the person, read by the server, and the agent is told what it is.
 *
 *  - plan  nothing changes. Every call that would is put to the person first,
 *          and the agent is told to lay out what it intends and stop there.
 *  - ask   looking is free, changing waits for a yes. Every call that changes
 *          anything raises the approval card, with no judgement call in it.
 *  - auto  the default, and what Autora has always done: calls run as they
 *          come. The guard's standing agreements and the irrecoverable tier
 *          still stop and ask, and this mode does not touch either.
 */

export type ChatMode = "plan" | "ask" | "auto";

export const DEFAULT_CHAT_MODE: ChatMode = "auto";

export interface ModeInfo {
  id: ChatMode;
  /** What the pill says. */
  short: string;
  /** What the menu says. */
  label: string;
  /** One line, for the menu and the settings page. */
  blurb: string;
}

export const MODES: Record<ChatMode, ModeInfo> = {
  plan: {
    id: "plan",
    short: "Plan",
    label: "Plan only",
    blurb: "Nothing is changed. Every call that would change something is put to you first, and the agent says what it intends before it starts.",
  },
  ask: {
    id: "ask",
    short: "Ask",
    label: "Ask first",
    blurb: "Looking is free. Anything that writes, runs or sends waits for your yes on the card.",
  },
  auto: {
    id: "auto",
    short: "Auto",
    label: "Auto",
    blurb: "The default: calls run as they come, and are shown in the thread as they happen. Standing agreements apply, and nothing irreversible runs without your answer.",
  },
};

export const CHAT_MODES: ChatMode[] = ["plan", "ask", "auto"];

export function isChatMode(value: unknown): value is ChatMode {
  return value === "plan" || value === "ask" || value === "auto";
}

/** Whatever was stored, as a mode: an older build's session, or a hand-edited
    file, must not be able to leave the chat in a mode that does not exist. */
export function chatMode(value: unknown): ChatMode {
  return isChatMode(value) ? value : DEFAULT_CHAT_MODE;
}

/**
 * Calls that only look.
 *
 * The list is deliberately short and every entry is deliberate: a tool is here
 * because it cannot change anything outside the console's own record of what
 * it has seen. Opening a page and reading it is looking; filling a form on it
 * is not. Listing the directory is looking; running the command in it is not.
 *
 * A tool that is not on this list is treated as a change, which is the safe
 * way round: a new tool added later asks until somebody decides it only looks.
 */
const LOOKS_ONLY = new Set([
  "browser_open",
  "browser_read",
  "browser_scroll",
  "browser_screenshot",
  "browser_back",
  "browser_captcha",
  "background_jobs",
  "background_output",
  "schedules",
  "pre_authorisations",
  "inventory",
  "memory_search",
  "memory_confirm",
  "vault_read",
  "artifact_list",
  "artifact_read",
  "mcp_servers",
  "web_search",
  "camera_look",
  "computer_screenshot",
  "browser_status",
  "speak",
  "widget_show",
]);

/** Whether this exact call can change anything. GET and HEAD cannot; a POST
    to somebody's API can, so http_request is judged on its method. */
export function looksOnly(name: string, args: Record<string, any> = {}): boolean {
  if (name === "http_request") {
    const method = String(args.method ?? "GET").toUpperCase();
    return method === "GET" || method === "HEAD" || method === "OPTIONS";
  }
  return LOOKS_ONLY.has(name);
}

export interface ModeGate {
  /** Held for the person's answer before it runs. */
  ask: boolean;
  /** What the card says, in the mode's own words. */
  why: string;
}

/**
 * What this chat's mode says about one call: whether it waits for an answer,
 * and the sentence that explains why. Null means the mode adds nothing here --
 * the call runs as it always would, and the guard and the irrecoverable tier
 * go on doing their own work further down.
 */
export function modeGate(mode: ChatMode, name: string, args: Record<string, any> = {}): ModeGate | null {
  if (mode === "auto") return null;
  if (looksOnly(name, args)) return null;
  if (mode === "plan") {
    return {
      ask: true,
      why: "This chat is in Plan mode: nothing is changed here without you saying so, and " +
        "this call would change something. If it should run, allow it; if this is the work " +
        "you meant by yes, say what you would do and let the answer come on the card.",
    };
  }
  return {
    ask: true,
    why: "This chat is in Ask mode: looking is free, and anything that changes something " +
      "waits for you. Nothing behind your back.",
  };
}

/** What the turn is told about its own mode. Null in auto, where there is
    nothing to say that is not already true of every turn. */
export function modeBriefing(mode: ChatMode, incognito = false): string | null {
  if (mode === "auto") return null;
  const head = incognito
    ? `This chat is in ${MODES[mode].label} mode and is incognito.`
    : `This chat is in ${MODES[mode].label} mode, chosen by the person for this conversation.`;
  if (mode === "plan") {
    return [
      head,
      "Nothing is to be changed: no file written, no command that changes anything, no message sent, no form submitted. Reading, looking and searching are all allowed, and are usually what the plan needs.",
      "Work out what you would do and say it -- the files you would touch, the commands you would run, the order, and what could go wrong. Then stop. A call that would change something is held for the person as you try it, so trying it costs a round trip and produces a card reading like a mistake; say the plan instead, and let them take the chat out of Plan mode when they are ready.",
    ].join("\n");
  }
  return [
    head,
    "Looking (reading pages, files, search, the state of things) runs straight away. Anything that changes something -- a command, an edit, a form, a message -- is held on a card for the person before it runs.",
    "So say what you are about to do in one line before the call, keep each call to the one thing being asked about, and do not retry something that comes back refused.",
  ].join("\n");
}
