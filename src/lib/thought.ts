/**
 * The few words beside the agent's cursor: what it is doing, as it does it.
 *
 * Never a guess and never invented. Every phrase here is made from the act itself -- the tool call that is in flight
 * (`thoughtForTool`), or the browser's own description of the click, fill or page it is on (`thoughtFromAction`) -- so
 * the bubble can only say what the cursor is really doing, in the same breath. Short enough to read while it moves:
 * a gerund and the name of the thing, under `MAX` characters. Pure, so it can be tested, and shared with the server (the
 * browser draws its own pointer inside the page).
 */
import { Kind, type AutoraEvent } from "./types";

export const MAX = 34;

const clip = (t: string, n = MAX): string => {
  const one = t.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1).trimEnd()}…` : one;
};
const quote = (t: string, room: number): string => `“${clip(t, room)}”`;
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const host = (url: string): string => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return clip(url, 24); } };

/** What the browser says it is doing ("click [4] button "Add to cart""), as a thought. */
export function thoughtFromAction(action: string): string | null {
  const a = action.trim();
  let m: RegExpExecArray | null;
  if ((m = /^click \[\d+\]\s*(\w+)?\s*(?:"(.*)")?$/.exec(a))) return m[2] ? `Clicking ${quote(m[2], 22)}` : `Clicking the ${m[1] || "element"}`;
  if (/^(double-click|click) at /.test(a)) return a.startsWith("double") ? "Double-clicking here" : "Clicking here";
  if ((m = /^fill \[\d+\]\s*"(.*)"/.exec(a))) return m[1] ? `Filling in ${quote(m[1], 20)}` : "Filling in the field";
  if (a === "submit") return "Sending the form";
  if ((m = /^upload .* to \[\d+\]/.exec(a))) return "Attaching a file";
  if ((m = /^open (\S+)/.exec(a))) return `Opening ${clip(host(m[1]), 24)}`;
  if ((m = /^press (.+)/.exec(a))) return `Pressing ${clip(m[1], 20)}`;
  if (a === "navigated forward") return "Going forward";
  if (a === "back" || a === "navigated back") return "Going back";
  if (a === "reloaded page") return "Reloading the page";
  if (/^scroll/i.test(a)) return /up/i.test(a) ? "Scrolling up" : "Scrolling down";
  if (/^captcha: tick/.test(a)) return "Ticking the box";
  if (/^captcha: picture/.test(a)) return "Reading the pictures";
  if (/^cloudflare/.test(a)) return "Waiting for the check";
  return null;
}

const count = (v: unknown): number => (Array.isArray(v) ? v.length : 0);
const noun = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What an in-flight tool call is, as a thought; null for the ones that move nothing the person could point at. */
export function thoughtForTool(name: string, args: Record<string, any> = {}): string | null {
  switch (name) {
    case "browser_open": return str(args.url) ? `Opening ${clip(host(str(args.url)), 24)}` : "Opening a page";
    case "browser_click": return "Clicking";
    case "browser_fill": return count(args.values) > 1 ? `Filling in ${noun(count(args.values), "field")}` : "Filling in a field";
    case "browser_scroll": return "Scrolling";
    case "browser_press": return "Pressing a key";
    case "browser_back": return "Going back";
    case "browser_read": case "browser_screenshot": return "Looking at the page";
    case "web_search": return str(args.query) ? `Searching ${quote(args.query, 22)}` : "Searching";
    case "computer_click": return "Clicking on the desktop";
    case "computer_type": return "Typing on the desktop";
    case "computer_move": return "Moving over";
    case "terminal": case "run_background": return str(args.command) ? `Running ${quote(str(args.command).split("\n")[0], 22)}` : "Running a command";
    case "pdf_read": return "Reading the PDF";
    case "pdf_look": return Number.isInteger(args.pages) ? `Looking at page ${args.pages}` : "Looking at the page";
    case "pdf_edit": case "pdf_replace_text": return "Editing the PDF";
    case "pdf_redact": return "Redacting";
    case "pdf_pages": return "Rearranging pages";
    case "pdf_compose": return "Building the PDF";
    case "pdf_compress": return "Shrinking the PDF";
    case "office_read": return "Reading the document";
    case "office_look": return "Looking it over";
    case "office_edit": return count(args.ops) > 1 ? `Making ${noun(count(args.ops), "change")}` : "Making a change";
    case "office_check": return "Checking it";
    case "office_create": return "Starting a document";
    case "video_edit": return "Editing the video";
    case "video_ui": return str(args.label) ? `Using ${quote(args.label, 22)}` : "Using the editor";
    case "video_look": case "video_frame": return "Looking at the frame";
    case "video_import": return "Bringing in a clip";
    case "video_export": return "Exporting the video";
    case "studio_notes": return "Writing notes";
    case "studio_clip": return "Shaping a clip";
    case "studio_track": return "Setting up a track";
    case "studio_song": case "studio_make": return "Working on the song";
    case "studio_play": return "Playing it back";
    case "game_edit": return count(args.ops) > 1 ? `Making ${noun(count(args.ops), "change")}` : "Changing the game";
    case "game_look": return "Looking at the scene";
    case "photo_edit": return "Editing the picture";
    case "photo_look": return "Looking at the picture";
    case "app_preview": return str(args.text) ? "Typing in the app" : str(args.target) ? "Pointing at the app" : "Working in the app";
    case "edit_file": return "Editing a file";
    default:
      if (name.startsWith("cad_")) return "Shaping the model";
      return null;
  }
}

/** The tool call in flight in the turn now, if any: opened and not yet answered. */
export function liveTool(events: AutoraEvent[]): { name: string; args: Record<string, any>; seq: number } | null {
  const open = new Map<string, AutoraEvent>();
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e.kind === Kind.AgentDone || e.kind === Kind.SessionEnded || e.kind === Kind.UserMessage) break;
    if ((e.kind === Kind.ToolResult || e.kind === Kind.ToolError) && e.span) open.set(e.span, e);
    if (e.kind === Kind.ToolCall) {
      if (e.span && open.has(e.span)) continue;
      return { name: String(e.payload?.name ?? ""), args: e.payload?.args ?? {}, seq: e.seq };
    }
  }
  return null;
}
