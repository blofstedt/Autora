/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { AgentHost, ExecuteOptions, ToolResponse, execute } from './agent';
import { Doc, IdGen, counterIds, emptyDoc, settle } from './doc';
import { TOOL_SPECS, ToolSpec } from './tools';

/**
 * The whole modeller without a screen: a model, undo history and every tool an agent can call.
 * Runs in Node (scheduled jobs, hooks, servers) or in a browser tab.
 *
 *   const model = new Engine();
 *   const r = await model.execute('shape_add', { kind: 'box', width: 80, depth: 40, height: 30 });
 *   await model.execute('edge_bevel', { id: r.shapes![0].id, group: 'top', size: 4, style: 'round' });
 *   const stl = await model.execute('export', { format: 'stl' });
 */
export class Engine implements AgentHost {
  private doc: Doc;
  private past: Doc[] = [];
  private future: Doc[] = [];
  private rev = 0;
  private ids: IdGen;
  private listeners = new Set<(doc: Doc, revision: number) => void>();

  constructor(doc: Doc = emptyDoc()) {
    this.doc = settle(doc);
    this.ids = counterIds(this.doc);
  }

  /** The tools an agent may call, as JSON-Schema specs (for MCP, or an LLM's tool list). */
  static readonly tools: ToolSpec[] = TOOL_SPECS.filter((t) => !t.uiOnly);

  get tools(): ToolSpec[] {
    return Engine.tools;
  }

  getDoc = () => this.doc;
  revision = () => this.rev;
  newIds = () => this.ids;

  setDoc = (doc: Doc) => {
    if (doc === this.doc) return;
    this.past.push(this.doc);
    if (this.past.length > 200) this.past.shift();
    this.future = [];
    this.doc = settle(doc);
    this.ids = counterIds(this.doc, this.rev + 1);
    this.rev++;
    this.listeners.forEach((fn) => fn(this.doc, this.rev));
  };

  undo = () => {
    const prev = this.past.pop();
    if (!prev) return false;
    this.future.push(this.doc);
    this.doc = prev;
    this.rev++;
    this.listeners.forEach((fn) => fn(this.doc, this.rev));
    return true;
  };

  redo = () => {
    const next = this.future.pop();
    if (!next) return false;
    this.past.push(this.doc);
    this.doc = next;
    this.rev++;
    this.listeners.forEach((fn) => fn(this.doc, this.rev));
    return true;
  };

  /** Runs a tool. Never throws: errors come back as { ok: false, error, hint }. */
  execute(name: string, args: unknown = {}, options?: ExecuteOptions): Promise<ToolResponse> {
    return execute(this, name, args, options);
  }

  /** Be told whenever the model changes. Returns the way to stop. */
  subscribe(fn: (doc: Doc, revision: number) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  toJSON() {
    return { bodies: this.doc.bodies, groups: this.doc.groups, repeats: this.doc.repeats, library: this.doc.library };
  }
}
