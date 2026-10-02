/**
 * What the agent knows about the job it is in the middle of.
 *
 * A turn's history is rebuilt from the log as words only, so everything the
 * agent worked out -- what it settled on, what it found in a file, what it was
 * about to do -- was gone the moment a turn was cut off. This is the memory
 * that does not go: a small ledger the agent keeps (goal, decisions, facts it
 * found, what comes next) and a record Autora keeps by itself of what was
 * touched (files, pages, documents).
 *
 * Like the to-do list it lives in the log (`ledger.update` holds the whole
 * ledger as it now stands), so it is as durable as the log is -- every event is
 * written to disk as it happens, which makes each round of tool calls a
 * checkpoint -- and nothing here holds state of its own. Pure: a log in, a
 * briefing out.
 */

export interface Ledger {
  goal: string;
  /** Choices made, and why, so they are not reopened. */
  decisions: string[];
  /** Things found out that cost a call to learn. */
  facts: string[];
  /** What to do next, in order. */
  next: string[];
}

export interface LedgerEvent {
  kind: string;
  payload: Record<string, any>;
}

export interface LedgerResult {
  ok: boolean;
  /** What the model is told came back. */
  summary: string;
  ledger?: Ledger;
  preview?: string;
}

const MAX_LINE = 240;
const LIMITS = { decisions: 12, facts: 20, next: 8 } as const;
/** How many touched things are listed. */
const MAX_TOUCHED = 14;
/** How far back into the log the touched list reads. */
const TOUCH_WINDOW = 400;

export const emptyLedger = (): Ledger => ({ goal: "", decisions: [], facts: [], next: [] });

const line = (value: unknown): string => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_LINE);

function lines(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : String(value).split(/\r?\n/);
  return list.map(line).filter(Boolean);
}

/** Add to a list without repeating, keeping the newest when it is full. */
function addTo(list: readonly string[], more: readonly string[], limit: number): string[] {
  const have = new Set(list.map((l) => l.toLowerCase()));
  const out = [...list];
  for (const m of more) {
    if (have.has(m.toLowerCase())) continue;
    have.add(m.toLowerCase());
    out.push(m);
  }
  return out.slice(-limit);
}

function readLedger(payload: Record<string, any> | undefined): Ledger {
  return {
    goal: line(payload?.goal),
    decisions: lines(payload?.decisions).slice(-LIMITS.decisions),
    facts: lines(payload?.facts).slice(-LIMITS.facts),
    next: lines(payload?.next).slice(0, LIMITS.next),
  };
}

/** The ledger as the log last wrote it, or empty. */
export function latestLedger(events: readonly LedgerEvent[]): Ledger {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].kind === "ledger.update") return readLedger(events[i].payload);
  }
  return emptyLedger();
}

const isEmpty = (l: Ledger) => !l.goal && !l.decisions.length && !l.facts.length && !l.next.length;

/**
 * One call to the tool. goal sets the goal; decided and learned add lines;
 * next replaces the list of what comes next; forget drops any line holding one
 * of the given words; reset starts again. A call with nothing in it reads the
 * ledger back.
 */
export function applyLedger(prev: Ledger, action: Record<string, any>): LedgerResult {
  const a = action ?? {};
  const touchedAny = ["goal", "decided", "learned", "next", "forget", "reset"].some((k) => a[k] !== undefined);
  if (!touchedAny) {
    return { ok: true, summary: isEmpty(prev) ? "The ledger is empty." : renderLedger(prev) };
  }
  let now: Ledger = a.reset === true ? emptyLedger() : { ...prev, decisions: [...prev.decisions], facts: [...prev.facts], next: [...prev.next] };
  if (a.goal !== undefined) now.goal = line(a.goal);
  now.decisions = addTo(now.decisions, lines(a.decided), LIMITS.decisions);
  now.facts = addTo(now.facts, lines(a.learned), LIMITS.facts);
  if (a.next !== undefined) now.next = lines(a.next).slice(0, LIMITS.next);
  const forget = lines(a.forget).map((f) => f.toLowerCase());
  if (forget.length > 0) {
    const keep = (l: string) => !forget.some((f) => l.toLowerCase().includes(f));
    now = { ...now, decisions: now.decisions.filter(keep), facts: now.facts.filter(keep), next: now.next.filter(keep) };
  }
  const said = [
    a.goal !== undefined ? "goal" : "",
    lines(a.decided).length ? `${lines(a.decided).length} decision${lines(a.decided).length === 1 ? "" : "s"}` : "",
    lines(a.learned).length ? `${lines(a.learned).length} fact${lines(a.learned).length === 1 ? "" : "s"}` : "",
    a.next !== undefined ? "next steps" : "",
    forget.length ? "forgot some" : "",
    a.reset === true ? "reset" : "",
  ].filter(Boolean).join(", ");
  return { ok: true, ledger: now, summary: `Ledger updated (${said}).\n\n${renderLedger(now)}`, preview: said };
}

export function renderLedger(l: Ledger): string {
  const out: string[] = [];
  if (l.goal) out.push(`Goal: ${l.goal}`);
  if (l.decisions.length) out.push("Decided:", ...l.decisions.map((d) => `- ${d}`));
  if (l.facts.length) out.push("Found out:", ...l.facts.map((f) => `- ${f}`));
  if (l.next.length) out.push("Next:", ...l.next.map((n, i) => `${i + 1}. ${n}`));
  return out.join("\n");
}

/**
 * What was touched, read off the calls themselves: files written or read by
 * name, pages opened, documents worked on. Newest last, each once, so after an
 * interrupt the agent can see which things it had its hands on without having to
 * remember.
 */
export function touched(events: readonly LedgerEvent[]): string[] {
  const seen = new Map<string, string>();
  const note = (key: string, text: string) => {
    seen.delete(key);
    seen.set(key, text);
  };
  const from = Math.max(0, events.length - TOUCH_WINDOW);
  for (let i = from; i < events.length; i += 1) {
    const e = events[i];
    const p = e.payload ?? {};
    if (e.kind === "file.edit" && typeof p.path === "string") {
      note(`f:${p.path}`, `${p.path} (${p.by === "person" ? "the person changed it" : p.created ? "created" : "edited"})`);
    } else if (e.kind === "tool.call") {
      const name = String(p.name ?? "");
      const args = (p.args ?? {}) as Record<string, any>;
      if ((name === "edit_file" || name === "read_file") && typeof args.path === "string") {
        note(`f:${args.path}`, `${args.path} (${name === "read_file" ? "read" : "edited"})`);
      } else if (name === "browser_open" && typeof args.url === "string") {
        note(`u:${args.url}`, `${args.url} (opened)`);
      } else if (name === "app_preview" && typeof args.url === "string") {
        note(`u:${args.url}`, `${args.url} (app window)`);
      } else if (/^pdf_/.test(name)) {
        const which = String(args.artifact ?? args.id ?? args.file ?? args.path ?? "").trim();
        if (which) note(`p:${which}`, `${which} (${name})`);
      }
    }
  }
  return [...seen.values()].slice(-MAX_TOUCHED);
}

/** What the agent is told every turn. Null when there is nothing to say. */
export function ledgerBriefing(ledger: Ledger, touchedList: readonly string[]): string | null {
  if (isEmpty(ledger) && touchedList.length === 0) return null;
  const out = ["Your working notes -- yours, kept across interruptions and restarts. Trust them; do not redo what they say is done."];
  if (!isEmpty(ledger)) out.push(renderLedger(ledger));
  if (touchedList.length > 0) out.push("Touched so far (recorded for you):", ...touchedList.map((t) => `- ${t}`));
  out.push("Keep them true with the ledger tool: record what you settle and find out as you go, and rewrite next as the plan changes.");
  return out.join("\n");
}
