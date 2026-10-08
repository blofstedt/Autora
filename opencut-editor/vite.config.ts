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

/**
 * Small edits to OpenCut's own files, made as they are read. The agent has to
 * find a clip or a track on the screen to move its cursor to it, and OpenCut's
 * timeline gives neither a handle, so two attributes are added where they are
 * made; and one field the wasm renderer wants under another name is sent under
 * both. The pinned commit is what these lines are read from; if a newer one
 * moves them the build stops here, rather than the cursor quietly pointing
 * nowhere or an effect layer quietly failing.
 */
const MARKS: Array<{ file: string; from: string; to: string }> = [
  {
    file: "/src/web/timeline/components/timeline-element.tsx",
    from: "onClick={(event) => onElementClick({ event, element })}",
    to: "data-element-id={element.id} onClick={(event) => onElementClick({ event, element })}",
  },
  {
    file: "/src/web/timeline/components/timeline-track.tsx",
    from: "aria-label={`Select ${track.name} track`}",
    to: "data-track-id={track.id} aria-label={`Select ${track.name} track`}",
  },
  {
    // The wasm renderer reads this one variant's field in snake_case; OpenCut sends it in camelCase, so a scene effect
    // (an effect layer) threw "missing field `effect_pass_groups`" on every frame. Both are sent; the one it does not
    // read is ignored.
    file: "/src/web/services/renderer/compositor/frame-descriptor.ts",
    from: 'type: "sceneEffect",\n\t\t\teffectPassGroups: [node.resolved.passes],',
    to: 'type: "sceneEffect",\n\t\t\teffectPassGroups: [node.resolved.passes],\n\t\t\teffect_pass_groups: [node.resolved.passes],',
  },
];
const markSources = (): Plugin => ({
  name: "autora-patch-sources",
  enforce: "pre",
  transform(code, id) {
    const marks = MARKS.filter((m) => id.endsWith(m.file));
    if (!marks.length) return null;
    let out = code;
    for (const m of marks) {
      if (!out.includes(m.from)) throw new Error(`autora-patch-sources: ${m.file} no longer has ${m.from}`);
      out = out.replace(m.from, m.to);
    }
    return { code: out, map: null };
  },
});

export default defineConfig({
  base: "./",
  publicDir: path.resolve(import.meta.dirname, "src/web-public"),
  plugins: [publicBeside(), markSources(), react(), wasm()],
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
