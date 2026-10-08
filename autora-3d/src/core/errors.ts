/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/** A request an agent can fix: says what was wrong and, where it helps, what to try. */
export class AgentError extends Error {
  hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'AgentError';
    this.hint = hint;
  }
}

export const fail = (message: string, hint?: string): never => {
  throw new AgentError(message, hint);
};
