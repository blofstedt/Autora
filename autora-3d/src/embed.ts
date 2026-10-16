/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { runHand, type HandApi } from './agentHand';
import { useEffect, useRef } from 'react';
import { Doc, parseDoc } from './core/doc';
import { setWho, show, type Cue, type Who } from './agentCursor';

/**
 * Autora 3D inside Autora's window.
 *
 * Autora opens this app in a frame (`?embed=autora`) beside the conversation and keeps the model on its server, so the
 * agent and the person work on one document. The frame and its parent talk by postMessage, both ways, and only to each other:
 *
 *   parent → frame   { autora3d: 'load', doc, cue? } the agent changed the model: show this one (with `cue`, the agent's
 *                                                    cursor goes to the tool and to the shape as it changes)
 *   parent → frame   { autora3d: 'theme', vars }   Autora's current colours (see `themeStyle`)
 *   frame → parent   { autora3d: 'ready' }         booted: send the model
 *   frame → parent   { autora3d: 'changed', doc }  the person changed the model
 *   parent → frame   { autora3d: 'hand', id, name, args, goal, need }  with Visible work on: do this tool call by hand
 *                    (agentHand.ts); `goal` is the model as the call leaves it, worked out by Autora, and `need` the
 *                    shapes and groups it names, which the hand waits for
 *   frame → parent   { autora3d: 'handed', id, did, skipped?, doc }  what the hand did, and the model as it now is
 *
 * Everything else (the tools, the geometry, the gestures) is the same app as on its own.
 */

/** Whether this page is Autora's frame rather than a page of its own. */
export const embedded = (): boolean => {
  try {
    return new URLSearchParams(window.location.search).get('embed') === 'autora' && window.parent !== window;
  } catch {
    return false;
  }
};

/** Autora's tokens (its `--bg`, `--s1`… custom properties) and the colour steps this app's classes read. */
const THEME_MAP: Record<string, string> = {
  '--color-slate-950': '--bg',
  '--color-slate-900': '--s1',
  '--color-slate-800': '--s2',
  '--color-slate-700': '--s4',
  '--color-slate-500': '--text-3',
  '--color-slate-400': '--text-2',
  '--color-slate-100': '--text',
  '--color-accent-400': '--accent-light',
  '--color-accent-500': '--accent',
  '--color-accent-600': '--accent-deep',
};

/** Which values Autora should send: the right-hand names above, read from its root element. */
export const THEME_TOKENS = Object.values(THEME_MAP);

/**
 * The style declarations that make this app wear Autora's current theme.
 * Takes whatever the parent sent and keeps only known tokens with plain colour values, so a message cannot inject CSS.
 */
export function themeStyle(vars: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!vars || typeof vars !== 'object') return out;
  const given = vars as Record<string, unknown>;
  for (const [prop, token] of Object.entries(THEME_MAP)) {
    const v = given[token];
    if (typeof v === 'string' && /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%/]+\))$/i.test(v.trim())) out[prop] = v.trim();
  }
  return out;
}

/** How long a burst of edits waits before it is sent up: one message per pause, not one per frame of a drag. */
const SEND_AFTER_MS = 250;

/**
 * Connects the app to Autora when it is a frame. `apply` shows a model the agent changed (as one undo step);
 * the document is sent up whenever the person changes it. A model that came down is never sent back up.
 */
export function useAutoraEmbed(
  doc: Doc,
  apply: (doc: Doc) => void,
  where?: (before: Doc, after: Doc) => { x: number; y: number } | null,
  /** What the agent's hand needs from the app (agentHand.ts): with it, the agent's tool calls can be done here by hand. */
  hand?: HandApi,
): void {
  const on = useRef(embedded()).current;
  const known = useRef<Doc | null>(null);
  /** Nothing goes up before the first model came down: the empty one this page starts with is not the person's work. */
  const loaded = useRef(false);
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const whereRef = useRef(where);
  whereRef.current = where;
  const handRef = useRef(hand);
  handRef.current = hand;

  useEffect(() => {
    if (!on) return;
    const origin = window.location.origin;
    const onMessage = (e: MessageEvent) => {
      if (e.source !== window.parent || e.origin !== origin) return;
      const m = e.data as { autora3d?: string; doc?: unknown; vars?: unknown; cue?: unknown; who?: unknown } | null;
      if (!m || typeof m !== 'object') return;
      if (m.autora3d === 'load') {
        const next = parseDoc(m.doc);
        if (!next) return;
        const before = known.current;
        known.current = next;
        loaded.current = true;
        const cue = m.cue as Cue | undefined;
        if (cue && typeof cue.tool === 'string' && before) {
          // The agent's cursor shows the change being made; the model is applied in the middle of it.
          void show({ tool: cue.tool, apply: () => applyRef.current(next), where: () => whereRef.current?.(before, next) ?? null });
        } else {
          applyRef.current(next);
        }
      } else if (m.autora3d === 'who') {
        // Whose cursor this is: an agent of the Organization's name, colour and shape, or Autora's own (null).
        const w = m.who as Partial<Who> | null;
        setWho(w && typeof w.name === 'string' && typeof w.color === 'string' && typeof w.rgb === 'string' && /^#[0-9a-f]{6}$/i.test(w.color) && /^[\d, ]+$/.test(w.rgb)
          ? { name: w.name.slice(0, 24), color: w.color, rgb: w.rgb, sides: Number(w.sides) || 3 } : null);
      } else if (m.autora3d === 'hand') {
        // Autora's agent, with Visible work on: its tool call done here with this app's own controls, then answered with
        // what was done and the model as it now is (its changes go up as a person's do, a moment after each).
        const h = m as { id?: unknown; name?: unknown; args?: unknown; goal?: unknown; need?: unknown };
        const api = handRef.current;
        if (typeof h.id !== 'string' || typeof h.name !== 'string' || !api) return;
        const id = h.id;
        void runHand(h.name, (h.args ?? {}) as Record<string, unknown>, api, h.goal ? parseDoc(h.goal) : null, Array.isArray(h.need) ? h.need.filter((x): x is string => typeof x === 'string') : []).then(async (result) => {
          await new Promise((r) => setTimeout(r, SEND_AFTER_MS + 150));
          window.parent.postMessage({ autora3d: 'handed', id, ...result, doc: api.doc() }, origin);
        });
      } else if (m.autora3d === 'theme') {
        for (const [prop, value] of Object.entries(themeStyle(m.vars))) document.documentElement.style.setProperty(prop, value);
      }
    };
    window.addEventListener('message', onMessage);
    window.parent.postMessage({ autora3d: 'ready' }, origin);
    return () => window.removeEventListener('message', onMessage);
  }, [on]);

  useEffect(() => {
    if (!on || !loaded.current || doc === known.current) return;
    // The model that came down, as the app keeps it, is not a change of the person's: sent back late it would undo a
    // change the agent made after it.
    const content = (d: Doc | null) => (d ? JSON.stringify([d.bodies, d.groups, d.repeats, d.library]) : '');
    if (content(doc) === content(known.current)) {
      known.current = doc;
      return;
    }
    const id = window.setTimeout(() => {
      known.current = doc;
      window.parent.postMessage({ autora3d: 'changed', doc }, window.location.origin);
    }, SEND_AFTER_MS);
    return () => window.clearTimeout(id);
  }, [on, doc]);
}
