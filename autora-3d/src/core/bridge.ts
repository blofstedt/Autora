/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { AgentHost, ExecuteOptions, ToolResponse, execute } from './agent';
import { Doc } from './doc';
import { TOOL_SPECS, ToolSpec } from './tools';

/** What the page offers an agent that is driving the live app (a script in the page, or a parent window embedding it). */
export interface Craft3DBridge {
  /** Every tool, as JSON-Schema specs. */
  tools: ToolSpec[];
  execute(name: string, args?: unknown, options?: ExecuteOptions): Promise<ToolResponse>;
  getDoc(): Doc;
  revision(): number;
  /** Be told after every change, whoever made it (a person at the screen, or an agent). */
  subscribe(fn: (doc: Doc, revision: number) => void): () => void;
}

declare global {
  interface Window {
    craft3d?: Craft3DBridge;
  }
}

/** A message from an embedding page: { craft3d: "call", id, tool, args?, ifRevision? }. The reply is { craft3d: "result", id, response }. */
interface CallMessage {
  craft3d: 'call';
  id: string | number;
  tool: string;
  args?: unknown;
  ifRevision?: number;
}

const isCall = (d: unknown): d is CallMessage =>
  !!d && typeof d === 'object' && (d as CallMessage).craft3d === 'call' && typeof (d as CallMessage).tool === 'string' && 'id' in (d as object);

/**
 * Puts the live app within reach of an agent: `window.craft3d`, and a postMessage protocol for pages that embed it.
 * Messages are only answered when they come from this page's own origin or an origin in `allowedOrigins`
 * (set VITE_CRAFT3D_ALLOWED_ORIGINS to a comma-separated list, or "*" to accept any embedder).
 */
export function installBridge(host: AgentHost, subscribe: Craft3DBridge['subscribe'], allowedOrigins: string[] = []): () => void {
  const bridge: Craft3DBridge = {
    tools: TOOL_SPECS,
    execute: (name, args, options) => execute(host, name, args, options),
    getDoc: () => host.getDoc(),
    revision: () => host.revision(),
    subscribe,
  };
  window.craft3d = bridge;

  const allowed = (origin: string) => origin === window.location.origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin);
  const onMessage = async (event: MessageEvent) => {
    if (!isCall(event.data) || !allowed(event.origin) || !event.source) return;
    const m = event.data;
    const response = await execute(host, m.tool, m.args, { ifRevision: m.ifRevision });
    (event.source as Window).postMessage({ craft3d: 'result', id: m.id, response }, { targetOrigin: event.origin });
  };
  window.addEventListener('message', onMessage);

  // Tell an embedding page we are ready, and what we can do (only to origins it was configured to trust).
  if (window.parent !== window) {
    allowedOrigins
      .filter((o) => o !== '*')
      .forEach((o) => window.parent.postMessage({ craft3d: 'ready', tools: TOOL_SPECS }, { targetOrigin: o }));
    if (allowedOrigins.includes('*')) window.parent.postMessage({ craft3d: 'ready', tools: TOOL_SPECS }, { targetOrigin: '*' });
  }

  return () => {
    window.removeEventListener('message', onMessage);
    if (window.craft3d === bridge) delete window.craft3d;
  };
}
