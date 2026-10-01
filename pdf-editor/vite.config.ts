import fs from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const outDir = path.resolve(import.meta.dirname, "../dist/pdf-editor");

/** pdf.js's character maps and standard fonts, which it fetches for some
    files, copied next to the editor (see src/lib/pdfjs.ts). */
function pdfjsData(): Plugin {
  return {
    name: "pdfjs-data",
    apply: "build",
    closeBundle() {
      const from = path.resolve(import.meta.dirname, "node_modules/pdfjs-dist");
      for (const dir of ["cmaps", "standard_fonts"]) {
        fs.cpSync(path.join(from, dir), path.join(outDir, "pdfjs", dir), { recursive: true });
      }
    },
  };
}

/**
 * The PDF window's editor, built into Autora's dist/ next to the app and
 * served from /pdf-editor/ (see server/pdfdesk.ts). Relative asset paths: the
 * page runs in a sandboxed frame with no origin of its own, so nothing in it
 * may assume where the app is mounted.
 */
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss(), pdfjsData()],
  // Classic workers: a sandboxed frame without an origin cannot start a module one.
  worker: { format: "iife" },
  build: {
    outDir,
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000,
  },
});
