/**
 * Builds what Autora PDF runs: Spectra-PDF's engine, from the commit pinned in
 * spectra/PIN.json, into dist/spectra-engine/.
 *
 *   node scripts/build-spectra.mjs [--no-deps | --deps-only] [--arch amd64|arm64]
 *
 * --arch is the arch being built for (Docker's TARGETARCH), for a build that
 * happens under emulation: the venv's wheels are then chosen for that arch
 * rather than for the machine doing the installing.
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

/** `--arch <name>` and what follows it. */
function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : (process.argv[i + 1] ?? null);
}

/** The arch Docker is building for, as TARGETARCH spells it. Wheels are chosen
 *  for it rather than for the interpreter doing the installing: the arm64 image
 *  is built under emulation on an amd64 runner, where pip can settle on the
 *  wrong platform and install a wheel the finished image cannot load. */
const targetArch = arg("--arch");

/** Docker's arch names against the names wheels are tagged with. */
const MACHINES = {
  amd64: "x86_64", x86_64: "x86_64", "386": "i686", i386: "i686",
  arm64: "aarch64", "arm64/v8": "aarch64", aarch64: "aarch64",
  arm: "armv7l", "arm/v7": "armv7l", armv7l: "armv7l",
};

/** The ELF machine of a shared object, as MACHINES spells it: the one check
 *  that still means something when the wheels are for another arch. */
const ELF_MACHINES = { 0x03: "i686", 0x28: "armv7l", 0x3e: "x86_64", 0xb7: "aarch64" };
function elfMachine(file) {
  const head = Buffer.alloc(20);
  const fd = fs.openSync(file, "r");
  fs.readSync(fd, head, 0, 20, 0);
  fs.closeSync(fd);
  return ELF_MACHINES[head.readUInt16LE(18)] ?? `unknown (0x${head.readUInt16LE(18).toString(16)})`;
}
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

/** The same, for when what a command prints is the answer. */
function runOut(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.status ?? r.signal})`);
  return r.stdout.trim();
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
    const python = path.join(venv, "bin", "python");
    const site = runOut(python, ["-c", "import sysconfig; print(sysconfig.get_paths()['purelib'])"]);
    log(`installing ${PACKAGES.length} packages into the venv`);
    run(python, ["-m", "pip", "install", "--quiet", "--upgrade", "pip", "setuptools", "wheel"]);

    const machine = MACHINES[targetArch ?? ""] ?? null;
    if (!machine) {
      run(python, ["-m", "pip", "install", "--quiet", ...PACKAGES]);
    } else {
      /* Chosen for the arch, not for the interpreter doing the installing.
         `--target` is what lets pip accept a platform other than its own, and
         the venv's own site-packages is where it goes, so the engine's
         interpreter finds the packages exactly as if pip had installed there.
         No console scripts come of it; the engine runs `python -m engine`,
         which needs none. */
      const py = runOut(python, ["-c", "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}')"]);
      const abi = `cp${py.replace(".", "")}`;
      log(`wheels for ${machine} (${py}, ${abi})`);
      run(python, [
        "-m", "pip", "install", "--quiet", "--no-cache-dir", "--upgrade",
        "--target", site,
        "--only-binary=:all:",
        "--platform", `musllinux_1_2_${machine}`,
        "--platform", `manylinux_2_28_${machine}`,
        "--platform", "any",
        "--python-version", py,
        "--implementation", "cp",
        "--abi", abi, "--abi", "abi3", "--abi", "none",
        ...PACKAGES,
      ]);
    }

    /* The compiled part is pikepdf's extension. Where the arch being built is
       the arch running this, importing it is the proof; where it is not (a
       cross-install on another machine) the ELF header is what can be read.

       Docker builds the arm64 image under emulation on an amd64 runner, and
       there an import that fails can be the emulator rather than the wheel;
       the ELF check is then the one that decides, loudly. */
    const running = runOut(python, ["-c", "import platform; print(platform.machine())"]);
    const core = path.join(site, "pikepdf", "_core.abi3.so");
    const emulated = Boolean(process.env.QEMU_LD_PREFIX || process.env.QEMU_CPU);
    const imports = spawnSync(python, ["-c", "import pikepdf, pyhanko, fontTools, pdfminer, lxml, PIL, numpy; print('[spectra] engine imports ok')"], { stdio: "inherit" });
    if (imports.status === 0) {
      log(`pikepdf and its neighbours import (${machine ?? running})`);
    } else if (machine && machine !== running) {
      log(`the venv holds ${machine} wheels and this machine is ${running}: imports are for the machine that runs them`);
    } else if (emulated) {
      log(`the imports failed under emulation (${machine ?? running}): checking the wheels by their ELF header instead`);
    } else {
      throw new Error(`${python} could not import the engine's dependencies (${imports.status ?? imports.signal})`);
    }
    if (!fs.existsSync(core)) throw new Error(`pikepdf is not in the venv: ${core} is missing`);
    if (machine && elfMachine(core) !== machine) {
      throw new Error(`the venv holds ${elfMachine(core)} pikepdf for an ${machine} image: the wheel is the wrong arch`);
    };
  }
}

log(`done: ${out}`);
