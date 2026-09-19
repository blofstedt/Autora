import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", assetsDir: "assets" },
  server: {
    // Dev server proxies to the Python harness so `pnpm dev` and `autora up`
    // can run side by side without CORS or a second origin.
    proxy: {
      "/api": "http://127.0.0.1:8817",
      "/ws": { target: "ws://127.0.0.1:8817", ws: true },
    },
  },
});
