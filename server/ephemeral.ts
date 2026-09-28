/**
 * The chat that is never written down.
 *
 * Its id is the only thing that says so, and every part of the app that would
 * otherwise file something -- the store (log, meta, tallies), the vault, the
 * memory graph, the spend ledger -- asks this one question about an id and
 * answers it the same way. It lives in a module of its own because the store
 * and the state file both need it, and the store already imports the state
 * file: a rule shared from either one would be a cycle.
 */

/** An incognito chat, and nothing else: the shape is off-limits by accident. */
const EPHEMERAL = /^session-incognito-[a-z0-9-]{1,90}$/;

export function isEphemeral(id: string): boolean {
  return EPHEMERAL.test(id);
}

/** A fresh id for one, in the same shape as any other session else. */
export function ephemeralId(): string {
  return `session-incognito-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
