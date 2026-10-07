/**
 * Working side by side: what the person is doing right now, and who has hold
 * of what.
 *
 * The agent and the person share a PDF, an app window, a browser and a folder
 * of code. Without a shared record the agent clicked on a page the person was
 * typing into, or rewrote a file they had just saved. This is that record, one
 * per chat, and three things come out of it:
 *
 *  - Leases. Whatever the person touches is theirs for a few seconds after
 *    their last touch: the agent is told it is held and goes on to something
 *    else, instead of overwriting it or being stopped by it.
 *  - Control. The person can take a whole surface (the app window, say) and
 *    hand it back; while they hold it the agent does not use it.
 *  - What they did. Said to the agent at its next step, once, in a line a
 *    collaborator would say ("they moved the signature"), so it can answer in
 *    kind and carry on without undoing it.
 *
 * Pure -- a clock in, text out -- so the rules are tested without a page.
 */

export type Surface = "pdf" | "office" | "app" | "browser" | "code";

const NAME: Record<Surface, string> = {
  pdf: "the PDF",
  office: "the document in the Office window",
  app: "the app window",
  browser: "the browser",
  code: "the code",
};

/** How long what they touched stays theirs after the last touch. */
export const LEASE_MS = 8_000;
/** Longer for a file: saving is not editing, and editing is slow. */
export const FILE_LEASE_MS = 20_000;
const KEEP = 80;

export interface Touch {
  at: number;
  surface: Surface;
  /** What on the surface: an object id, a file, or "*" for the whole of it. */
  subject: string;
  kind: string;
  /** In words: "moved the signature on page 1". */
  detail: string;
  /** Said to the agent at its next step. False for what is only a hold (a
      scroll, a hover, a selection). */
  tell: boolean;
  told: boolean;
}

interface PresenceView {
  /** Surfaces the person has taken. */
  held: Surface[];
  /** Surfaces they are using this moment. */
  active: Surface[];
}

const key = (surface: Surface, subject: string) => `${surface}\u0000${subject}`;

const age = (ms: number) => (ms < 4_000 ? "just now" : `${Math.round(ms / 1000)}s ago`);

export class Presence {
  private touches: Touch[] = [];
  private leases = new Map<string, number>();
  private held = new Set<Surface>();
  /** Control changes already said to the agent. */
  private toldHeld = new Set<Surface>();

  constructor(private readonly now: () => number = Date.now) {}

  /** The person did something. */
  touch(
    surface: Surface,
    subject: string,
    kind: string,
    detail: string,
    opts: { leaseMs?: number; tell?: boolean } = {},
  ): void {
    const at = this.now();
    const tell = opts.tell !== false;
    this.leases.set(key(surface, subject), at + (opts.leaseMs ?? (surface === "code" ? FILE_LEASE_MS : LEASE_MS)));
    // The same thing again, straight away, is one touch carried on.
    const last = this.touches[this.touches.length - 1];
    if (last && last.surface === surface && last.subject === subject && last.kind === kind && at - last.at < 2_000) {
      last.at = at;
      last.detail = detail;
      return;
    }
    this.touches.push({ at, surface, subject, kind, detail, tell, told: false });
    if (this.touches.length > KEEP) this.touches.splice(0, this.touches.length - KEEP);
  }

  /** The person takes a surface, or hands it back. */
  hold(surface: Surface, on: boolean): void {
    if (on) {
      this.held.add(surface);
      // Taking it is worth saying, even straight after handing it back.
      this.toldHeld.delete(surface);
    } else {
      this.held.delete(surface);
      this.leases.delete(key(surface, "*"));
      // If they took it and the agent was told, it is told that it is back
      // (see note); if the agent never heard of it, there is nothing to say.
    }
  }

  holding(surface: Surface): boolean {
    return this.held.has(surface);
  }

  private alive(surface: Surface, subject: string): number | null {
    const until = this.leases.get(key(surface, subject));
    if (until === undefined) return null;
    if (until <= this.now()) {
      this.leases.delete(key(surface, subject));
      return null;
    }
    return until;
  }

  /**
   * Why the agent must not act on this right now, in words it can act on; null
   * when it may. `subject` narrows it to one object or file; leave it out for
   * the surface as a whole.
   */
  blocked(surface: Surface, subject?: string): string | null {
    if (this.held.has(surface)) {
      return `The person has taken control of ${NAME[surface]}, so this was not done. Do not use ${NAME[surface]} until they hand it back; ` +
        "carry on with other work and say what you are leaving for them.";
    }
    const whole = this.alive(surface, "*");
    const one = subject && subject !== "*" ? this.alive(surface, subject) : null;
    if (whole === null && one === null) return null;
    const left = Math.max(whole ?? 0, one ?? 0) - this.now();
    const since = Math.max(0, LEASE_MS - left);
    return (
      `The person is working on ${subject && one !== null ? "that" : NAME[surface]} right now` +
      `${since < 60_000 ? ` (they touched it ${age(since)})` : ""}, so this was not done. ` +
      "Do something else and come back to it in a little while; do not retry it straight away."
    );
  }

  /** What the person did that the agent has not been told, once. Null when
      there is nothing. */
  note(): string | null {
    const now = this.now();
    const fresh = this.touches.filter((t) => t.tell && !t.told);
    const lines: string[] = [];
    for (const t of fresh) {
      t.told = true;
      lines.push(`- ${t.detail} (${age(now - t.at)})`);
    }
    for (const surface of this.held) {
      if (this.toldHeld.has(surface)) continue;
      this.toldHeld.add(surface);
      lines.push(`- They have taken control of ${NAME[surface]}. Do not use it until they hand it back; work on something else.`);
    }
    for (const surface of this.toldHeld) {
      if (this.held.has(surface)) continue;
      this.toldHeld.delete(surface);
      lines.push(`- They handed ${NAME[surface]} back to you.`);
    }
    if (lines.length === 0) return null;
    const shown = lines.slice(-8);
    return [
      "[The person, working alongside you:",
      ...shown,
      lines.length > shown.length ? `(and ${lines.length - shown.length} earlier)` : "",
      "Carry on with your task. What they changed is theirs: do not undo it, redo it or write over it -- work around it. " +
        "If it fits, say one short natural thing about it, the way a colleague at the same desk would.]",
    ].filter(Boolean).join("\n");
  }

  /** What they did lately, newest last, for the agent to react to. */
  recent(withinMs: number): Touch[] {
    const from = this.now() - withinMs;
    return this.touches.filter((t) => t.at >= from && t.tell);
  }

  /** The most recent thing they did, whatever it was. */
  last(): Touch | null {
    return this.touches[this.touches.length - 1] ?? null;
  }

  view(): PresenceView {
    const active = (["pdf", "office", "app", "browser", "code"] as Surface[]).filter((s) => {
      if (this.held.has(s)) return true;
      for (const k of this.leases.keys()) {
        if (!k.startsWith(`${s}\u0000`)) continue;
        const [, subject] = k.split("\u0000");
        if (this.alive(s, subject) !== null) return true;
      }
      return false;
    });
    return { held: [...this.held], active };
  }
}

// ---------------------------------------------------------- per chat --

const books = new Map<string, Presence>();

export function presenceFor(session: string): Presence {
  let p = books.get(session);
  if (!p) {
    p = new Presence();
    books.set(session, p);
  }
  return p;
}

export function forgetPresence(session: string): void {
  books.delete(session);
}
