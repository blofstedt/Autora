/*
 * Builds one of GenOffice's editor renderers as a single page Autora can show
 * in a sandboxed frame (and render headlessly). Copied into the pinned checkout
 * by scripts/build-office.mjs and run there with that checkout's own Vite, so
 * it resolves its React plugin and workspace packages as GenOffice does.
 *
 *   OFFICE_APP=docs OFFICE_OUT=/path vite build --config vite.autora.mjs
 *
 * The page is what a frame with no origin can use: no files fetched by itself
 * (a login proxy in front of Autora turns those away -- the PDF editor is one
 * file for the same reason), so the script, the styles and the worker are inside
 * index.html, fonts are listed in a manifest the shim loads through the host,
 * and PDF import (which the PDF editor does better) is cut out.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = process.env.OFFICE_APP || "docs";
const out = path.resolve(process.env.OFFICE_OUT || path.join(here, "dist-autora"));
const shimDir = path.resolve(process.env.OFFICE_SHIM || path.join(here, "../../office/shim"));
const root = path.join(here, "src/renderer");

const ALIASES = {
  slides: {
    "@genoffice/pptx-engine/table-grid": "../../packages/pptx-engine/src/table-grid.ts",
    "@genoffice/pptx-engine/identity": "../../packages/pptx-engine/src/identity.ts",
    "@genoffice/pptx-engine/named-action": "../../packages/pptx-engine/src/named-action.ts",
    "@genoffice/pptx-engine/custgeom": "../../packages/pptx-engine/src/custgeom.ts",
    "@genoffice/pptx-engine/background-promote": "../../packages/pptx-engine/src/background-promote.ts",
    "@genoffice/pptx-engine": "../../packages/pptx-engine/src/index.ts",
    "@genoffice/pptx-ops/op-docs": "../../packages/pptx-ops/src/op-docs.ts",
    "@genoffice/pptx-ops/font-size": "../../packages/pptx-ops/src/font-size.ts",
    "@genoffice/pptx-ops": "../../packages/pptx-ops/src/index.ts",
    "@genoffice/pptx-render/preset-geometry": "../../packages/pptx-render/src/preset-geometry.ts",
    "@genoffice/pptx-render": "../../packages/pptx-render/src/index.ts",
    "@genoffice/pipelines/slides/layout-audit": "../../packages/pipelines/src/slides/layout-audit.ts",
    "@genoffice/pipelines/slides": "../../packages/pipelines/src/slides/index.ts",
    "@genoffice/docx-engine/metafile": "../../packages/docx-engine/src/metafile.ts",
    "@genoffice/docx-engine/math": "../../packages/docx-engine/src/math.ts",
  },
  docs: {
    "@genoffice/docx-engine/lazy-media": "../../packages/docx-engine/src/lazy-media.ts",
    "@genoffice/docx-engine/zip-splice": "../../packages/docx-engine/src/zip-splice.ts",
    "@genoffice/docx-engine": "../../packages/docx-engine/src/index.ts",
  },
};
const alias = Object.fromEntries(Object.entries(ALIASES[app] ?? {}).map(([k, v]) => [k, path.resolve(here, v)]));

/** Faces too big to carry for a few documents (Chinese, Japanese, Korean subsets): the browser's own fonts stand in. */
const SKIP_FONT = /CJK|GenOffice(?:Serif|Sans|Gothic|CheLatin)KR/i;

const read = (f) => fs.readFileSync(path.join(shimDir, f), "utf8");
/** Slides and Sheets: the app's real preload (built by scripts/build-office.mjs over the stand-in for electron), which speaks to the engine. */
const preload = () => {
  const file = process.env.OFFICE_PRELOAD;
  if (!file) return "";
  return `<script>${fs.readFileSync(file, "utf8").replace(/<\/script/gi, "<\\/script")}</script>`;
};

function autoraPage() {
  return {
    name: "autora-page",
    enforce: "pre",
    // The editor's own CSP forbids our inline scripts and the host's messages.
    transformIndexHtml: {
      order: "pre",
      handler: (html) => html
        .replace(/<meta\s+http-equiv="Content-Security-Policy"[^>]*>/i, "")
        .replace("<head>", () => `<head><script>${read("common.js")}</script><script>${read("cursor.js")}</script>${preload()}<script>${read(`${app}.js`)}</script>`),
    },
    // The parse worker as an inline classic worker: a frame with no origin cannot start a module one.
    transform(code, id) {
      if (!/parse-off-thread\.ts$/.test(id.split("?")[0])) return null;
      const from = "new Worker(new URL('./parse-worker.ts', import.meta.url), { type: 'module' })";
      if (!code.includes(from)) throw new Error("autora: the parse worker is created differently now");
      return { code: `import ParseWorker from './parse-worker.ts?worker&inline'\n${code.replace(from, "new ParseWorker()")}`, map: null };
    },
    // PDF import is the PDF editor's job here; its engine is 1.8 MB.
    resolveId(id) {
      if (/^pdfjs-dist\/.*\/pdf\.worker\.min\.mjs\?url$/.test(id)) return "\0autora-pdfjs-worker";
      if (/^pdfjs-dist\/.*\/pdf\.mjs$/.test(id)) return "\0autora-pdfjs";
      return null;
    },
    load(id) {
      if (id === "\0autora-pdfjs-worker") return "export default ''";
      if (id === "\0autora-pdfjs") {
        return "const no = () => { throw new Error('Importing a PDF is done in the PDF editor here.') }\nexport const getDocument = no\nexport const GlobalWorkerOptions = {}\nexport default { getDocument: no, GlobalWorkerOptions }";
      }
      return null;
    },
  };
}

/**
 * The editors speak English here (the shim answers getLanguage with "en"), so the translations into the other
 * languages are weight: each app carries its strings in ~19 languages, and Univer (Excel) its own packs in as many for
 * every one of its plugins -- most of a 21 MB page. English and the source language (Chinese, which the strings fall
 * back to) stay; the rest are empty.
 */
const OTHER_LANGUAGES = new Set(["ja", "ko", "fr", "de", "es", "th", "id", "ru", "ar", "pt", "it", "pl", "cs", "nl", "ms", "he", "hi", "zh-TW", "vi", "tr", "sv", "uk"]);
function slimLanguages() {
  return {
    name: "autora-slim-languages",
    enforce: "pre",
    resolveId(id) {
      // Univer's packs: .../locales/ja-JP and so on; en-US stays.
      const m = /^@univerjs\/[\w-]+\/locales\/([\w-]+)$/.exec(id);
      if (m && m[1] !== "en-US") return "\0autora-empty-locale";
      return null;
    },
    load(id) {
      if (id === "\0autora-empty-locale") return "export default {}";
      const file = id.split("?")[0];
      const m = /\/i18n\/(?:[\w-]+\/)*([\w-]+)\.ts$/.exec(file);
      if (!m || !OTHER_LANGUAGES.has(m[1])) return null;
      // The same exports, with nothing in them: what is missing falls back to English.
      const names = [...fs.readFileSync(file, "utf8").matchAll(/export const (\w+)/g)].map((x) => x[1]);
      return names.length ? names.map((n) => `export const ${n} = {}`).join("\n") : null;
    },
  };
}

/**
 * Word warns that "Calibri" is missing, because on a machine without Microsoft's fonts it is drawn in the editor's
 * own copy of its metric twin (Carlito). The pages are laid out identically, so there is nothing to tell the person:
 * the fonts that have such a twin among the ones bundled are not reported. Any other font that is really absent still is.
 */
const TWINS = ["calibri", "cambria", "arial", "helvetica", "times new roman", "courier new"];
function knownTwins() {
  return {
    name: "autora-font-twins",
    enforce: "pre",
    transform(code, id) {
      if (!/renderer\/font-check\.ts$/.test(id.split("?")[0])) return null;
      const head = "export function checkMissingFonts(names: string[]): FontSubstitution[] {";
      if (!code.includes(head)) throw new Error("autora: checkMissingFonts is written differently now");
      return { code: code.replace(head, `${head}\n  names = names.filter((n) => !${JSON.stringify(TWINS)}.includes(n.trim().toLowerCase()))`), map: null };
    },
  };
}

/** The editor as one page, its fonts listed for the host to supply. */
function singlePage() {
  return {
    name: "autora-single-page",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const html = Object.values(bundle).find((f) => f.type === "asset" && f.fileName === "index.html");
      if (!html) throw new Error("autora: no index.html in the build");
      let page = String(html.source);

      // Fonts: out of the CSS and into a manifest.
      const faces = [];
      const skipped = new Set();
      for (const file of Object.values(bundle)) {
        if (file.type !== "asset" || !file.fileName.endsWith(".css")) continue;
        let css = String(file.source);
        css = css.replace(/@font-face\s*\{([^}]*)\}/g, (whole, body) => {
          const family = /font-family\s*:\s*["']?([^;"']+)["']?/.exec(body)?.[1]?.trim();
          const url = /url\(\s*["']?([^)"']+)["']?\s*\)/.exec(body)?.[1];
          if (!family || !url) return whole;
          let base = path.basename(url.split("?")[0]);
          if (url.startsWith("data:")) {
            // A face the bundler folded into the stylesheet: put it back as a file the host can supply.
            const data = Buffer.from(url.slice(url.indexOf(",") + 1), url.includes(";base64") ? "base64" : "utf8");
            const ext = /font\/(woff2?|ttf|otf)|application\/(font-woff2?|x-font-ttf)/.exec(url)?.[0]?.replace(/.*[/-]/, "") || "ttf";
            base = `${family.replace(/\W+/g, "")}-${createHash("sha1").update(data).digest("hex").slice(0, 8)}.${ext}`;
            if (SKIP_FONT.test(family)) return "";
            if (!bundle[`assets/${base}`]) this.emitFile({ type: "asset", fileName: `assets/${base}`, source: data });
          } else if (SKIP_FONT.test(base) || SKIP_FONT.test(family)) {
            skipped.add(base);
            return "";
          }
          faces.push({
            family,
            weight: /font-weight\s*:\s*([^;]+)/.exec(body)?.[1]?.trim() ?? "400",
            style: /font-style\s*:\s*([^;]+)/.exec(body)?.[1]?.trim() ?? "normal",
            range: /unicode-range\s*:\s*([^;]+)/.exec(body)?.[1]?.trim() ?? null,
            file: `${app}/assets/${base}`,
          });
          return "";
        });
        file.source = css;
      }
      // A skipped family can share a file with one that is kept (Korean faces reuse Carlito for Latin letters).
      const kept = new Set(faces.map((f) => path.basename(f.file)));
      for (const base of skipped) if (!kept.has(base)) delete bundle[`assets/${base}`];
      page = page.replace("<head>", `<head><script type="application/json" id="autora-fonts">${JSON.stringify(faces).replace(/</g, "\\u003c")}</script>`);

      // Inside a <script>, "</script" would end it and "<!--" would change how it is read. Both occur in the
      // editor's HTML handling, in strings and regular expressions; <\/script and <\x21-- mean the same there.
      const inlineScript = (code) => code.replace(/__VITE_PRELOAD__/g, "void 0").replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\x21--");
      for (const file of Object.values(bundle)) {
        if (file.type === "chunk" && file.isEntry) {
          if (file.imports.length || file.dynamicImports.length) throw new Error(`autora: ${file.fileName} imports others at runtime`);
          const tag = new RegExp(`<script type="module" crossorigin src="\\./${file.fileName.replace(/[.]/g, "\\.")}"></script>`);
          if (!tag.test(page)) throw new Error(`autora: no tag for ${file.fileName}`);
          // Start once the host has supplied the fonts.
          page = page.replace(tag, () => `<script type="module">await window.__autoraReady;\n${inlineScript(file.code)}</script>`);
          delete bundle[file.fileName];
        } else if (file.type === "asset" && file.fileName.endsWith(".css")) {
          const tag = new RegExp(`<link rel="stylesheet" crossorigin href="\\./${file.fileName.replace(/[.]/g, "\\.")}">`);
          if (!tag.test(page)) throw new Error(`autora: no tag for ${file.fileName}`);
          page = page.replace(tag, () => `<style>${String(file.source).replace(/<\/(style)/gi, "<\\/$1")}</style>`);
          delete bundle[file.fileName];
        }
      }
      html.source = page;
    },
  };
}

export default defineConfig({
  root,
  base: "./",
  plugins: [react(), slimLanguages(), knownTwins(), autoraPage(), singlePage()],
  resolve: { alias },
  worker: { format: "iife" },
  build: {
    outDir: path.join(out, app),
    emptyOutDir: true,
    target: "es2022",
    chunkSizeWarningLimit: 100000,
    // Pictures and icons inside the page; fonts stay files, which the host supplies.
    assetsInlineLimit: (file) => !/\.(ttf|woff2?|otf)$/i.test(file),
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
