import { defineConfig } from "vite";
import { resolve } from "node:path";
export default defineConfig({
  root: resolve("apps/web"),
  build: {
    assetsInlineLimit: 0,
    outDir: resolve("dist/web"),
    emptyOutDir: true,
  },
});
