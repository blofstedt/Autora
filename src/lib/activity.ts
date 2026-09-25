import { Kind, type AutoraEvent } from "./types";

/**
 * What the agent is doing right now, in a few words, for the line under the
 * thread that used to say only "working".
 *
 * The cards above it already show every command and page, so this is not a
 * second log: it is the one-line answer to "what is it on?" -- the request it
 * is thinking about before it has done anything, the step it is in the middle
 * of, or what it is mulling over between steps. Read from the event log alone,
 * so a reload mid-turn says the same thing as the page that watched it start.
 */
export function activity(events: AutoraEvent[]): string | null {
  // Only the turn in flight counts; everything before its request is history.
  let start = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const kind = events[i].kind;
    if (kind === Kind.AgentDone || kind === Kind.SessionEnded) return null;
    if (kind === Kind.UserMessage) { start = i; break; }
  }
  if (start < 0) return null;

  const request = String(events[start].payload?.text ?? "");
  const open = new Map<string, AutoraEvent>();
  let last: { name: string; args: Record<string, any>; failed: boolean } | null = null;
  let lastKind: string | null = null;
  let asking = false;

  for (let i = start + 1; i < events.length; i++) {
    const e = events[i];
    switch (e.kind) {
      case Kind.ToolCall:
        open.set(e.span ?? `seq-${e.seq}`, e);
        lastKind = e.kind;
        break;
      case Kind.ToolResult:
      case Kind.ToolError: {
        const call = open.get(e.span ?? "");
        if (call) {
          open.delete(e.span ?? "");
          last = {
            name: String(call.payload?.name ?? "tool"),
            args: call.payload?.args ?? {},
            failed: e.kind === Kind.ToolError || e.payload?.ok === false,
          };
        }
        lastKind = e.kind;
        break;
      }
      case Kind.AgentText:
        lastKind = e.kind;
        break;
      case Kind.AskRequest:
        asking = true;
        break;
      case Kind.AskAnswer:
        asking = false;
        break;
    }
  }

  if (asking) return "Waiting for your answer";
  const running = [...open.values()].pop();
  if (running) return doing(String(running.payload?.name ?? "tool"), running.payload?.args ?? {});
  if (lastKind === Kind.AgentText) return "Writing the reply";
  if (last) {
    return last.failed
      ? `Rethinking after ${failedWhat(last.name)} failed`
      : `Thinking over ${looked(last.name, last.args)}`;
  }
  const gist = brief(request, 6);
  return gist ? `Thinking about “${gist}”` : "Thinking";
}

/** The first few words of something, with an ellipsis if there was more. */
export function brief(text: string, words: number): string {
  const all = String(text ?? "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (all.length === 0) return "";
  const head = all.slice(0, words).join(" ").replace(/[.,;:!?]+$/, "");
  return all.length > words ? `${head}…` : head;
}

function host(url: unknown): string {
  try {
    return new URL(String(url)).hostname.replace(/^www\./, "");
  } catch {
    return String(url ?? "").slice(0, 40);
  }
}

function quoted(text: unknown, words = 5): string {
  const gist = brief(String(text ?? ""), words);
  return gist ? ` “${gist}”` : "";
}

/** A step in progress, as a person would say it. */
function doing(name: string, args: Record<string, any>): string {
  if (name.startsWith("mcp__")) return `Using ${name.split("__")[1] || "a connected tool"}`;
  if (name.startsWith("computer_")) return "Using the desktop";
  switch (name) {
    case "terminal": {
      const command = String(args.command ?? "").replace(/\s+/g, " ").trim();
      return command ? `Running ${command.length > 40 ? `${command.slice(0, 39)}…` : command}` : "Running a command";
    }
    case "browser_open": return args.url ? `Opening ${host(args.url)}` : "Opening a page";
    case "browser_read": return "Reading the page";
    case "browser_click": return "Clicking on the page";
    case "browser_fill": return "Filling in a form";
    case "browser_scroll": return "Scrolling the page";
    case "browser_press": return "Pressing keys on the page";
    case "browser_back": return "Going back a page";
    case "browser_screenshot": return "Looking at the page";
    case "browser_upload": return "Attaching a file";
    case "browser_captcha": return "Getting past a CAPTCHA";
    case "browser_handoff": return "Waiting for you in the browser";
    case "browser_signin_import": return "Importing a sign-in";
    case "http_request": return args.url ? `Fetching ${host(args.url)}` : "Fetching a page";
    case "web_search": return `Searching the web for${quoted(args.query)}`;
    case "image_generate": return "Drawing an image";
    case "widget_show": return args.title ? `Building “${brief(args.title, 6)}”` : "Building an explainer";
    case "ask_user": return "Waiting for your answer";
    case "speak": return "Speaking";
    case "artifact_save": return args.name ? `Saving ${args.name}` : "Saving a file";
    case "artifact_list": return "Looking through saved files";
    case "artifact_read": return "Reading a saved file";
    case "memory_write": return args.title ? `Remembering “${brief(args.title, 6)}”` : "Remembering something";
    case "memory_search": return `Searching its memory for${quoted(args.query)}`;
    case "memory_update":
    case "memory_forget": return "Tidying its memory";
    case "vault_read": return "Reading the vault";
    case "tool_create": return "Saving a new tool";
    case "tool_delete": return "Removing a tool";
    default: return `Using ${name.replace(/^custom_/, "").replace(/_/g, " ")}`;
  }
}

/** What a finished step handed back, for "Thinking over …". */
function looked(name: string, args: Record<string, any>): string {
  if (name === "terminal") return "the command's output";
  if (name === "web_search") return args.query ? `the results for${quoted(args.query)}` : "the search results";
  if (name === "http_request") return args.url ? `what ${host(args.url)} sent back` : "the response";
  if (name === "memory_search") return "what it remembers";
  if (name === "artifact_read" || name === "vault_read") return "the file";
  if (name === "artifact_list") return "the saved files";
  if (name === "ask_user") return "your answer";
  if (name === "image_generate") return "the image";
  if (name === "speak") return "what to say next";
  if (name.startsWith("browser_")) return "the page";
  if (name.startsWith("computer_")) return "the desktop";
  return "what it found";
}

function failedWhat(name: string): string {
  if (name === "terminal") return "a command";
  if (name.startsWith("browser_")) return "a page step";
  if (name === "web_search") return "a search";
  return "a step";
}
