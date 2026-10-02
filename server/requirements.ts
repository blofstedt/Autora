/**
 * What the person asked for, kept whole.
 *
 * A big message, or a conversation that keeps adding to one, is many asks, and
 * the to-do list the agent writes is its own reading of them: an ask it leaves
 * off the list is an ask nothing ever checks. The history is rebuilt from the
 * log as words and then folded into a summary, so an ask buried in a long
 * message is the first thing paraphrased away. This is the list that does not
 * lose them: each ask kept verbatim, in the person's words, with a status, and
 * amended in place when the person changes their mind -- an edit, a removal, a
 * new item -- rather than replaced.
 *
 * Like the to-do list and the ledger it lives in the log (`requirements.update`
 * holds the whole list as it now stands), is told to the agent every turn, and
 * holds no state of its own. Pure: a log in, a list or a briefing out.
 */

export type RequirementStatus = "open" | "done" | "dropped";

export interface Requirement {
  /** R1, R2... never reused, so "R3" means the same ask all chat long. */
  id: string;
  /** The ask, in the person's words. */
  text: string;
  status: RequirementStatus;
  /** How it was checked when done; why it was dropped. */
  note: string;
  /** Said in the first message, or added later while the conversation went on. */
  source: "request" | "amend" | "agent";
}

export interface RequirementList {
  items: Requirement[];
}

export interface RequirementEvent {
  kind: string;
  payload: Record<string, any>;
}

export interface RequirementResult {
  ok: boolean;
  summary: string;
  list?: RequirementList;
  preview?: string;
}

const MAX_TEXT = 700;
const MAX_NOTE = 240;
/** The list is kept to this many; finished ones go first when it is full. */
const MAX_ITEMS = 60;

const oneLine = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export function latestRequirements(events: readonly RequirementEvent[]): RequirementList {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].kind !== "requirements.update") continue;
    const raw = events[i].payload?.items;
    if (!Array.isArray(raw)) break;
    const items: Requirement[] = [];
    for (const r of raw) {
      const text = oneLine(r?.text, MAX_TEXT);
      const id = oneLine(r?.id, 12);
      if (!text || !id) continue;
      items.push({
        id,
        text,
        status: r?.status === "done" || r?.status === "dropped" ? r.status : "open",
        note: oneLine(r?.note, MAX_NOTE),
        source: r?.source === "amend" || r?.source === "agent" ? r.source : "request",
      });
    }
    return { items };
  }
  return { items: [] };
}

export const openRequirements = (list: RequirementList) => list.items.filter((r) => r.status === "open");

function nextId(list: RequirementList): string {
  let top = 0;
  for (const r of list.items) {
    const n = Number(/^R(\d+)$/.exec(r.id)?.[1] ?? 0);
    if (n > top) top = n;
  }
  return `R${top + 1}`;
}

/** Keep the list inside its limit by letting the oldest finished ones go. */
function trimmed(items: Requirement[]): Requirement[] {
  let out = items;
  while (out.length > MAX_ITEMS) {
    const at = out.findIndex((r) => r.status !== "open");
    if (at < 0) break;
    out = [...out.slice(0, at), ...out.slice(at + 1)];
  }
  return out;
}

export function addRequirements(
  list: RequirementList,
  texts: readonly string[],
  source: Requirement["source"],
): RequirementList {
  const items = [...list.items];
  const have = new Set(items.filter((r) => r.status === "open").map((r) => r.text.toLowerCase()));
  for (const t of texts) {
    const text = oneLine(t, MAX_TEXT);
    if (!text || have.has(text.toLowerCase())) continue;
    have.add(text.toLowerCase());
    items.push({ id: nextId({ items }), text, status: "open", note: "", source });
  }
  return { items: trimmed(items) };
}

const LIST_LINE = /^\s*(?:\d{1,2}[.)]|[-*•])\s+(\S.*)$/;

/**
 * The separate asks in a message that lists them: numbered or bulleted lines,
 * each kept as it was worded, with a line that continues the one above (an
 * indented line, or one that starts lower-case) joined to it. Two or more, or
 * nothing -- a message that is one sentence, or prose, is left for the agent to
 * read, because splitting prose without understanding it makes up asks.
 */
export function splitAsks(message: string): string[] {
  const asks: string[] = [];
  for (const raw of message.split(/\r?\n/)) {
    const m = LIST_LINE.exec(raw);
    if (m) {
      asks.push(m[1]);
    } else if (asks.length > 0 && raw.trim() && /^\s{2,}\S|^[a-z]/.test(raw)) {
      asks[asks.length - 1] += ` ${raw.trim()}`;
    }
  }
  return asks.length >= 2 ? asks : [];
}

/** A message that is conversation rather than a request. */
const CHATTER = /^(?:ok(?:ay)?|thanks?|thank you|great|nice|cool|yes|yep|no|nope|continue|go on|go ahead|keep going|proceed|stop|sure|perfect|good|done)\b[\s.!]*$/i;

/**
 * What a new message adds to the list without anyone reading it. A list in the
 * message becomes its items. A message that arrives while there is work open
 * is taken as a change to it and kept whole, so it cannot be lost; the agent
 * merges, edits or drops from there. Anything else (a first plain request, a
 * thank-you) is left to the agent, which is told to record the asks itself.
 */
export function autoAsks(message: string, list: RequirementList, duringWork: boolean): string[] {
  const text = message.trim();
  if (!text || CHATTER.test(text)) return [];
  const items = splitAsks(text);
  if (items.length > 0) return items;
  if ((duringWork || openRequirements(list).length > 0) && text.length >= 12) return [text];
  return [];
}

/**
 * One call to the tool. add takes new asks; edit rewrites one the person
 * changed; done says it is finished and how it was checked; drop says it is no
 * longer wanted and why. Called with nothing, it reads the list back.
 */
export function applyRequirements(prev: RequirementList, action: Record<string, any>): RequirementResult {
  const a = action ?? {};
  const touchedAny = ["add", "edit", "done", "drop", "reopen"].some((k) => a[k] !== undefined);
  if (!touchedAny) {
    return { ok: true, summary: prev.items.length ? describeRequirements(prev) : "No requirements are recorded yet." };
  }
  let list: RequirementList = { items: prev.items.map((r) => ({ ...r })) };
  const said: string[] = [];
  const problems: string[] = [];

  const asArray = (v: unknown): unknown[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
  const find = (id: unknown) => list.items.find((r) => r.id.toLowerCase() === String(id ?? "").trim().toLowerCase());

  const adds = asArray(a.add).map((x) => (typeof x === "string" ? x : String((x as any)?.text ?? "")));
  if (adds.length > 0) {
    const before = list.items.length;
    list = addRequirements(list, adds, "agent");
    said.push(`${list.items.length - before} added`);
  }
  for (const e of asArray(a.edit)) {
    const r = find((e as any)?.id);
    const text = oneLine((e as any)?.text, MAX_TEXT);
    if (!r || !text) { problems.push(`edit: no requirement ${JSON.stringify((e as any)?.id)} or no text`); continue; }
    r.text = text;
    if (r.status !== "open") r.status = "open";
    said.push(`${r.id} rewritten`);
  }
  for (const d of asArray(a.done)) {
    const id = typeof d === "string" ? d : (d as any)?.id;
    const r = find(id);
    if (!r) { problems.push(`done: no requirement ${JSON.stringify(id)}`); continue; }
    r.status = "done";
    r.note = oneLine(typeof d === "string" ? "" : (d as any)?.how, MAX_NOTE);
    said.push(`${r.id} done`);
  }
  for (const d of asArray(a.drop)) {
    const id = typeof d === "string" ? d : (d as any)?.id;
    const r = find(id);
    if (!r) { problems.push(`drop: no requirement ${JSON.stringify(id)}`); continue; }
    r.status = "dropped";
    r.note = oneLine(typeof d === "string" ? "" : (d as any)?.why, MAX_NOTE);
    said.push(`${r.id} dropped`);
  }
  for (const id of asArray(a.reopen)) {
    const r = find(id);
    if (!r) { problems.push(`reopen: no requirement ${JSON.stringify(id)}`); continue; }
    r.status = "open";
    r.note = "";
    said.push(`${r.id} reopened`);
  }
  const head = said.length ? `Requirements updated (${said.join(", ")}).` : "Nothing changed.";
  const bad = problems.length ? `\nNot applied: ${problems.join("; ")}.` : "";
  return {
    ok: said.length > 0 || problems.length === 0,
    list,
    summary: `${head}${bad}\n\n${describeRequirements(list)}`,
    preview: said.join(", ") || "no change",
  };
}

export function describeRequirements(list: RequirementList): string {
  if (list.items.length === 0) return "No requirements are recorded yet.";
  const mark = (r: Requirement) => (r.status === "done" ? "[done]" : r.status === "dropped" ? "[dropped]" : "[open]");
  return list.items
    .map((r) => `${r.id} ${mark(r)} ${r.text}${r.note ? ` -- ${r.note}` : ""}`)
    .join("\n");
}

/** What the agent is told every turn: the asks still open, word for word, and a count of the rest. */
export function requirementsBriefing(list: RequirementList): string | null {
  if (list.items.length === 0) return null;
  const open = openRequirements(list);
  const done = list.items.filter((r) => r.status === "done").length;
  const dropped = list.items.filter((r) => r.status === "dropped").length;
  const out = [
    "What the person has asked for, in their own words, kept for you (it is not summarised and does not fade from your notes). " +
      "A new message may add to it, change an item or remove one: record that with the requirements tool as it happens, " +
      "keeping the original wording of anything you do not change.",
  ];
  if (open.length > 0) out.push("Still to do:", ...open.map((r) => `- ${r.id}${r.source === "amend" ? " (added later)" : ""}: ${r.text}`));
  else out.push("Everything recorded is done or dropped.");
  if (done || dropped) out.push(`(${done} done, ${dropped} dropped -- requirements tool with no arguments lists them.)`);
  return out.join("\n");
}

/** Said once, when the agent is about to finish with asks still open. */
export function finishAudit(list: RequirementList): string | null {
  const open = openRequirements(list);
  if (open.length === 0) return null;
  return [
    "[Before you finish] These asks are not marked done:",
    ...open.map((r) => `- ${r.id}: ${r.text}`),
    "For each one: finish it now, or mark it done with how you checked it, or drop it with the reason " +
      "(the person changed their mind, or it cannot be done and why). Use the requirements tool, then " +
      "give your answer. Do not end with an ask silently skipped; if something is left undone, say so plainly.",
  ].join("\n");
}

/** Messages the person sent while the agent was working, told to it as one note. */
export function amendmentNote(messages: readonly string[]): string {
  const lines = messages.map((m) => `- ${JSON.stringify(m.length > 1500 ? `${m.slice(0, 1500)}...` : m)}`);
  return [
    `[The person added ${messages.length === 1 ? "this" : "these"} while you were working -- you were not stopped]`,
    ...lines,
    "Fold it into the work: it may add an ask, change one you are on, or take one away. Record it with the " +
      "requirements tool (add, edit or drop), adjust your plan if it changes it, and carry on from where you are. " +
      "Do not start over, and do not undo what is still wanted.",
  ].join("\n");
}
