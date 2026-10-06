/**
 * Builds what Autora PDF runs: Spectra-PDF's engine, from the commit pinned in
 * spectra/PIN.json, into dist/spectra-engine/.
 *
 *   node scripts/build-spectra.mjs [--no-deps | --deps-only]
 *
 * dist/spectra-engine/ gets the layout server/spectra/engine.ts expects:
 *   src/engine/          the engine package, imported as `engine`
 *   resources/icc/       the ICC colour profiles it converts and soft-proofs with
 *   venv/                its dependencies, where pythonBin looks first
 *
 * The engine is Python, so nothing has to be compiled here: the package is
 * copied and its dependencies are installed with pip. The Dockerfile runs it
 * twice, once in each stage: the build stage copies the package out of the
 * pinned commit (--no-deps), and the runtime stage makes the venv and installs
 * into it (--deps-only). Split that way because the venv belongs to the
 * interpreter that runs it, and nothing about the two stages has to match.
 *
 * Nothing here is required to run Autora. Without the bundle the PDF window
 * says the engine is not installed and stays shut, and every other part of the
 * app works; a machine with no network still builds the rest of the image.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pin = JSON.parse(fs.readFileSync(path.join(root, "spectra/PIN.json"), "utf8"));
const out = path.join(root, "dist/spectra-engine");
const cache = path.join(root, ".cache/spectra");
const src = path.join(cache, "spectra-pdf");

const noDeps = process.argv.includes("--no-deps");
/** Only the venv and the packages, for a stage that has dist/spectra-engine
 *  already (the runtime stage does: the build machine's interpreter is not
 *  the one it will run on). */
const depsOnly = process.argv.includes("--deps-only");

/** What the engine imports that is not the standard library: read off the
 *  package itself (pikepdf, pyhanko and pdfminer for the documents, lxml,
 *  Pillow and numpy under them, and tzdata because a musl image has no zone
 *  files of its own). */
const PACKAGES = [
  "pikepdf",
  "pyhanko",
  "pyhanko-certvalidator",
  "fonttools",
  "pdfminer.six",
  "lxml",
  "pillow",
  "numpy",
  "asn1crypto",
  "cryptography",
  "tzdata",
];

const log = (m) => console.log(`[spectra] ${m}`);
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.status ?? r.signal})`);
}

/** The pinned checkout, cloned once and reused; the sha is what is asked for,
 *  so a cached tree from another pin is refetched rather than reused. */
function checkout() {
  const head = spawnSync("git", ["-C", src, "rev-parse", "HEAD"], { encoding: "utf8" });
  if (head.status === 0 && head.stdout.trim() === pin.sha) {
    log(`checkout already at ${pin.sha.slice(0, 12)}`);
    return;
  }
  fs.rmSync(src, { recursive: true, force: true });
  fs.mkdirSync(cache, { recursive: true });
  log(`cloning ${pin.repo} at ${pin.sha.slice(0, 12)}`);
  run("git", ["clone", "--filter=blob:none", "--no-checkout", pin.repo, src]);
  run("git", ["-C", src, "fetch", "--depth", "1", "origin", pin.sha]);
  run("git", ["-C", src, "checkout", "--detach", pin.sha]);
}

/** A copy of a directory inside the checkout, with its bytecode left behind. */
function copy(from, to) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, {
    recursive: true,
    filter: (p) => !p.split(path.sep).includes("__pycache__") && !p.endsWith(".pyc"),
  });
}

function python() {
  for (const candidate of [process.env.AUTORA_SPECTRA_PYTHON, "python3", "python"]) {
    if (!candidate) continue;
    if (spawnSync(candidate, ["-c", "import sys"], { stdio: "ignore" }).status === 0) return candidate;
  }
  return null;
}

/** Whether the dependencies are installed into the venv: not with --no-deps. */
const installDeps = !noDeps;

if (!depsOnly) {
  checkout();

  fs.mkdirSync(out, { recursive: true });
  const engine = path.join(src, "src", "engine");
  if (!fs.existsSync(path.join(engine, "__main__.py"))) {
    throw new Error(`the engine package is not at ${engine} in ${pin.sha.slice(0, 12)}`);
  }
  copy(engine, path.join(out, "src", "engine"));
  log(`engine copied (${fs.readdirSync(path.join(out, "src", "engine")).length} files)`);

  /* The ICC profiles are read from resources/icc beside the package (see
     engine/icc_profiles.py). They ship in the repository under vendor/icc, which
     its own scripts/bundle-icc.sh is what copies across; this is that copy. */
  const icc = path.join(src, "vendor", "icc");
  if (fs.existsSync(icc)) {
    copy(icc, path.join(out, "resources", "icc"));
    log(`ICC profiles copied (${fs.readdirSync(path.join(out, "resources", "icc")).length})`);
  } else {
    log("no vendor/icc in this commit: colour conversions that need a profile will say so");
  }
}

if (!installDeps) {
  log("the engine is bundled without its dependencies (--no-deps)");
} else {
  const bin = python();
  if (!bin) {
    log("no python3 on this machine: the engine is bundled without its dependencies");
  } else {
    const venv = path.join(out, "venv");
    if (!fs.existsSync(path.join(venv, "bin", "python"))) run(bin, ["-m", "venv", venv]);
    const pip = path.join(venv, "bin", "python");
    log(`installing ${PACKAGES.length} packages into the venv`);
    run(pip, ["-m", "pip", "install", "--quiet", "--upgrade", "pip", "setuptools", "wheel"]);
    run(pip, ["-m", "pip", "install", "--quiet", ...PACKAGES]);
    run(pip, ["-c", "import pikepdf, pyhanko, fontTools, pdfminer, lxml, PIL, numpy; print('[spectra] engine imports ok')"]);
  }
}

log(`done: ${out}`);
