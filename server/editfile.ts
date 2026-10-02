/**
 * Changing a file so that someone else's edits to it survive.
 *
 * The agent used to write files with shell redirects and `sed`, which replace
 * whatever is on disk with what the agent believes is there -- so a change the
 * person saved a moment earlier was silently lost. This is the careful way: the
 * agent says what to replace, and if the file is no longer as the agent last saw
 * it, the two sets of changes are merged (server/merge3.ts) and written only if
 * they do not clash. A clash writes nothing and tells the agent what the person
 * did, so it can decide.
 */

import fs from "node:fs";
import path from "node:path";
import { merge3 } from "./merge3";

export interface TextEdit {
  old: string;
  new: string;
  /** Replace every place it occurs, not only one. */
  all?: boolean;
}

export interface EditArgs {
  path: string;
  edits?: TextEdit[];
  /** A whole file: to make a new one, or (with overwrite) to replace one. */
  content?: string;
  overwrite?: boolean;
}

export interface EditDeps {
  /** Where a relative path starts. */
  root: string;
  /** Folders that are never edited this way (Autora's own data). */
  protect: string[];
  /** The file as the agent last saw it, or null when that is not known. */
  base: (rel: string) => string | null;
  /** Why the person may be working on it now, or null. */
  held: (rel: string) => string | null;
}

export interface EditResult {
  ok: boolean;
  summary: string;
  /** What was written, for the caller to show. */
  wrote?: { path: string; created: boolean };
}

const MAX_BYTES = 1024 * 1024;

const count = (hay: string, needle: string) => (needle ? hay.split(needle).length - 1 : 0);

function apply(text: string, edits: TextEdit[]): { text: string } | { error: string } {
  let out = text;
  for (const [i, e] of edits.entries()) {
    if (typeof e.old !== "string" || e.old === "") return { error: `Edit ${i + 1} has no "old" text: say exactly what to replace.` };
    const n = count(out, e.old);
    if (n === 0) return { error: `Edit ${i + 1}: that text is not in the file.` };
    if (n > 1 && !e.all) return { error: `Edit ${i + 1}: that text is in ${n} places. Add more around it to pick one, or set all to replace every one.` };
    out = e.all ? out.split(e.old).join(String(e.new ?? "")) : out.replace(e.old, () => String(e.new ?? ""));
  }
  return { text: out };
}

/** The lines nearest to what the agent was looking for, to help it find the place. */
function hint(disk: string, edits: TextEdit[]): string {
  const squash = (t: string) => t.replace(/\s+/g, "");
  const want = squash(String(edits.find((e) => e?.old)?.old ?? "").split("\n").find((l) => l.trim().length > 3) ?? "").slice(0, 16);
  if (!want) return "";
  const lines = disk.split("\n");
  // Whitespace is ignored: a near miss is usually spacing or indentation.
  // The whole start of it first, then less and less: a line the person has
  // since changed still begins the same way.
  let at = -1;
  for (const len of [16, 12, 9, 7]) {
    at = lines.findIndex((l) => squash(l).includes(want.slice(0, len)));
    if (at >= 0) break;
  }
  if (at < 0) return "";
  return ` Near it the file has:\n${lines.slice(Math.max(0, at - 1), at + 2).map((l, i) => `  ${Math.max(0, at - 1) + i + 1}: ${l.slice(0, 120)}`).join("\n")}`;
}

export function editFile(args: EditArgs, deps: EditDeps): EditResult {
  const given = String(args.path ?? "").trim();
  if (!given) return { ok: false, summary: "Say which file: path." };
  const full = path.resolve(deps.root, given);
  const rel = path.relative(deps.root, full).split(path.sep).join("/") || given;
  if (deps.protect.some((p) => full === path.resolve(p) || full.startsWith(path.resolve(p) + path.sep))) {
    return { ok: false, summary: `${given} is Autora's own data, which is not edited this way.` };
  }
  let stat: fs.Stats | null = null;
  try {
    stat = fs.statSync(full);
  } catch {
    stat = null;
  }
  if (stat?.isDirectory()) return { ok: false, summary: `${given} is a folder.` };
  if (stat && stat.size > MAX_BYTES) return { ok: false, summary: `${given} is over 1 MB; edit it with the terminal.` };
  let disk: string | null = null;
  if (stat) {
    try {
      const data = fs.readFileSync(full);
      if (data.subarray(0, 4096).includes(0)) return { ok: false, summary: `${given} is not a text file.` };
      disk = data.toString("utf8");
    } catch (err) {
      return { ok: false, summary: `Could not read ${given}: ${String((err as Error).message).split("\n")[0]}` };
    }
  }

  const base = disk !== null ? deps.base(rel) : null;
  /** The file as the agent saw it, when the person has changed it since. */
  const diverged = disk !== null && base !== null && base !== disk;
  let ours: string;
  let note = "";
  /** The agent's edit only made sense against the file as it is now: it was working from that. */
  let fromDisk = false;

  if (typeof args.content === "string") {
    if (disk !== null && !args.overwrite) {
      return { ok: false, summary: `${given} already exists. Change it with edits, or set overwrite to replace the whole file.` };
    }
    if (args.content.length > MAX_BYTES) return { ok: false, summary: "That is over 1 MB: write it in parts with the terminal." };
    ours = args.content;
  } else if (Array.isArray(args.edits) && args.edits.length > 0) {
    if (disk === null) return { ok: false, summary: `There is no file ${given}. To make one, give content.` };
    const view = diverged ? base! : disk;
    let made = apply(view, args.edits);
    if ("error" in made && diverged) {
      // The agent may be working from the newer file: try it as the person left it.
      const direct = apply(disk, args.edits);
      if (!("error" in direct)) {
        made = direct;
        fromDisk = true;
      }
    }
    if ("error" in made) return { ok: false, summary: `${made.error}${hint(disk, args.edits)}` };
    ours = made.text;
  } else {
    return { ok: false, summary: "Give edits (what to replace with what) or content (a whole file)." };
  }

  let write = ours;
  if (diverged && disk !== null && !fromDisk) {
    /* The person changed the file since the agent last read it: put the two
       sets of changes together. (If the agent's edit only fits the newer file,
       it was working from that one, and is written as it stands.) */
    const merged = merge3(base!, ours, disk);
    if (merged.conflicts.length > 0) {
      const c = merged.conflicts[0];
      return {
        ok: false,
        summary:
          `Not written: the person changed ${given} since you last read it, and their change clashes with yours` +
          `${merged.conflicts.length > 1 ? ` in ${merged.conflicts.length} places` : ""}. Around line ${c.line}:\n` +
          `  you were changing:  ${c.base.slice(0, 4).map((l) => JSON.stringify(l.slice(0, 100))).join(" ")}\n` +
          `  you wanted:         ${c.ours.slice(0, 4).map((l) => JSON.stringify(l.slice(0, 100))).join(" ")}\n` +
          `  they have:          ${c.theirs.slice(0, 4).map((l) => JSON.stringify(l.slice(0, 100))).join(" ")}\n` +
          "Read the file as it is now, work with what they wrote, and make your change on top of it -- or leave it to them.",
      };
    }
    write = merged.text;
    note = merged.withTheirs ? " Their changes to the file since you last read it are kept alongside yours." : "";
  }

  const why = deps.held(rel);
  if (why && disk !== null) {
    note += " The person was working in this file moments ago and may still be: read it again before your next change.";
  }
  try {
    fs.mkdirSync(path.dirname(full), { recursive: true });
    const tmp = path.join(path.dirname(full), `.${path.basename(full)}.autora-${process.pid}.tmp`);
    fs.writeFileSync(tmp, write, { mode: stat ? stat.mode & 0o777 : 0o644 });
    fs.renameSync(tmp, full);
  } catch (err) {
    return { ok: false, summary: `Could not write ${given}: ${String((err as Error).message).split("\n")[0]}` };
  }
  const was = (disk ?? "").split("\n").length, now = write.split("\n").length;
  return {
    ok: true,
    wrote: { path: rel, created: disk === null },
    summary:
      `${disk === null ? "Created" : "Edited"} ${given}` +
      `${args.edits?.length ? ` (${args.edits.length} edit${args.edits.length === 1 ? "" : "s"})` : ""}: ${disk === null ? `${now} lines` : `${was} -> ${now} lines`}.${note}`,
  };
}
