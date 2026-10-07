/**
 * The test runner.
 *
 * `npm test` used to be a chain of `&&`: the first file that failed stopped
 * the rest, so one broken test hid every test after it and a change that
 * broke two things looked like a change that broke one. Every file is run
 * here whatever the others did, and the summary says which ones failed.
 *
 *   npm test                  every file, one after another
 *   npm test -- pdf office    only files whose name contains one of these
 *   npm test -- -j 4          four files at once (each test makes its own
 *                             state directory and port; the browser tests
 *                             are heavy, so more than 4 rarely helps)
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const here = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);

const args = process.argv.slice(2);
let jobs = 1;
const filters: string[] = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "-j" || args[i] === "--jobs") jobs = Math.max(1, Number(args[++i]) || 1);
  else filters.push(args[i]);
}

const files = fs
  .readdirSync(here)
  .filter((name) => name.endsWith(".test.ts"))
  .filter((name) => filters.length === 0 || filters.some((f) => name.includes(f)))
  .sort();

if (files.length === 0) {
  console.error(filters.length ? `No tests match ${filters.join(", ")}` : "No tests found in tests/*.test.ts");
  process.exit(1);
}

/* The project's own tsx, so a test run does not fetch one from the network --
   which is what `npx tsx` does on a machine that has not got it. */
const tsx = path.join(here, "..", "node_modules", ".bin", "tsx");
const runner = fs.existsSync(tsx) ? tsx : "npx";

type Result = { file: string; ok: boolean; ms: number; code: number | null };

function run(file: string): Promise<Result> {
  const started = Date.now();
  const serial = jobs === 1;
  if (serial) console.log(`\n== ${file} ==`);
  return new Promise((resolve) => {
    const child = spawn(
      runner,
      runner === tsx ? [path.join(here, file)] : ["tsx", path.join(here, file)],
      // Serial runs print as they go; parallel ones keep each file's output
      // together and print it when the file ends.
      { stdio: serial ? "inherit" : ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_ENV: "development" } },
    );
    let out = "";
    if (!serial) {
      child.stdout?.on("data", (d) => { out += d; });
      child.stderr?.on("data", (d) => { out += d; });
    }
    child.on("close", (code) => {
      if (!serial) process.stdout.write(`\n== ${file} ==\n${out}`);
      resolve({ file, ok: code === 0, code, ms: Date.now() - started });
    });
  });
}

const results: Result[] = [];
const queue = [...files];
await Promise.all(Array.from({ length: Math.min(jobs, files.length) }, async () => {
  for (let file = queue.shift(); file; file = queue.shift()) results.push(await run(file));
}));
results.sort((a, b) => (a.file < b.file ? -1 : 1));

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
