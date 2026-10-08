/**
 * Typechecks opencut-editor/ -- Autora's part of it.
 *
 * OpenCut's own sources are fetched and are not ours to fix: at the pinned
 * commit a few of them do not typecheck on their own (the storage migrations
 * call an older adapter signature). `tsc` is run over the lot, because Autora's
 * files have to be checked against OpenCut's types, but only errors in
 * Autora's files -- src/autora/ and everything under overlay/web/ -- fail it.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const editor = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../opencut-editor");

const ours = new Set();
const walk = (dir, rel) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, path.posix.join(rel, entry.name));
    else ours.add(path.posix.join("src/web", rel, entry.name));
  }
};
walk(path.join(editor, "overlay/web"), "");

const run = spawnSync("npx", ["tsc", "--noEmit", "--pretty", "false"], { cwd: editor, encoding: "utf8" });
const mine = (run.stdout + run.stderr)
  .split("\n")
  .filter((line) => /error TS\d+/.test(line))
  .filter((line) => {
    const file = line.slice(0, line.indexOf("("));
    return file.startsWith("src/autora/") || ours.has(file);
  });

if (mine.length) {
  console.error(mine.join("\n"));
  process.exit(1);
}
console.log("[opencut-editor] typecheck clean (Autora's files)");
