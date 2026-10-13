import fs from "node:fs";
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
const rows = Object.entries(lock.packages)
  .filter(([p]) => p)
  .map(
    ([p, v]) =>
      `| ${p.replace("node_modules/", "")} | ${v.version} | ${v.license ?? "See package LICENSE"} | ${v.dev ? "Build/test" : "Runtime"} |`,
  );
fs.writeFileSync(
  "docs/DEPENDENCIES.md",
  "# Dependency licenses\n\nGenerated from the checked-in lockfile. Retain upstream notices/LICENSE files when distributing. Runtime and build tooling have separate obligations; the Node/container base image also includes its own notices. Soniox service use remains subject to its commercial terms. This inventory is not legal advice or a full binary distribution audit. Regenerate with `node scripts/dependency-notices.mjs`.\n\n| Package | Version | License | Scope |\n| --- | --- | --- | --- |\n" +
    rows.join("\n") +
    "\n",
);
