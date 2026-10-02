/**
 * Builds what the Office tools run: GenOffice's command line (Word, PowerPoint
 * and Excel documents, read and edited without a window) and its spreadsheet
 * engine, from the commit pinned in office/PIN.json, into dist/office/.
 *
 *   node scripts/build-office.mjs [--no-sidecar | --only-sidecar] [--targets=x86_64-unknown-linux-musl,aarch64-unknown-linux-musl]
 *
 * dist/office/ gets GenOffice's own "packaged" layout, which is where the
 * command line looks for the rest of itself:
 *   cli/genoffice.cjs        the command line, one file
 *   cli/node_modules/        jsdom and what it needs (Word documents run under it)
 *   web/<app>/index.html     the editor's window, one page (docs; see office/vite/editor.mjs), and
 *   web/<app>/assets/        its fonts, which the page asks the host for
 *   wasm/pdfium.wasm         marks the folder as the resources folder
 *   native/xlsx-sidecar[-x64|-arm64]   the Rust spreadsheet engine, when it could be built
 *   LICENSE, NOTICE          GenOffice's
 *
 * Nothing here is required to run Autora: without the bundle the Office tools
 * say so, and without the engine only the Excel ones do. So a machine with no
 * network or no Rust still builds the rest.
 *
 * Without --targets the engine is built for this machine (cargo build). With
 * them it is cross-built for each Linux target, static, one per CPU, so one
 * build serves an image that runs on either (the runtime picks by process.arch).
 * It is not pure Rust (a C compression library comes with it), so the cross
 * build goes through `cargo zigbuild`, which brings a C cross-compiler.
 *
 * --only-sidecar skips the command line, so a Docker stage with Rust and Zig
 * and no npm install can build just the engine.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pin = JSON.parse(fs.readFileSync(path.join(root, "office/PIN.json"), "utf8"));
const out = path.join(root, "dist/office");
const cache = path.join(root, ".cache/office");
const src = path.join(cache, "genoffice");

const args = process.argv.slice(2);
const onlySidecar = args.includes("--only-sidecar");
const wantSidecar = !args.includes("--no-sidecar");
const targets = (args.find((a) => a.startsWith("--targets="))?.slice(10) ?? args[args.indexOf("--targets") + 1] ?? "")
  .split(",").map((t) => t.trim()).filter((t) => /^[a-z0-9_-]+$/.test(t));

/** The editors built as windows; the others (slides, sheets) keep their document in Electron's main process. */
const EDITORS = ["docs", "slides", "sheets"];
/** The editors whose document lives in the engine (Electron's main process in GenOffice): it runs here as a child process. */
const ENGINES = ["slides", "sheets"];

const log = (m) => console.log(`[office] ${m}`);
function run(cmd, a, opts = {}) {
  const r = spawnSync(cmd, a, { stdio: "inherit", ...opts, env: { ...process.env, ...(opts.env ?? {}) } });
  if (r.status !== 0) throw new Error(`${cmd} ${a.join(" ")} failed (${r.status ?? r.signal})`);
}
const has = (cmd, a = ["--version"]) => spawnSync(cmd, a, { stdio: "ignore" }).status === 0;

/** Already built from this commit: nothing to do. */
const stamp = path.join(out, "BUILT");
/* Our own build recipe is part of what was built: change a shim or the config and it builds again. */
const recipe = createHash("sha1");
for (const f of ["office/vite/editor.mjs", ...["shim", "host"].flatMap((d) => fs.readdirSync(path.join(root, "office", d)).sort().map((n) => `office/${d}/${n}`))]) {
  recipe.update(fs.readFileSync(path.join(root, f)));
}
const marker = `${pin.sha}:${recipe.digest("hex").slice(0, 12)}${wantSidecar ? ":sidecar" : ""}:${targets.join("+")}`;
if (!onlySidecar && fs.existsSync(stamp) && fs.readFileSync(stamp, "utf8").trim() === marker && fs.existsSync(path.join(out, "cli/genoffice.cjs"))) {
  log(`up to date (${pin.sha.slice(0, 8)})`);
  process.exit(0);
}

try {
  if (!has("git")) throw new Error("git is not installed");
  fs.mkdirSync(src, { recursive: true });
  const head = spawnSync("git", ["-C", src, "rev-parse", "HEAD"], { encoding: "utf8" });
  if (head.status !== 0 || head.stdout.trim() !== pin.sha) {
    log(`fetching ${pin.repo} @ ${pin.sha.slice(0, 8)}`);
    if (!fs.existsSync(path.join(src, ".git"))) run("git", ["init", "-q", src]);
    spawnSync("git", ["-C", src, "remote", "remove", "origin"], { stdio: "ignore" });
    run("git", ["-C", src, "remote", "add", "origin", pin.repo]);
    run("git", ["-C", src, "fetch", "-q", "--depth", "1", "origin", pin.sha], { env: { GIT_LFS_SKIP_SMUDGE: "1" } });
    run("git", ["-C", src, "checkout", "-q", "-f", "FETCH_HEAD"], { env: { GIT_LFS_SKIP_SMUDGE: "1" } });
  }

  if (!onlySidecar) {
    log("installing its dependencies");
    run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: src,
      env: { ELECTRON_SKIP_BINARY_DOWNLOAD: "1", PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" },
    });

    log("bundling the command line");
    run("node", ["build.mjs"], { cwd: path.join(src, "packages/cli") });
    run("node", ["collect-deps.mjs"], { cwd: path.join(src, "packages/cli") });

    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(path.join(out, "cli"), { recursive: true });
    fs.mkdirSync(path.join(out, "wasm"), { recursive: true });
    const dist = path.join(src, "packages/cli/dist");
    fs.copyFileSync(path.join(dist, "genoffice.cjs"), path.join(out, "cli/genoffice.cjs"));
    fs.cpSync(path.join(dist, "node_modules"), path.join(out, "cli/node_modules"), { recursive: true });
    fs.copyFileSync(path.join(src, "node_modules/@embedpdf/pdfium/dist/pdfium.wasm"), path.join(out, "wasm/pdfium.wasm"));

    /* The editors' windows, built with the checkout's own Vite from a config of ours. A window that
       does not build is not the end of the tools: the rest still works, and says what is missing. */
    for (const app of EDITORS) {
      try {
        log(`building the ${app} editor`);
        const preload = path.join(src, "apps", app, "autora-preload.js");
        if (ENGINES.includes(app)) {
          run("node", [path.join(root, "office/host/preload.mjs"), src], { env: { OFFICE_APP: app, OFFICE_PRELOAD: preload } });
        }
        const config = path.join(src, "apps", app, "vite.autora.mjs");
        fs.copyFileSync(path.join(root, "office/vite/editor.mjs"), config);
        run(path.join(src, "node_modules/.bin/vite"), ["build", "--config", config], {
          cwd: path.join(src, "apps", app),
          env: { OFFICE_APP: app, OFFICE_OUT: path.join(out, "web"), OFFICE_SHIM: path.join(root, "office/shim"), ...(ENGINES.includes(app) ? { OFFICE_PRELOAD: preload } : {}) },
        });
      } catch (err) {
        console.warn(`[office] the ${app} editor was not built: ${err.message}`);
      }
    }
    /* The engines: GenOffice's main-process code for each editor, under a stand-in for Electron. */
    for (const app of ENGINES) {
      try {
        log(`bundling the ${app} engine`);
        run("node", [path.join(root, "office/host/build.mjs"), src], { env: { OFFICE_APP: app, OFFICE_OUT: path.join(out, "host") } });
      } catch (err) {
        console.warn(`[office] the ${app} engine was not built: ${err.message}`);
      }
    }
    for (const f of ["LICENSE", "NOTICE"]) fs.copyFileSync(path.join(src, f), path.join(out, f));
  }
  fs.mkdirSync(path.join(out, "native"), { recursive: true });
} catch (err) {
  console.warn(`[office] the Office tools were not built: ${err.message}`);
  process.exit(process.env.AUTORA_OFFICE_REQUIRED === "1" ? 1 : 0);
}

if (wantSidecar) {
  const crate = path.join(src, "apps/sheets/native/xlsx-engine/Cargo.toml");
  const names = { "x86_64-unknown-linux-musl": "x64", "aarch64-unknown-linux-musl": "arm64" };
  try {
    if (!has("cargo")) throw new Error("cargo (Rust) is not installed");
    if (targets.length === 0) {
      log("building the spreadsheet engine for this machine");
      run("cargo", ["build", "--release", "--manifest-path", crate]);
      fs.copyFileSync(path.join(path.dirname(crate), "target/release/xlsx-sidecar"), path.join(out, "native/xlsx-sidecar"));
    } else {
      for (const t of targets) {
        log(`building the spreadsheet engine for ${t}`);
        if (!has("rustup")) throw new Error("rustup is not installed (needed to add the cross target)");
        if (!has("cargo", ["zigbuild", "--help"])) throw new Error("cargo-zigbuild is not installed (cargo install cargo-zigbuild, and Zig)");
        run("rustup", ["target", "add", t]);
        run("cargo", ["zigbuild", "--release", "--target", t, "--manifest-path", crate]);
        fs.copyFileSync(path.join(path.dirname(crate), "target", t, "release/xlsx-sidecar"), path.join(out, `native/xlsx-sidecar-${names[t] ?? t}`));
      }
    }
  } catch (err) {
    console.warn(`[office] the spreadsheet engine was not built, so the Excel tools will be unavailable: ${err.message}`);
    if (process.env.AUTORA_OFFICE_REQUIRED === "1") process.exit(1);
  }
}

if (!onlySidecar) fs.writeFileSync(stamp, `${marker}\n`);
log(`done: ${out}`);
