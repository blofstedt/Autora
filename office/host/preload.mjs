/*
 * Bundles one GenOffice app's real preload script over Autora's stand-in for
 * `electron` (office/shim/electron-renderer.js), as a classic script for the
 * editor's page: it defines window.slidesApi / window.desktopApi and speaks to
 * the engine through the host's ipc.
 *
 *   OFFICE_APP=slides OFFICE_PRELOAD=/path/preload.js node preload.mjs <checkout>
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const checkout = path.resolve(process.argv[2] || ".");
const app = process.env.OFFICE_APP;
const outfile = process.env.OFFICE_PRELOAD;
if (!app || !outfile) throw new Error("OFFICE_APP and OFFICE_PRELOAD are needed");
const esbuild = createRequire(path.join(checkout, "package.json"))("esbuild");
await esbuild.build({
  entryPoints: [path.join(checkout, "apps", app, "src/preload/index.ts")],
  bundle: true, platform: "browser", format: "iife", target: "es2022", outfile, logLevel: "error",
  alias: { electron: path.join(here, "../shim/electron-renderer.js") },
  tsconfig: path.join(checkout, "apps", app, "tsconfig.json"),
  nodePaths: [path.join(checkout, "node_modules")],
  define: { "process.env.NODE_ENV": '"production"', "process.platform": '"linux"' },
});
