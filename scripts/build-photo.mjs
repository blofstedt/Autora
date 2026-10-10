/**
 * Builds what Autora Photo runs: PhotoCraft's editor (a Rust app that runs in the browser as WebAssembly) and its
 * headless command line, from the commit pinned in photo/PIN.json, into dist/photo/.
 *
 *   node scripts/build-photo.mjs [--no-cli | --only-cli] [--targets=x86_64-unknown-linux-musl,aarch64-unknown-linux-musl]
 *
 *   dist/photo/web/            the editor, a static site (served at /autora-photo by server/photodesk.ts)
 *   dist/photo/native/photocraft-cli[-x64|-arm64]   the command line the agent's photo_* tools run
 *   dist/photo/LICENSE-*, NOTICE
 *
 * photo/overlay/autora.rs is laid over the web app: it is how the window and the editor talk (postMessage; see the
 * file). Three small patches to PhotoCraft's own web.rs and main.rs hook it in; each is checked, so a pin that moves
 * them fails here, loudly, rather than building an editor with no wire.
 *
 * Nothing here is required to run Autora: without the build the photo tools say so. So a machine with no network or no
 * Rust still builds the rest.
 *
 * Without --targets the command line is built for this machine. With them it is cross-built for each Linux target,
 * static, one per CPU, through `cargo zigbuild` (as the Office engine is; see scripts/build-office.mjs).
 *
 * --only-cli skips the editor, so a Docker stage with Rust and Zig and no trunk can build just the command line.
 * --no-cli skips the command line, for a stage that builds only the editor.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pin = JSON.parse(fs.readFileSync(path.join(root, "photo/PIN.json"), "utf8"));
const out = path.join(root, "dist/photo");
const src = path.join(root, ".cache/photo/photocraft");

const args = process.argv.slice(2);
const onlyCli = args.includes("--only-cli");
const wantCli = !args.includes("--no-cli");
const wantWeb = !onlyCli;
const targets = (args.find((a) => a.startsWith("--targets="))?.slice(10) ?? "")
  .split(",").map((t) => t.trim()).filter((t) => /^[a-z0-9_-]+$/.test(t));

const log = (m) => console.log(`[photo] ${m}`);
function run(cmd, a, opts = {}) {
  const r = spawnSync(cmd, a, { stdio: "inherit", ...opts, env: { ...process.env, ...(opts.env ?? {}) } });
  if (r.status !== 0) throw new Error(`${cmd} ${a.join(" ")} failed (${r.status ?? r.signal})`);
}
const has = (cmd, a = ["--version"]) => spawnSync(cmd, a, { stdio: "ignore" }).status === 0;

/** The overlay is part of what was built: change it and it builds again. */
const recipe = createHash("sha1");
recipe.update(fs.readFileSync(path.join(root, "photo/overlay/autora.rs")));
recipe.update(fs.readFileSync(fileURLToPath(import.meta.url)));
const marker = `${pin.sha}:${recipe.digest("hex").slice(0, 12)}${wantWeb ? ":web" : ""}${wantCli ? ":cli" : ""}:${targets.join("+")}`;
const stamp = path.join(out, "BUILT");
if (!onlyCli && fs.existsSync(stamp) && fs.readFileSync(stamp, "utf8").trim() === marker && fs.existsSync(path.join(out, "web/index.html"))) {
  log(`up to date (${pin.sha.slice(0, 8)})`);
  process.exit(0);
}

/** Replace `from` with `to` in a file, once; it must be there. */
function patch(file, from, to) {
  const text = fs.readFileSync(file, "utf8");
  if (text.includes(to)) return;
  if (!text.includes(from)) throw new Error(`${path.relative(src, file)} no longer has the text the Autora overlay hooks into:\n${from}`);
  fs.writeFileSync(file, text.replace(from, to));
}

/** Lay the overlay over a clean checkout of the web app. */
function overlay() {
  const web = path.join(src, "apps/photocraft-web");
  fs.copyFileSync(path.join(root, "photo/overlay/autora.rs"), path.join(web, "src/autora.rs"));
  // The phone's editor (autora.rs) asks the editor's own commands, which take JSON.
  patch(path.join(web, "Cargo.toml"), "log = { workspace = true }\n", "log = { workspace = true }\nserde_json = { workspace = true }\n");
  patch(path.join(web, "src/main.rs"), "#[cfg(target_arch = \"wasm32\")]\nmod web;", "#[cfg(target_arch = \"wasm32\")]\nmod autora;\n#[cfg(target_arch = \"wasm32\")]\nmod web;");
  const webrs = path.join(web, "src/web.rs");
  // The wire is opened once the app is made.
  patch(webrs, "                    listen_pen(&pen_target, app.stylus.feed.clone());", "                    listen_pen(&pen_target, app.stylus.feed.clone());\n                    crate::autora::start(&cc.egui_ctx);");
  // What the page sent is opened before the app runs, and what the person did is sent after.
  patch(webrs, "        self.serve_fonts(ctx);\n        self.app.logic(ctx, frame);", "        self.serve_fonts(ctx);\n        crate::autora::pump(&mut self.app, &self.inbox);\n        self.app.logic(ctx, frame);\n        crate::autora::tick(&self.app, ctx);");
  // A saved file goes to the page, which offers it: a frame cannot start a download itself.
  patch(webrs, "fn download(path: &str, bytes: &[u8]) -> Result<(), String> {\n", "fn download(path: &str, bytes: &[u8]) -> Result<(), String> {\n    if crate::autora::framed() {\n        return crate::autora::file(path, bytes);\n    }\n");
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
  // A clean tree each time, so the patches apply to PhotoCraft's own files and not to a patched copy.
  run("git", ["-C", src, "checkout", "-q", "-f", "--", "apps"]);
  fs.rmSync(path.join(src, "apps/photocraft-web/src/autora.rs"), { force: true });

  fs.mkdirSync(out, { recursive: true });
  if (wantWeb) {
    if (!has("cargo")) throw new Error("cargo (Rust) is not installed");
    if (!has("trunk")) throw new Error(`trunk is not installed (cargo install trunk --locked --version ${pin.trunk})`);
    run("rustup", ["target", "add", "wasm32-unknown-unknown"]);
    overlay();
    log("building the editor (WebAssembly; the first build takes a while)");
    fs.rmSync(path.join(out, "web"), { recursive: true, force: true });
    run("trunk", ["build", "--release", "--dist", path.join(out, "web")], { cwd: path.join(src, "apps/photocraft-web") });
    if (!fs.existsSync(path.join(out, "web/index.html"))) throw new Error("trunk made no index.html");
    for (const f of ["LICENSE-APACHE", "LICENSE-MIT", "NOTICE"]) fs.copyFileSync(path.join(src, f), path.join(out, f));
  }
} catch (err) {
  console.warn(`[photo] the editor was not built: ${err.message}`);
  process.exit(process.env.AUTORA_PHOTO_REQUIRED === "1" ? 1 : 0);
}

if (wantCli) {
  const crate = path.join(src, "apps/photocraft-cli/Cargo.toml");
  const names = { "x86_64-unknown-linux-musl": "x64", "aarch64-unknown-linux-musl": "arm64" };
  fs.mkdirSync(path.join(out, "native"), { recursive: true });
  try {
    if (!has("cargo")) throw new Error("cargo (Rust) is not installed");
    if (targets.length === 0) {
      log("building the command line for this machine");
      run("cargo", ["build", "--release", "--manifest-path", crate]);
      fs.copyFileSync(path.join(src, "target/release/photocraft-cli"), path.join(out, "native/photocraft-cli"));
    } else {
      for (const t of targets) {
        log(`building the command line for ${t}`);
        if (!has("rustup")) throw new Error("rustup is not installed (needed to add the cross target)");
        if (!has("cargo", ["zigbuild", "--help"])) throw new Error("cargo-zigbuild is not installed (cargo install cargo-zigbuild, and Zig)");
        run("rustup", ["target", "add", t]);
        run("cargo", ["zigbuild", "--release", "--target", t, "--manifest-path", crate]);
        fs.copyFileSync(path.join(src, "target", t, "release/photocraft-cli"), path.join(out, `native/photocraft-cli-${names[t] ?? t}`));
      }
    }
    for (const f of ["LICENSE-APACHE", "LICENSE-MIT", "NOTICE"]) fs.copyFileSync(path.join(src, f), path.join(out, f));
  } catch (err) {
    console.warn(`[photo] the command line was not built, so the agent cannot edit photos: ${err.message}`);
    if (process.env.AUTORA_PHOTO_REQUIRED === "1") process.exit(1);
  }
}

if (!onlyCli) fs.writeFileSync(stamp, `${marker}\n`);
log(`done: ${out}`);
