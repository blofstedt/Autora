/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// The agent-facing surface of Autora 3D. No React, no DOM: import this from Node or from a browser.
export { Engine } from './engine';
export { execute } from './agent';
export type { AgentHost, ExecuteOptions, ToolResponse } from './agent';
export { TOOL_SPECS, toolByName } from './tools';
export type { ToolSpec } from './tools';
export { counterIds, emptyDoc, parseDoc, settle, starterDoc } from './doc';
export type { Doc, IdGen } from './doc';
export { AgentError } from './errors';
export { initManifold, manifoldReady } from '../utils/manifoldBoolean';
export type { ShapeSummary, SceneSummary } from './inspect';
