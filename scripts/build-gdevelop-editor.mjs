/**
 * Builds GDevelop's editor (prepared by prepare-gdevelop-editor.mjs) into
 * dist/gdevelop-editor/, the page the game window shows.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pin, src } from "./gdevelop-checkout.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const editor = path.join(root, "gdevelop-editor");
const app = path.join(editor, "work/newIDE/app");

function run(cmd, args, cwd, env = {}) {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.status ?? r.signal})`);
}

run("node", [path.join(root, "scripts/prepare-gdevelop-editor.mjs")], root);
fs.rmSync(path.join(app, "build"), { recursive: true, force: true });
run("node", [path.join(editor, "node_modules/react-app-rewired/bin/index.js"), "build"], app, {
  CI: "false",
  GENERATE_SOURCEMAP: "false",
  NODE_OPTIONS: "--max-old-space-size=8192",
});
run("node", ["scripts/check-build-output.js"], app);
// The runtime a game is exported with: what GDevelop's own build fetches from its servers. Maps and the other platforms' folders are not needed to run a preview.
const runtime = path.join(app, "resources/GDJS/Runtime");
fs.cpSync(runtime, path.join(app, "build/GDJS/Runtime"), {
  recursive: true,
  // The web export also asks for Electron's licence file (GDevelop's "web" file set), so that one stays.
  filter: (from) => {
    const rel = path.relative(runtime, from).split(path.sep);
    if (from.endsWith(".map") || ["Cordova", "FacebookInstantGames"].includes(rel[0])) return false;
    return !(rel[0] === "Electron" && rel.length > 1 && rel[1] !== "LICENSE.GDevelop.txt");
  },
});
const out = path.join(root, "dist/gdevelop-editor");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.cpSync(path.join(app, "build"), out, { recursive: true });
// GDevelop is MIT: what is built from it carries its licences and says where it came from.
const licences = ["LICENSE.md", "newIDE/LICENSE.md", "GDJS/LICENSE.md", "Extensions/LICENSE.md"]
  .map((file) => `## ${file}\n\n${fs.readFileSync(path.join(src, file), "utf8").trim()}\n`);
fs.writeFileSync(
  path.join(out, "LICENSES-GDevelop.md"),
  `# GDevelop\n\nThis editor is built from GDevelop (${pin.repo}, commit ${pin.sha}) with Autora's changes: its AI, account, shop and cloud are removed, and it saves to Autora (https://github.com/blofstedt/Autora, gdevelop-editor/). GDevelop's name and logo are the property of Florian Rival.\n\n${licences.join("\n")}`,
);
console.log(`[gdevelop-editor] built into ${path.relative(root, out)}`);
