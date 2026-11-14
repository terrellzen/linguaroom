import { defineConfig } from "vite";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
let build = process.env.GITHUB_SHA?.slice(0, 7);
if (!build) {
  try {
    build = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    build = "development";
  }
}
export default defineConfig({
  base: "./",
  define: { __APP_BUILD__: JSON.stringify(build) },
  root: resolve("apps/web"),
  build: {
    assetsInlineLimit: 0,
    outDir: resolve("dist/web"),
    emptyOutDir: true,
  },
});
