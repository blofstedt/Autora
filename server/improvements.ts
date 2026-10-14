/**
 * Improvements: what an agent ran into that Autora should do better, written
 * down where the next agent (or person) will find it.
 *
 * When something fails because of Autora -- a tool that errors on a valid call,
 * a message that misleads, a capability that is missing, a prompt that sends a
 * model the wrong way -- the agent records it here instead of letting it vanish
 * with the chat. One markdown file per finding in `docs/improvements/` of the
 * repository, so any AI agent or person working on Autora can read them, pick
 * one up and mark it done, and the harness gets better and fits more models.
 *
 * It only writes a file. It never commits or pushes: that is for whoever works
 * on it. Without a checkout of the repository to write into (the container has
 * only the built app) the entry waits in this install's own inbox, and `file`
 * moves it into a checkout once one is known.
 *
 * A finding seen again is not written twice: the existing entry gets a line
 * saying where and on what model it happened, because "this fails on three
 * different models" is worth more than three copies of it.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const STATUSES = ["open", "taking-it", "done", "wontfix"] as const;
export type Status = (typeof STATUSES)[number];
const AREAS = ["tools", "prompt", "ui", "server", "agents", "browser", "files", "models", "docs", "other"] as const;
const SEVERITIES = ["low", "medium", "high"] as const;

/** Where entries live in a checkout. */
const FOLDER = path.join("docs", "improvements");

const MAX_TITLE = 120;
const MAX_FIELD = 2500;
const MAX_EVIDENCE = 3500;

interface Origin {
  /** The agent that found it: "Autora" for the lead. */
  by: string;
  /** "provider/model" it was running on. */
  model: string;
  /** The build of Autora it happened on. */
  version: string;
}

interface Finding {
  title: string;
  happened: string;
  evidence?: string;
  suggestion: string;
  area?: string;
  severity?: string;
}

interface Entry {
  file: string;
  id: string;
  title: string;
  status: Status;
  area: string;
  severity: string;
  seen: number;
  models: string[];
  versions: string[];
}

/** One line, no front-matter breaking characters. */
const oneLine = (text: string, max: number) => text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const block = (text: string | undefined, max: number) => (text ?? "").replace(/\u0000/g, "").trim().slice(0, max);

const slugOf = (title: string) =>
  title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "improvement";

const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "when", "not", "are", "was", "its", "into", "has", "have", "but"]);
const wordsOf = (text: string) => new Set((text.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []).filter((w) => !STOP.has(w)));

/** Whether two titles are about the same thing: most of the words of the shorter are in the other. */
function alike(a: string, b: string): boolean {
  const x = wordsOf(a), y = wordsOf(b);
  if (x.size < 2 || y.size < 2) return false;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared += 1;
  return shared / Math.min(x.size, y.size) >= 0.7;
}

// ------------------------------------------------------------ the folder --

/** The root of a checkout of Autora at or above `from`: a git working tree whose package.json is Autora's. */
function checkoutAbove(from: string): string | null {
  let dir = path.resolve(from);
  for (let i = 0; i < 8; i += 1) {
    try {
      if (fs.existsSync(path.join(dir, ".git")) && JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"))?.name === "autora") return dir;
    } catch { /* not this one */ }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** The checkout to write into: the one named, else the first of the places an agent works that is one. The built app in the
    container is not a checkout (no .git), so nothing is written into the image, where an update would lose it. */
export function findCheckout(candidates: readonly (string | undefined)[]): string | null {
  for (const c of candidates) {
    if (!c || !c.trim()) continue;
    const found = checkoutAbove(c.trim());
    if (found) return found;
  }
  return null;
}

const folderIn = (root: string) => path.join(root, FOLDER);

// ----------------------------------------------------------- reading one --

const FRONT = /^---\n([\s\S]*?)\n---\n?/;

function fields(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const m = FRONT.exec(text);
  if (!m) return out;
  for (const line of m[1].split("\n")) {
    const at = line.indexOf(":");
    if (at > 0) out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return out;
}

const list = (v: string | undefined) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);

function entryOf(file: string, text: string): Entry | null {
  const f = fields(text);
  if (!f.id) return null;
  const title = /^# (.+)$/m.exec(text.replace(FRONT, ""))?.[1]?.trim() ?? file;
  const status = (STATUSES as readonly string[]).includes(f.status) ? (f.status as Status) : "open";
  return { file, id: f.id, title, status, area: f.area || "other", severity: f.severity || "medium",
    seen: Math.max(1, Number(f.seen) || 1), models: list(f.models), versions: list(f.versions) };
}

/** Every entry in a folder, newest first by name. */
export function listEntries(dir: string): Entry[] {
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".md") && n.toLowerCase() !== "readme.md"); } catch { return []; }
  const out: Entry[] = [];
  for (const name of names.sort().reverse()) {
    try {
      const e = entryOf(name, fs.readFileSync(path.join(dir, name), "utf8"));
      if (e) out.push(e);
    } catch { /* an unreadable file is not an entry */ }
  }
  return out;
}

// ------------------------------------------------------------- recording --

const unique = (items: string[]) => [...new Set(items.filter(Boolean))];

function setFields(text: string, set: Record<string, string>): string {
  return text.replace(FRONT, (_all, body: string) => {
    const lines = body.split("\n").map((line) => {
      const key = line.slice(0, Math.max(0, line.indexOf(":"))).trim();
      return key in set ? `${key}: ${set[key]}` : line;
    });
    for (const key of Object.keys(set)) if (!lines.some((l) => l.startsWith(`${key}:`))) lines.push(`${key}: ${set[key]}`);
    return `---\n${lines.join("\n")}\n---\n`;
  });
}

interface Recorded {
  /** `new`: a file was written. `again`: it was already there and this sighting was added to it. */
  result: "new" | "again";
  file: string;
  dir: string;
  seen: number;
}

/**
 * Write a finding into `dir`, or add this sighting to the open one it repeats. `redact` scrubs secrets from every
 * word before it touches disk: an entry is read by other agents and may be committed.
 */
export function recordFinding(dir: string, f: Finding, origin: Origin, redact: (text: string) => string, now: Date = new Date()): Recorded {
  const title = oneLine(redact(f.title), MAX_TITLE);
  const happened = redact(block(f.happened, MAX_FIELD));
  const suggestion = redact(block(f.suggestion, MAX_FIELD));
  if (!title) throw new Error("Give the finding a short title.");
  if (!happened) throw new Error("Say what happened (happened).");
  if (!suggestion) throw new Error("Say what needs to improve (suggestion).");
  const evidence = redact(block(f.evidence, MAX_EVIDENCE));
  const area = (AREAS as readonly string[]).includes(String(f.area)) ? String(f.area) : "other";
  const severity = (SEVERITIES as readonly string[]).includes(String(f.severity)) ? String(f.severity) : "medium";
  const day = now.toISOString().slice(0, 10);
  const by = oneLine(redact(origin.by), 60) || "an agent";
  const model = oneLine(redact(origin.model), 80) || "unknown model";
  const version = oneLine(origin.version, 24) || "unknown";

  fs.mkdirSync(dir, { recursive: true });
  const twin = listEntries(dir).find((e) => (e.status === "open" || e.status === "taking-it") && alike(e.title, title));
  if (twin) {
    const file = path.join(dir, twin.file);
    let text = fs.readFileSync(file, "utf8");
    const seen = twin.seen + 1;
    text = setFields(text, {
      seen: String(seen), models: unique([...twin.models, model]).join(", "), versions: unique([...twin.versions, version]).join(", "),
    });
    const line = `- ${day} · ${model} · ${version} · ${by}${evidence ? `: ${oneLine(evidence, 240)}` : ""}`;
    text = /\n## Seen again\n/.test(text) ? `${text.replace(/\s+$/, "")}\n${line}\n` : `${text.replace(/\s+$/, "")}\n\n## Seen again\n${line}\n`;
    fs.writeFileSync(file, text);
    return { result: "again", file: twin.file, dir, seen };
  }

  const id = `imp-${day.replace(/-/g, "")}-${crypto.randomBytes(2).toString("hex")}`;
  const name = `${day}-${slugOf(title)}-${id.slice(-4)}.md`;
  const body = [
    "---",
    `id: ${id}`,
    "status: open",
    `area: ${area}`,
    `severity: ${severity}`,
    "seen: 1",
    `first: ${day}`,
    `models: ${model}`,
    `versions: ${version}`,
    `by: ${by}`,
    "---",
    `# ${title}`,
    "",
    "## What happened",
    happened,
    "",
    ...(evidence ? ["## Evidence", "```text", evidence.replace(/```/g, "'''"), "```", ""] : []),
    "## What needs to improve",
    suggestion,
    "",
  ].join("\n");
  fs.writeFileSync(path.join(dir, name), body, { flag: "wx" });
  return { result: "new", file: name, dir, seen: 1 };
}

/** Change an entry's status, with a line saying who and why. */
export function setStatus(dir: string, ref: string, status: Status, by: string, note: string, redact: (t: string) => string, now: Date = new Date()): Entry | null {
  const found = listEntries(dir).find((e) => e.id === ref || e.file === ref || e.file.replace(/\.md$/, "") === ref);
  if (!found) return null;
  const file = path.join(dir, found.file);
  let text = setFields(fs.readFileSync(file, "utf8"), { status });
  const said = oneLine(redact(note), 300);
  text = `${text.replace(/\s+$/, "")}\n\n## ${status === "taking-it" ? "Taken" : status === "done" ? "Done" : status === "wontfix" ? "Not doing" : "Reopened"}\n- ${now.toISOString().slice(0, 10)} · ${oneLine(redact(by), 60)}${said ? `: ${said}` : ""}\n`;
  fs.writeFileSync(file, text);
  return { ...found, status };
}

/** Move what waited in the inbox into a checkout. Names that are taken there are left where they are. */
export function moveInto(inbox: string, checkout: string): { moved: string[]; kept: string[] } {
  const into = folderIn(checkout);
  const moved: string[] = [];
  const kept: string[] = [];
  let names: string[] = [];
  try { names = fs.readdirSync(inbox).filter((n) => n.endsWith(".md")); } catch { return { moved, kept }; }
  fs.mkdirSync(into, { recursive: true });
  for (const name of names) {
    const to = path.join(into, name);
    if (fs.existsSync(to)) { kept.push(name); continue; }
    fs.copyFileSync(path.join(inbox, name), to);
    fs.unlinkSync(path.join(inbox, name));
    moved.push(name);
  }
  return { moved, kept };
}

export const checkoutFolder = folderIn;
