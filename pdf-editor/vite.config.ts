import fs from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin, type Rollup } from "vite";

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
 * The editor as one file: its script, styles, fonts and images inside
 * index.html. The frame has no origin, so every request it makes for a file of
 * its own goes without cookies, and a login proxy in front of Autora
 * (Umbrel's) answers those with its login page: the frame stayed white. Only
 * the page itself, a navigation, is sent with them. (pdf.js's data is fetched
 * by the page around the frame instead; see src/lib/pdfjs.ts.)
 */
function singleFile(): Plugin {
  // Inside a <script>, these would end it or change how it is read. Neither
  // is in the bundle; rewriting them could break a regular expression.
  const safe = (code: string) => {
    if (/<\/script|<!--/i.test(code)) throw new Error("single-file: the script has </script or <!-- in it");
    return code;
  };
  return {
    name: "single-file",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const html = Object.values(bundle).find((f): f is Rollup.OutputAsset => f.type === "asset" && f.fileName === "index.html");
      if (!html) throw new Error("single-file: no index.html in the build");
      let page = String(html.source);
      for (const file of Object.values(bundle)) {
        const ref = `./${file.fileName}`;
        if (file.type === "chunk" && file.isEntry) {
          if (Object.keys(file.dynamicImports).length) throw new Error(`single-file: ${file.fileName} imports others at runtime`);
          const tag = new RegExp(`<script type="module" crossorigin src="${ref.replace(/[.]/g, "\\.")}"></script>`);
          if (!tag.test(page)) throw new Error(`single-file: no tag for ${file.fileName}`);
          page = page.replace(tag, () => `<script type="module">${safe(file.code)}</script>`);
          delete bundle[file.fileName];
        } else if (file.type === "asset" && file.fileName.endsWith(".css")) {
          const tag = new RegExp(`<link rel="stylesheet" crossorigin href="${ref.replace(/[.]/g, "\\.")}">`);
          if (!tag.test(page)) throw new Error(`single-file: no tag for ${file.fileName}`);
          page = page.replace(tag, () => `<style>${String(file.source).replace(/<\/(style)/gi, "<\\/$1")}</style>`);
          delete bundle[file.fileName];
        }
      }
      const left = Object.keys(bundle).filter((f) => f !== "index.html");
      if (left.length) throw new Error(`single-file: left outside index.html: ${left.join(", ")}`);
      html.source = page;
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
  plugins: [react(), tailwindcss(), pdfjsData(), singleFile()],
  // Classic workers: a sandboxed frame without an origin cannot start a module one.
  worker: { format: "iife" },
  build: {
    outDir,
    emptyOutDir: true,
    // Fonts and images as data: URLs, so nothing is fetched (see singleFile).
    assetsInlineLimit: () => true,
    chunkSizeWarningLimit: 4000,
  },
});
