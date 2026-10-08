import fs from "node:fs";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * Spectra's renderer, built as Autora's PDF window page.
 *
 * Spectra is a Tauri app: its renderer reaches its backend through six
 * `@tauri-apps/*` modules. Rather than edit five hundred renderer files to
 * talk to Autora, those six module names are aliased here to Autora's own
 * bridge (src/autora/), which answers the same calls over Autora's server.
 * The renderer is otherwise Spectra's, untouched.
 */
const shim = (name: string) => path.resolve(import.meta.dirname, "src/autora", name);

/** The metadata worker is an iife, which cannot code-split, so it is built
    without the lazily fetched translations (src/renderer/locale-loaders.ts)
    and stays English. */
const noLocalesInWorker = (): Plugin => ({
  name: "autora-no-locales-in-worker",
  enforce: "pre",
  resolveId(source) {
    return /locale-loaders$/.test(source) ? "\0empty-locale-loaders" : null;
  },
  load(id) {
    return id === "\0empty-locale-loaders" ? "export const LOCALE_LOADERS = {};" : null;
  },
});

/** pdf.js calls Map.prototype.getOrInsertComputed (a 2026 addition to the language), which an older Chrome, Safari or
    Firefox does not have: the page then fails to draw and the window stays grey. This is put in front of every
    chunk, the worker's included, so the editor works on whatever browser the person has. */
const POLYFILL = `;(function(){for(var C of [Map,WeakMap]){var P=C.prototype;if(!P.getOrInsert)Object.defineProperty(P,"getOrInsert",{configurable:true,writable:true,value:function(k,v){if(!this.has(k))this.set(k,v);return this.get(k)}});if(!P.getOrInsertComputed)Object.defineProperty(P,"getOrInsertComputed",{configurable:true,writable:true,value:function(k,f){if(!this.has(k))this.set(k,f(k));return this.get(k)}})}})();\n`;
const polyfillFirst = (): Plugin => ({
  name: "autora-polyfill-first",
  renderChunk(code, chunk) {
    return chunk.isEntry || /worker/i.test(chunk.fileName) ? { code: POLYFILL + code, map: null } : null;
  },
});

/**
 * pdf.js fetches these when it runs (it does not carry them inside itself): the decoders for fax, scanner and JPEG 2000
 * images, the CJK character maps, the standard fonts for a file that embeds none, and the CMYK colour profile. Spectra
 * stages them into its public folder; this build has no public folder, so they were never shipped, and what needed one
 * drew blank (a scan, a fax, a page set in a CJK font) or fell back to whatever the browser had. They go beside the
 * editor, where it looks (`pdfjs/<set>/`, see lib/pdfRenderer.ts).
 */
const PDFJS_SETS: Array<{ dir: string; must: string[] }> = [
  { dir: "wasm", must: ["jbig2.wasm", "openjpeg.wasm", "qcms_bg.wasm"] },
  { dir: "iccs", must: ["CGATS001Compat-v2-micro.icc"] },
  { dir: "standard_fonts", must: ["FoxitDingbats.pfb", "LiberationSans-Regular.ttf"] },
  { dir: "cmaps", must: ["UniJIS-UCS2-H.bcmap", "UniGB-UCS2-H.bcmap"] },
];
const shipPdfjsAssets = (): Plugin => ({
  name: "autora-ship-pdfjs-assets",
  apply: "build",
  closeBundle() {
    const from = path.resolve(import.meta.dirname, "node_modules/pdfjs-dist");
    const to = path.resolve(import.meta.dirname, "../dist/spectra-editor/pdfjs");
    fs.rmSync(to, { recursive: true, force: true });
    for (const set of PDFJS_SETS) {
      const dir = path.join(from, set.dir);
      const missing = set.must.filter((f) => !fs.existsSync(path.join(dir, f)));
      // A layout that moved is a build that stops here, not a viewer that quietly draws blank pages.
      if (missing.length) throw new Error(`pdfjs-dist has no ${missing.map((f) => `${set.dir}/${f}`).join(", ")}: the layout changed, fix PDFJS_SETS in spectra-editor/vite.config.ts`);
      fs.cpSync(dir, path.join(to, set.dir), { recursive: true });
    }
  },
});

/**
 * The editor as one page. It runs in a frame with no origin of its own, so what it fetches itself carries no cookies,
 * and behind a login proxy (Umbrel's) every such request is turned away: the frame's own page is the one thing that
 * gets through. So the script and the styles are put inside index.html, the workers inside the script (as blobs), and
 * pdf.js's own data files are asked for through the window that holds the frame (autora/host.ts, SpectraWindow).
 * Translations other than English are left out for the same reason they are from the worker: they are files fetched
 * on demand.
 */
const WORKER_SITES = /new Worker\(\s*new URL\('\.\/([\w-]+)\.worker\.ts',\s*import\.meta\.url\),\s*\{\s*type:\s*'module',?\s*\}\s*\)/g;
const singlePage = (): Plugin => ({
  name: "autora-single-page",
  enforce: "pre",
  transform(code, id) {
    const file = id.split("?")[0];
    // pdf.js's worker as a blob made from its own source.
    if (/lib\/pdfRenderer\.ts$/.test(file) && code.includes("pdf.worker.min.mjs?url")) {
      return {
        code: code.replace(
          /import workerUrl from 'pdfjs-dist\/build\/pdf\.worker\.min\.mjs\?url';/,
          "import workerSource from 'pdfjs-dist/build/pdf.worker.min.mjs?raw';\nconst workerUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));",
        ),
        map: null,
      };
    }
    // The editor's other workers, inline.
    if (/\.(ts|tsx)$/.test(file) && !/\.worker\.ts$/.test(file) && /new Worker\(\s*new URL\('\.\//.test(code)) {
      const names = new Set<string>();
      const out = code.replace(WORKER_SITES, (_all, name: string) => {
        names.add(name);
        return `new ${name.replace(/[^\w]/g, "_")}Worker__()`;
      });
      if (!names.size) return null;
      const imports = [...names].map((n) => `import ${n.replace(/[^\w]/g, "_")}Worker__ from './${n}.worker.ts?worker&inline';`).join("\n");
      return { code: `${imports}\n${out}`, map: null };
    }
    return null;
  },
  // Last, once Vite has finished with the chunks (it fills in its preload helper after the page is made).
  generateBundle: {
    order: "post",
    handler(_options, bundle) {
      const page = bundle["index.html"];
      if (!page || page.type !== "asset") return;
      const take = (href: string) => {
        const name = href.replace(/^\.\//, "");
        const found = bundle[name];
        if (!found) return null;
        delete bundle[name];
        return found.type === "chunk" ? found.code : String(found.source);
      };
      page.source = String(page.source)
        .replace(/<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/, (all, href: string) => {
          const code = take(href);
          // `</script` inside the code would end the tag early.
          return code === null ? all : `<script type="module">${code.replace(/<\/script/gi, "<\\/script")}</script>`;
        })
        .replace(/<link rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/, (all, href: string) => {
          const css = take(href);
          return css === null ? all : `<style>${css.replace(/<\/style/gi, "<\\/style")}</style>`;
        });
    },
  },
});

export default defineConfig({
  root: "src/renderer",
  base: "./",
  publicDir: false,
  plugins: [noLocalesInWorker(), singlePage(), react(), polyfillFirst(), shipPdfjsAssets()],
  resolve: {
    alias: {
      "@tauri-apps/api/core": shim("core.ts"),
      "@tauri-apps/api/event": shim("event.ts"),
      "@tauri-apps/api/window": shim("window.ts"),
      "@tauri-apps/api/webviewWindow": shim("webview-window.ts"),
      "@tauri-apps/plugin-fs": shim("fs.ts"),
      "@tauri-apps/plugin-updater": shim("updater.ts"),
      "@tauri-apps/plugin-dialog": shim("dialog.ts"),
      "@tauri-apps/plugin-shell": shim("shell.ts"),
    },
  },
  build: {
    outDir: path.resolve(import.meta.dirname, "../dist/spectra-editor"),
    emptyOutDir: true,
    // pdf.js ships its own worker; a sandboxed frame with no origin cannot
    // start a module worker, so it stays an iife like Autora's editor.
    chunkSizeWarningLimit: 8000,
    // One script, so there is nothing for the page to fetch (see singlePage).
    // One script, so there is nothing for the page to fetch (see singlePage).
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
  worker: { format: "iife", plugins: () => [noLocalesInWorker(), polyfillFirst()] },
});
