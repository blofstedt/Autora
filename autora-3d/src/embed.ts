/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef } from 'react';
import { Doc, parseDoc } from './core/doc';

/**
 * Autora 3D inside Autora's window.
 *
 * Autora opens this app in a frame (`?embed=autora`) beside the conversation and keeps the model on its server, so the
 * agent and the person work on one document. The frame and its parent talk by postMessage, both ways, and only to each other:
 *
 *   parent → frame   { autora3d: 'load', doc }     the agent changed the model: show this one
 *   parent → frame   { autora3d: 'theme', vars }   Autora's current colours (see `themeStyle`)
 *   frame → parent   { autora3d: 'ready' }         booted: send the model
 *   frame → parent   { autora3d: 'changed', doc }  the person changed the model
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
export function useAutoraEmbed(doc: Doc, apply: (doc: Doc) => void): void {
  const on = useRef(embedded()).current;
  const known = useRef<Doc | null>(null);
  /** Nothing goes up before the first model came down: the empty one this page starts with is not the person's work. */
  const loaded = useRef(false);
  const applyRef = useRef(apply);
  applyRef.current = apply;

  useEffect(() => {
    if (!on) return;
    const origin = window.location.origin;
    const onMessage = (e: MessageEvent) => {
      if (e.source !== window.parent || e.origin !== origin) return;
      const m = e.data as { autora3d?: string; doc?: unknown; vars?: unknown } | null;
      if (!m || typeof m !== 'object') return;
      if (m.autora3d === 'load') {
        const next = parseDoc(m.doc);
        if (!next) return;
        known.current = next;
        loaded.current = true;
        applyRef.current(next);
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
    const id = window.setTimeout(() => {
      known.current = doc;
      window.parent.postMessage({ autora3d: 'changed', doc }, window.location.origin);
    }, SEND_AFTER_MS);
    return () => window.clearTimeout(id);
  }, [on, doc]);
}
