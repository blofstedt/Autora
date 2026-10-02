/*
 * Bundles one GenOffice app's real main-process code with Autora's stand-in for
 * Electron into a single child-process script (see entry.ts):
 *
 *   OFFICE_APP=slides OFFICE_OUT=/path/dist/office/host node build.mjs <checkout>
 *
 * The checkout's own esbuild is used, and its Vite-style imports (`?raw`, `?asset`)
 * are answered the way electron-vite would: text inlined, files copied beside the
 * script (assets/) and named by path.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const checkout = path.resolve(process.argv[2] || ".");
const app = process.env.OFFICE_APP || "slides";
const out = path.resolve(process.env.OFFICE_OUT || path.join(here, "../../dist/office/host"));
const APPS = {
  slides: {
    main: "apps/slides/src/main/slides-main.ts", register: "registerSlidesIpc", tsconfig: "apps/slides/tsconfig.json",
    // What Autora asks of this app's main code (`autora:<name>` over the host's ipc).
    extra: "export const extra = {};",
  },
  sheets: {
    main: "apps/sheets/src/main/sheets-main.ts", register: "registerSheetsIpc", tsconfig: "apps/sheets/tsconfig.json",
    // A tab for the workbook at `path` (the editor page shown under the returned id opens it), or a headless PDF export of it.
    extra: `import { createSheetsView, queueWorkbookForView, exportSheetsPdfHeadless } from ${JSON.stringify("MAIN")};
import { setHeadlessMode } from "@genoffice/electron-utils";
export const extra = {
  view(path: string) { const view = createSheetsView({ includeAiHandlers: false }); queueWorkbookForView(view.webContents, path); return view.webContents.id; },
  async headlessExport(input: string, out: string) { setHeadlessMode(true); await exportSheetsPdfHeadless(input, out); return true; },
};`,
  },
};
const spec = APPS[app];
if (!spec) throw new Error(`unknown app ${app}`);

const esbuild = createRequire(path.join(checkout, "package.json"))("esbuild");
const assets = path.join(out, "assets");
fs.mkdirSync(assets, { recursive: true });

const viteLike = {
  name: "vite-like-imports",
  setup(b) {
    b.onResolve({ filter: /^autora:register$/ }, () => ({ path: "autora:register", namespace: "autora" }));
    b.onLoad({ filter: /.*/, namespace: "autora" }, () => ({
      contents: `export { ${spec.register} as register } from ${JSON.stringify(path.join(checkout, spec.main))};\n${spec.extra.replace("MAIN", path.join(checkout, spec.main))}`,
      loader: "ts", resolveDir: path.join(checkout, "apps", app),
    }));
    b.onResolve({ filter: /\?(raw|asset|url)$/ }, (a) => {
      const [p, q] = a.path.split("?");
      let full = p;
      if (!path.isAbsolute(p)) {
        if (p.startsWith(".")) full = path.resolve(a.resolveDir, p);
        else full = createRequire(path.join(a.resolveDir, "x.js")).resolve(p);
      }
      return { path: full, namespace: `vite-${q}` };
    });
    b.onLoad({ filter: /.*/, namespace: "vite-raw" }, (a) => ({ contents: `export default ${JSON.stringify(fs.readFileSync(a.path, "utf8"))}`, loader: "js" }));
    b.onLoad({ filter: /.*/, namespace: "vite-url" }, (a) => ({ contents: `export default ${JSON.stringify(a.path)}`, loader: "js" }));
    b.onLoad({ filter: /.*/, namespace: "vite-asset" }, (a) => {
      const name = path.basename(a.path);
      fs.copyFileSync(a.path, path.join(assets, name));
      return { contents: `import p from "node:path"; export default p.join(__dirname, "assets", ${JSON.stringify(name)});`, loader: "js" };
    });
  },
};

await esbuild.build({
  entryPoints: [path.join(here, "entry.ts")],
  bundle: true, platform: "node", format: "cjs", target: "node20",
  outfile: path.join(out, `${app}.cjs`),
  alias: { electron: path.join(here, "electron-main.cjs") },
  tsconfig: path.join(checkout, spec.tsconfig),
  plugins: [viteLike],
  logLevel: "error",
  external: ["sharp", "canvas", "fsevents", "electron-updater"],
  loader: { ".wasm": "binary" },
  nodePaths: [path.join(checkout, "node_modules")],
});
console.log(`[office] host for ${app}: ${path.join(out, `${app}.cjs`)}`);
