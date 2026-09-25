/**
 * The test runner.
 *
 * `npm test` used to be a chain of `&&`: the first file that failed stopped
 * the rest, so one broken test hid every test after it and a change that
 * broke two things looked like a change that broke one. Every file is run
 * here whatever the others did, and the summary says which ones failed.
 *
 *   npm test
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const here = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);
const files = fs
  .readdirSync(here)
  .filter((name) => name.endsWith(".test.ts"))
  .sort();

if (files.length === 0) {
  console.error("No tests found in tests/*.test.ts");
  process.exit(1);
}

/* The project's own tsx, so a test run does not fetch one from the network --
   which is what `npx tsx` does on a machine that has not got it. */
const tsx = path.join(here, "..", "node_modules", ".bin", "tsx");
const runner = fs.existsSync(tsx) ? tsx : "npx";

const results: { file: string; ok: boolean; ms: number; code: number | null }[] = [];
for (const file of files) {
  const started = Date.now();
  console.log(`\n== ${file} ==`);
  const run = spawnSync(
    runner,
    runner === tsx ? [path.join(here, file)] : ["tsx", path.join(here, file)],
    { stdio: "inherit", env: { ...process.env, NODE_ENV: "development" } },
  );
  results.push({
    file,
    ok: run.status === 0,
    code: run.status,
    ms: Date.now() - started,
  });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${"-".repeat(52)}`);
for (const r of results) {
  console.log(`${r.ok ? "pass" : "FAIL"}  ${r.file.padEnd(26)} ${(r.ms / 1000).toFixed(1)}s`);
}
console.log(
  failed.length === 0
    ? `\nAll ${results.length} test files passed.`
    : `\n${failed.length} of ${results.length} test files failed: ${failed.map((f) => f.file).join(", ")}`,
);
process.exit(failed.length === 0 ? 0 : 1);
