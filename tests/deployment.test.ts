import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  mkdir,
  cp,
  symlink,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
test("Termux installer rejects other systems and reruns preserve config, certificates and saved sessions (simulated package manager)", async () => {
  const rejected = spawnSync("bash", ["scripts/install-termux.sh"], {
    env: { ...process.env, PREFIX: "/usr" },
    encoding: "utf8",
  });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /Termux/);
  const root = await mkdtemp(join(tmpdir(), "linguaroom-install-"));
  try {
    await mkdir(join(root, "scripts"));
    for (const file of ["package.json", "package-lock.json", ".env.example"])
      await cp(file, join(root, file));
    await cp("dist", join(root, "dist"), { recursive: true });
    await symlink(resolve("node_modules"), join(root, "node_modules"));
    await cp(
      "scripts/diagnose-termux.sh",
      join(root, "scripts/diagnose-termux.sh"),
    );
    await mkdir(join(root, "bin"));
    await writeFile(join(root, "bin/pkg"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });
    await writeFile(
      join(root, "bin/npm"),
      '#!/usr/bin/env bash\necho "Simulated npm $*"\n',
      { mode: 0o755 },
    );
    const secret = "synthetic-deployment-marker";
    await writeFile(
      join(root, ".env"),
      `PORT=39481\nSONIOX_API_KEY=${secret}\n`,
    );
    await mkdir(join(root, "data"));
    await mkdir(join(root, "certs"));
    await writeFile(join(root, "data/preserve.json"), "saved-session");
    await writeFile(join(root, "certs/preserve.key"), "saved-certificate");
    for (let i = 0; i < 2; i++) {
      const result = spawnSync("bash", [resolve("scripts/install-termux.sh")], {
        env: {
          ...process.env,
          PREFIX: "/data/data/com.termux/files/usr",
          LINGUAROOM_DIR: root,
          PATH: `${root}/bin:${process.env.PATH}`,
        },
        encoding: "utf8",
        timeout: 20000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Production startup check passed/);
      assert.ok(!result.stdout.includes(secret));
    }
    assert.ok((await readFile(join(root, ".env"), "utf8")).includes(secret));
    assert.equal(
      await readFile(join(root, "data/preserve.json"), "utf8"),
      "saved-session",
    );
    assert.equal(
      await readFile(join(root, "certs/preserve.key"), "utf8"),
      "saved-certificate",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
