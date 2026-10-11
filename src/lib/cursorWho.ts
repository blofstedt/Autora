/**
 * Whose cursor it is.
 *
 * Autora's own is the triangle in the theme's accent. When an agent of the Organization is started it works in a chat
 * of its own, and in that chat every cursor (the pointer in the PDF, Office, Video, Music, Game, Photo and Terminal
 * windows, the one drawn into the browser's page and the one in the 3D frame) is that agent's: its name on the tag,
 * its colour on the arrow, the press ring and the few words beside it, and its shape (the same polygon as its mark)
 * beside the name. One place says who, read from the chat's own log, so the windows cannot disagree.
 */
import { useSyncExternalStore } from "react";
import { lookColors, readLook, type AgentLook } from "./agentlook";
import { Kind, type AutoraEvent } from "./types";

export type CursorWho = { name: string; look: AgentLook | null };

const AUTORA: CursorWho = { name: "Autora", look: null };
let who: CursorWho = AUTORA;
const listeners = new Set<() => void>();

export function getCursorWho(): CursorWho {
  return who;
}

/** The colours a cursor wears: Autora's follow the theme (the accent variables), an agent's are its own, for the places that cannot read them. */
export function whoColors(w: CursorWho = who): { accent: string; rgb: string } | null {
  if (!w.look) return null;
  const { colors, css } = lookColors(w.look);
  return { accent: colors.accent, rgb: css["--accent-rgb"] };
}

/** Lay the cursor's colours on the page: `--agent-accent` and `--agent-accent-rgb`, which every cursor's styles read. */
function paint(w: CursorWho) {
  const root = document.documentElement.style;
  const c = whoColors(w);
  if (c) { root.setProperty("--agent-accent", c.accent); root.setProperty("--agent-accent-rgb", c.rgb); }
  else { root.removeProperty("--agent-accent"); root.removeProperty("--agent-accent-rgb"); }
}

export function setCursorWho(next: CursorWho) {
  if (next.name === who.name && next.look?.sides === who.look?.sides && next.look?.hue === who.look?.hue) return;
  who = next;
  if (typeof document !== "undefined") paint(next);
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const useCursorWho = (): CursorWho => useSyncExternalStore(subscribe, getCursorWho, getCursorWho);
export const onCursorWho = (fn: () => void) => subscribe(fn);

/** Who the chat's agent is, from its log: the line the server writes when an agent of the Organization is started in it. Autora otherwise. */
export function whoFromEvents(events: AutoraEvent[]): CursorWho {
  for (const e of events) {
    if (e.kind === Kind.Log && e.payload?.event === "agent.started") {
      const name = String(e.payload.name ?? "").trim();
      if (name) return { name: name.slice(0, 24), look: readLook(e.payload.look) };
    }
    if (e.seq > 40) break; // it is among the first lines a chat has
  }
  return AUTORA;
}

/** The corners of an n-sided shape of radius `r` around (r, r), pointing up, as an SVG `points` value: the agent's mark, small. */
export function glyphPoints(sides: number, r = 5): string {
  const n = Math.max(3, Math.round(sides));
  return Array.from({ length: n }, (_, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    return `${(r + r * Math.cos(a)).toFixed(2)},${(r + r * Math.sin(a)).toFixed(2)}`;
  }).join(" ");
}
