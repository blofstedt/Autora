/**
 * Brings Autora 3D's source in from its own repository (github.com/blofstedt/3D-Modeling).
 *
 *   node scripts/sync-autora-3d.mjs [path to a checkout of 3D-Modeling]     (default: ../3D-Modeling)
 *
 * Autora 3D is a sketch-and-extrude CAD modeller that is also its own app, so its source lives in its own repository and
 * a copy is carried here, in autora-3d/, the way spectra-editor/ is: a sub-project with its own dependencies, built into
 * dist/autora-3d/ (the window's page) and dist/autora-3d-engine/ (the headless model the agent's `cad_*` tools run on).
 * Never edit autora-3d/ by hand: change the app in its repository and run this. It also rewrites server/specs/cad.ts,
 * the agent's tool list, from the tools the copy declares, so the two cannot drift apart.
 */
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const from = path.resolve(process.argv[2] ?? path.join(root, "..", "3D-Modeling"));
const to = path.join(root, "autora-3d");
if (!existsSync(path.join(from, "src", "core", "tools.ts"))) {
  console.error(`${from} is not a checkout of 3D-Modeling (no src/core/tools.ts).`);
  process.exit(1);
}

// 1. The source: everything a build needs, nothing it produces.
rmSync(path.join(to, "src"), { recursive: true, force: true });
mkdirSync(to, { recursive: true });
cpSync(path.join(from, "src"), path.join(to, "src"), { recursive: true });
for (const file of ["index.html", "vite.config.ts", "tsconfig.json", "package-lock.json"]) cpSync(path.join(from, file), path.join(to, file));

// 2. Its package.json, with the build scripts Autora runs (the app's own scripts for tests and servers stay in its repository).
const pkg = JSON.parse(readFileSync(path.join(from, "package.json"), "utf8"));
const own = {
  name: "autora-3d",
  private: true,
  version: pkg.version,
  type: "module",
  description: pkg.description,
  scripts: {
    typecheck: "tsc --noEmit",
    build: "npm run build:app && npm run build:engine",
    "build:app": "vite build --outDir ../dist/autora-3d --emptyOutDir",
    "build:engine":
      "esbuild src/core/index.ts --bundle --platform=node --format=esm --outfile=../dist/autora-3d-engine/engine.mjs --log-level=error --banner:js=\"import{createRequire}from'module';const require=createRequire(import.meta.url);\" && node -e \"require('fs').copyFileSync('node_modules/manifold-3d/manifold.wasm','../dist/autora-3d-engine/manifold.wasm')\"",
  },
  dependencies: pkg.dependencies,
  devDependencies: Object.fromEntries(Object.entries(pkg.devDependencies ?? {}).filter(([k]) => !k.startsWith("@modelcontextprotocol"))),
};
writeFileSync(path.join(to, "package.json"), JSON.stringify(own, null, 2) + "\n");
let commit = "unknown";
try {
  commit = execFileSync("git", ["-C", from, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
} catch {
  // Not a git checkout: the copy still works, it just cannot say where it came from.
}
writeFileSync(path.join(to, "SOURCE.json"), JSON.stringify({ repo: "blofstedt/3D-Modeling", commit }, null, 2) + "\n");

// 3. The agent's tools, written from what the copy declares.
const scratch = path.join(os.tmpdir(), `autora-3d-sync-${process.pid}`);
mkdirSync(scratch, { recursive: true });
const bundle = path.join(scratch, "tools.mjs");
await build({
  entryPoints: [path.join(to, "src", "core", "tools.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: bundle,
  logLevel: "error",
  banner: { js: "import{createRequire}from'module';const require=createRequire(import.meta.url);" },
  nodePaths: [path.join(from, "node_modules")],
});
const { TOOL_SPECS } = await import(pathToFileURL(bundle).href);
rmSync(scratch, { recursive: true, force: true });

/* Exporting is the one tool that changes shape here: the file cannot come back as base64 in the conversation, so
   server/caddesk.ts saves it as an artifact (with this name, if one is given) and the reply says what it is called. */
const EXPORT_NOTE = " The file is saved as an artifact the person can download from the thread, and the reply names it; pass name to choose the file name.";
const specs = TOOL_SPECS.filter((t) => !t.uiOnly).map((t) => ({
  name: `cad_${t.name}`,
  group: "files",
  description: t.name === "export" ? t.description.replace(/, returned as base64/g, "") + EXPORT_NOTE : t.description,
  parameters: t.name === "export" ? { ...t.inputSchema, properties: { ...t.inputSchema.properties, name: { type: "string", description: "File name, without or with the extension." } } } : t.inputSchema,
}));
/* The tools mention each other by their own names ("call scene_get again"); the agent knows them as cad_scene_get. */
const bare = TOOL_SPECS.filter((t) => t.name.includes("_") && !t.uiOnly).map((t) => t.name);
const prefix = (text) => text.replace(new RegExp(`(?<![\\w])(${bare.join("|")})(?![\\w])`, "g"), "cad_$1");
/* Autora's own specs say what is allowed, not what is forbidden: `additionalProperties` is left out. */
const written = JSON.parse(prefix(JSON.stringify(specs)).replace(/,?"additionalProperties":(true|false)/g, ""));
written.find((t) => t.name === "cad_batch").description += " Inside commands, name a tool as shape_add or cad_shape_add; both work.";

const body = `/**
 * Autora 3D's tools, as the agent sees them: one \`cad_*\` tool for every call the modeller declares.
 *
 * GENERATED by scripts/sync-autora-3d.mjs from autora-3d/src/core/tools.ts -- do not edit by hand.
 * (\`export\` is not here: it is \`cad_export\`, in server/caddesk.ts, because only the server can put the file somewhere.)
 */

import type { ToolSpec } from "../tools";

export const cadSPECS: ToolSpec[] = ${JSON.stringify(written, null, 2)} as ToolSpec[];
`;
writeFileSync(path.join(root, "server", "specs", "cad.ts"), body);
console.log(`autora-3d/ is now ${commit.slice(0, 7)} from ${from}; ${specs.length} tools written to server/specs/cad.ts.`);
