/**
 * Puts GDevelop's editor where gdevelop-editor/ builds it from:
 * gdevelop-editor/work/, which is not in this repository.
 *
 *   node scripts/prepare-gdevelop-editor.mjs
 *
 * GDevelop (MIT) is a game engine with a large editor. Autora uses its editor as
 * the game window, so the tree is fetched from the commit pinned in
 * gdevelop/PIN.json (newIDE/app, GDJS, Extensions) and Autora's changes are made to
 * the copy, in this order:
 *
 *   1. gdevelop-editor/overlay/*        whole files that replace GDevelop's own at the same
 *                                       path, or are new (the start screen, the storage, the bridge)
 *   2. gdevelop-editor/patches.mjs      small edits to files too big to replace (the AI, the
 *                                       account and shop screens), each of which fails the
 *                                       build if the line it expects has moved
 *   3. what GDevelop generates before it builds: its theme, the runtime it exports games
 *      with, the editor's own libraries, and the engine (libGD.js and libGD.wasm), downloaded
 *      from the build GDevelop made of the same commit
 *
 * To change what Autora does to GDevelop, edit the overlay or the patches, never
 * the fetched copy (it is replaced whenever the pin, the overlay or a patch changes).
 * To take a newer GDevelop, move both shas in gdevelop/PIN.json, then copy its
 * newIDE/app/package.json dependencies and package-lock.json into gdevelop-editor/
 * (this script says when they differ).
 *
 * Needs git and the network the first time; after that .cache/gdevelop holds it.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { checkout, pin, root, src } from "./gdevelop-checkout.mjs";
import { PATCHES } from "../gdevelop-editor/patches.mjs";

const editor = path.join(root, "gdevelop-editor");
const work = path.join(editor, "work");
const app = path.join(work, "newIDE/app");
const overlay = path.join(editor, "overlay");
const stamp = path.join(editor, ".prepared");
const log = (m) => console.log(`[gdevelop-editor] ${m}`);

/** What the prepared tree is made of: the pin, every byte of the overlay and the patches, and this script. */
function fingerprint() {
  const h = createHash("sha256").update(JSON.stringify(pin)).update(fs.readFileSync(new URL(import.meta.url)));
  h.update(fs.readFileSync(path.join(editor, "patches.mjs")));
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else h.update(path.relative(overlay, full)).update(fs.readFileSync(full));
    }
  };
  walk(overlay);
  return h.digest("hex");
}

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", env: process.env });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.status ?? r.signal})`);
}

/** curl when there is one, because it honours the proxy settings of the machine it runs on; node's fetch (the image's builder has no curl) when there is not. */
async function download(url, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const viaCurl = spawnSync("curl", ["-fsSL", "--retry", "5", "--retry-all-errors", "--retry-delay", "2", "-o", `${to}.part`, url], { stdio: "inherit" });
  if (viaCurl.error?.code === "ENOENT") {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    fs.writeFileSync(`${to}.part`, Buffer.from(await res.arrayBuffer()));
  } else if (viaCurl.status !== 0) {
    throw new Error(`curl ${url} failed (${viaCurl.status ?? viaCurl.signal})`);
  }
  fs.renameSync(`${to}.part`, to);
}

const want = fingerprint();
if (fs.existsSync(stamp) && fs.readFileSync(stamp, "utf8").trim() === want && fs.existsSync(path.join(app, "public/libGD.wasm"))) {
  process.exit(0);
}

checkout(log);

// The dependencies are installed from gdevelop-editor/package-lock.json, a copy of GDevelop's: the two must agree.
const theirs = JSON.parse(fs.readFileSync(path.join(src, "newIDE/app/package.json"), "utf8"));
const ours = JSON.parse(fs.readFileSync(path.join(editor, "package.json"), "utf8"));
for (const key of ["dependencies", "devDependencies", "overrides"]) {
  if (JSON.stringify(theirs[key]) !== JSON.stringify(ours[key])) {
    throw new Error(`gdevelop-editor/package.json: "${key}" differs from newIDE/app/package.json at ${pin.sha.slice(0, 12)}. Copy GDevelop's dependencies and package-lock.json over ours.`);
  }
}

fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
for (const dir of ["newIDE/app", "newIDE/electron-app/app", "GDJS", "Extensions"]) {
  fs.cpSync(path.join(src, dir), path.join(work, dir), { recursive: true });
}
// The dependencies live beside the scripts, once; GDevelop's scripts look for them in newIDE/app/node_modules.
fs.symlinkSync(path.join(editor, "node_modules"), path.join(app, "node_modules"), "dir");

fs.cpSync(overlay, work, { recursive: true });

// English only: the other 118 languages are a hundred megabytes of the editor's build, and Autora's own pages are English.
const locales = path.join(app, "src/locales");
for (const name of fs.readdirSync(locales)) {
  if (name !== "en" && fs.statSync(path.join(locales, name)).isDirectory()) fs.rmSync(path.join(locales, name), { recursive: true, force: true });
}
const english = [{ languageCode: "en", languageName: "English", languageNativeName: "English", translationRatio: 1 }];
for (const file of ["LocalesMetadata.js", "ExtensionLocalesMetadata.js"]) {
  fs.writeFileSync(path.join(locales, file), `// Autora: English only (scripts/prepare-gdevelop-editor.mjs).\nmodule.exports = ${JSON.stringify(english, null, 2)};\n`);
}

// GDevelop makes the variables of every theme in its registry; the patches below leave one in the registry, so this comes first.
run("node", ["build-theme-resources.js"], path.join(app, "scripts"));

for (const patch of PATCHES) {
  const file = path.join(work, patch.file);
  const before = fs.readFileSync(file, "utf8");
  const parts = before.split(patch.find);
  if (parts.length < 2) throw new Error(`patch for ${patch.file}: not found: ${patch.find.slice(0, 80)}`);
  if (parts.length > 2 && !patch.all) throw new Error(`patch for ${patch.file}: found ${parts.length - 1} times, expected once: ${patch.find.slice(0, 80)}`);
  fs.writeFileSync(file, parts.join(patch.replace));
}

// What GDevelop generates before it builds (its `import-resources`, without the parts that need an account or a download of its own).
const version = JSON.parse(fs.readFileSync(path.join(work, "newIDE/electron-app/app/package.json"), "utf8")).version;
fs.writeFileSync(
  path.join(app, "src/Version/VersionMetadata.js"),
  `// @flow\nmodule.exports = ${JSON.stringify({ version, gitHash: pin.sha, versionWithHash: `${version}-${pin.sha}` }, null, 2)};\n`,
);
run("npm", ["ci", "--no-audit", "--no-fund", "--loglevel=error"], path.join(work, "GDJS"));
run("node", ["import-GDJS-Runtime.js"], path.join(app, "scripts"));
run("node", ["import-monaco-editor.js"], path.join(app, "scripts"));
run("node", ["import-zipped-external-libs.js"], path.join(app, "scripts"));
for (const file of ["libGD.js", "libGD.wasm"]) {
  const cached = path.join(root, ".cache/gdevelop/engine", pin.sha, file);
  if (!fs.existsSync(cached)) await download(`${pin.engine}/${file}`, cached);
  fs.copyFileSync(cached, path.join(app, "public", file));
}

fs.writeFileSync(stamp, `${want}\n`);
log(`editor prepared from ${pin.sha.slice(0, 12)}`);
