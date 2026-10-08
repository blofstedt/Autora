import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import wasm from "vite-plugin-wasm";

/**
 * OpenCut's editor, built as Autora's video window page.
 *
 * OpenCut is a Next.js app; its editor is a client-side React tree that reaches
 * Next in a handful of places (links, images, the router). Rather than edit
 * those files, the `next/*` names are aliased to Autora's own stand-ins
 * (src/autora/shims/), the same way spectra-editor/ answers Spectra's Tauri
 * calls. Where the editor keeps its projects (IndexedDB, OPFS) is replaced by
 * files under overlay/web/, which keep them on Autora's server instead.
 */
const shim = (name: string) => path.resolve(import.meta.dirname, "src/autora/shims", name);

/**
 * OpenCut fetches its public files (the font atlas, effect previews) by absolute
 * path, `/fonts/...`, which on its own site is its own root. Here the page is
 * served under /opencut-editor/, where `/fonts/` is Autora's own folder, so the
 * paths are made relative to the page: the files that were copied in beside it.
 */
const publicBeside = (): Plugin => ({
  name: "autora-public-beside-page",
  enforce: "pre",
  transform(code, id) {
    if (!id.includes("/src/web/") || !/["'`]\/(fonts|effects|flags|shapes|icons)\//.test(code)) return null;
    return { code: code.replace(/(["'`])\/(fonts|effects|flags|shapes|icons)\//g, "$1./$2/"), map: null };
  },
});

export default defineConfig({
  base: "./",
  publicDir: path.resolve(import.meta.dirname, "src/web-public"),
  plugins: [publicBeside(), react(), wasm()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src/web"),
      "next/link": shim("link.tsx"),
      "next/image": shim("image.tsx"),
      "next/navigation": shim("navigation.ts"),
      "next/script": shim("script.tsx"),
      "next/font/google": shim("font.ts"),
    },
  },
  // OpenCut reads process.env.NODE_ENV in a few places; Vite fills that one in.
  define: { "process.env.NEXT_PUBLIC_SITE_URL": '"http://localhost"', "process.env.NEXT_RUNTIME": "undefined" },
  build: {
    outDir: path.resolve(import.meta.dirname, "../dist/opencut-editor"),
    emptyOutDir: true,
    target: "esnext",
    chunkSizeWarningLimit: 16000,
  },
  worker: { format: "es", plugins: () => [wasm()] },
});
