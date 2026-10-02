/**
 * What to try instead, for the mistakes an agent makes most.
 *
 * A call that fails because a name was a little off -- a path with the wrong
 * folder, text that is spelled slightly differently on the page -- costs a
 * round trip to learn what was nearby, and often several guesses. The nearest
 * real things are known to the machine at the moment of failure, so they are
 * said in the failure. Pure string and folder work: no model, nothing written.
 */

import fs from "node:fs";
import path from "node:path";

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", "target", "venv", ".venv", "__pycache__", ".cache", "coverage"]);
const MAX_WALK = 6000;

/** Edit distance, cut off: past `limit` it only says "far". */
function distance(a: string, b: string, limit = 40): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

const squash = (s: string) => s.toLowerCase().replace(/[\s_\-.]+/g, "");

/** How alike two strings are, 0 to 1: edit distance, with a bonus for one holding the other. */
export function likeness(a: string, b: string): number {
  const x = squash(a), y = squash(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const longest = Math.max(x.length, y.length);
  let score = 1 - distance(x.slice(0, 120), y.slice(0, 120)) / Math.min(120, longest);
  if (x.includes(y) || y.includes(x)) score = Math.max(score, 0.6 + 0.4 * (Math.min(x.length, y.length) / longest));
  return Math.max(0, score);
}

/** The few candidates most like the target, best first, none below a floor. */
export function nearest(candidates: readonly string[], target: string, count = 3, floor = 0.45): string[] {
  const seen = new Set<string>();
  return candidates
    .filter((c) => (seen.has(c) ? false : (seen.add(c), true)))
    .map((c) => ({ c, s: likeness(c, target) }))
    .filter((x) => x.s >= floor)
    .sort((p, q) => q.s - p.s)
    .slice(0, count)
    .map((x) => x.c);
}

/** Files under a folder, as paths from it. */
function walk(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    if (out.length >= MAX_WALK) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".github") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) visit(full);
      } else if (e.isFile() && !/^\.env/.test(e.name)) out.push(path.relative(root, full).split(path.sep).join("/"));
      if (out.length >= MAX_WALK) return;
    }
  };
  visit(root);
  return out;
}

/**
 * Where a path that is not there probably is. A file with the same name in
 * another folder comes first, then names that are close; a missing folder is
 * answered with what the nearest real folder holds.
 */
export function nearestPaths(root: string, missing: string, count = 4): string[] {
  const wanted = missing.replace(/^[./]+/, "").split(path.sep).join("/");
  if (!wanted) return [];
  const base = path.posix.basename(wanted);
  const files = walk(root);
  const sameName = files.filter((f) => path.posix.basename(f) === base && f !== wanted);
  const close = nearest(files.map((f) => f), wanted, count + 2, 0.5)
    .concat(nearest([...new Set(files.map((f) => path.posix.basename(f)))], base, 3, 0.6).flatMap((b) => files.filter((f) => path.posix.basename(f) === b)));
  return [...new Set([...sameName, ...close])].filter((f) => f !== wanted).slice(0, count);
}

/** A sentence for a missing path, or "" when nothing is near. */
export function pathHint(root: string, missing: string): string {
  const near = nearestPaths(root, missing);
  return near.length ? ` Nearby: ${near.join(", ")}.` : "";
}

/** The path a shell error says is missing, if it says one. */
export function missingPathIn(output: string): string | null {
  const m =
    /(?:cannot (?:access|open|stat|read)|can't open file|no such file or directory|not found)[:\s]*['"`‘]?([\w@%+=.,~/\\-]+(?:\/[\w@%+=.,~-]+|\.[A-Za-z0-9]{1,6}))['"`’]?/i.exec(output) ??
    /([\w@%+=.,~/-]+(?:\/[\w@%+=.,~-]+|\.[A-Za-z0-9]{1,6})):\s*No such file or directory/i.exec(output);
  const found = m?.[1];
  return found && found.length > 2 && !/^(?:command|bash|sh)$/i.test(found) ? found : null;
}

/** Text from a page or a document that reads most like what was looked for. */
export function similarText(lines: readonly string[], wanted: string, count = 3): string[] {
  const w = wanted.trim();
  if (!w) return [];
  // A long line is compared where it matches best, not as a whole.
  const windows: string[] = [];
  for (const l of lines) {
    const t = l.replace(/\s+/g, " ").trim();
    if (!t) continue;
    if (t.length <= w.length * 2 + 10) windows.push(t);
    else {
      const words = t.split(" ");
      const n = Math.max(1, w.split(/\s+/).length);
      for (let i = 0; i + n <= words.length; i += 1) windows.push(words.slice(i, i + n).join(" "));
    }
  }
  return nearest(windows, w, count, 0.55);
}

/** "Did you mean ..." for a list of options, or "". */
export function didYouMean(options: readonly string[], wanted: string): string {
  const near = nearest(options, wanted, 3, 0.4);
  return near.length ? ` Did you mean ${near.map((n) => JSON.stringify(n)).join(" or ")}?` : "";
}
