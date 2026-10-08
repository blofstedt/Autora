/**
 * Which window beside the chat the agent is working in, for Follow: the screen goes where the agent goes, and
 * stays out of the way once the person picks a tab themselves.
 *
 * Worked out from the newest tool call in the thread, so it needs nothing the server does not already say.
 */
import type { Bucket } from "./derive";

export type FollowPane = "app" | "pdf" | "video" | "cad" | "studio" | "pages" | "sheets" | "slides" | "browser";

/** An Office window as far as this needs it: which app, and the file it holds. */
export type OfficeLook = { pane: "pages" | "sheets" | "slides"; working?: string | null; name?: string | null };

const BROWSER = /^(browser_|web_search$|http_request$)/;
const APP = /^(preview_|app_)/;

/** The window a tool call works in, or null when it works in none (the terminal, memory, a search of files). */
export function paneForTool(name: string, args: Record<string, unknown>, offices: readonly OfficeLook[]): FollowPane | null {
  if (name.startsWith("pdf_")) return "pdf";
  if (name.startsWith("video_")) return "video";
  if (name.startsWith("cad_")) return "cad";
  if (name.startsWith("studio_")) return "studio";
  if (BROWSER.test(name)) return "browser";
  if (APP.test(name)) return "app";
  if (name.startsWith("office_")) {
    const said = Object.values(args).filter((v): v is string => typeof v === "string");
    const hit = offices.find((o) => said.some((v) => (o.working && v === o.working) || (o.name && v === o.name)));
    if (hit) return hit.pane;
    const ext = said.map((v) => /\.(docx|xlsx|pptx)\b/i.exec(v)?.[1]?.toLowerCase()).find(Boolean);
    if (ext) return ext === "docx" ? "pages" : ext === "xlsx" ? "sheets" : "slides";
    // One document open: that is the one.
    return offices.length === 1 ? offices[0].pane : null;
  }
  return null;
}

/** The window of the newest tool call that worked in one. */
export function lastWorkedPane(buckets: readonly Bucket[], offices: readonly OfficeLook[]): FollowPane | null {
  for (let b = buckets.length - 1; b >= 0; b--) {
    const cells = buckets[b].cells;
    for (let c = cells.length - 1; c >= 0; c--) {
      const cell = cells[c];
      if (cell.kind !== "tool") continue;
      const pane = paneForTool(cell.span.name, cell.span.args, offices);
      if (pane) return pane;
    }
  }
  return null;
}
