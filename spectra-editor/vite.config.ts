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

export default defineConfig({
  root: "src/renderer",
  base: "./",
  publicDir: false,
  plugins: [react(), polyfillFirst()],
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
  },
  worker: { format: "iife", plugins: () => [noLocalesInWorker(), polyfillFirst()] },
});
