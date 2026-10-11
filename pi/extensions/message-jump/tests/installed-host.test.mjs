import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { installedHost, installedLauncher } from "./installed-host.mjs";

function fixture(run) {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "message-jump-discovery-")));
  const install = join(temp, "agent/install");
  const root = join(install, "releases/1.1.0/node_modules/@earendil-works/pi-coding-agent");
  const launcher = join(temp, "agent/bin/pi");
  const current = join(install, "current-version");
  const manifest = { name: "@earendil-works/pi-coding-agent", version: "1.1.0", bin: { pi: "dist/bundle/cli.js" } };
  const json = (value) => writeFileSync(join(root, "package.json"), JSON.stringify(value));
  mkdirSync(join(root, "dist/bundle"), { recursive: true });
  mkdirSync(dirname(launcher), { recursive: true });
  mkdirSync(join(install, "releases/1.1.0/node_modules/.bin"), { recursive: true });
  json(manifest);
  writeFileSync(join(root, "dist/index.d.ts"), "export {};\n");
  writeFileSync(join(root, manifest.bin.pi), "#!/bin/sh\nprintf '1.1.0\\n'\n");
  chmodSync(join(root, manifest.bin.pi), 0o755);
  symlinkSync(join(root, manifest.bin.pi), join(install, "releases/1.1.0/node_modules/.bin/pi"));
  writeFileSync(current, "1.1.0\n");
  writeFileSync(launcher, `#!/bin/sh\ninstall="$(dirname "$0")/../install"\nexport PI_MANAGED_INSTALL_ROOT="$install"\nversion=$(cat "$install/current-version")\nexec "$install/releases/$version/node_modules/.bin/pi" "$@"\n`);
  chmodSync(launcher, 0o755);
  const env = { PATH: process.env.PATH, PI_BIN: launcher };
  try { run({ temp, install, root, launcher, current, manifest, json, env }); }
  finally { rmSync(temp, { recursive: true, force: true }); }
}

test("installedHost: explicit package, managed current-version, launcher-relative and symlink discovery", () => fixture(({ temp, install, root, launcher, env }) => {
  assert.equal(installedHost({ ...env, PI_PACKAGE_ROOT: root, PI_MANAGED_INSTALL_ROOT: "/missing" }), root);
  assert.equal(installedHost({ ...env, PI_MANAGED_INSTALL_ROOT: install }), root);
  assert.equal(installedHost(env), root);
  const link = join(temp, "pi-link"); symlinkSync(launcher, link);
  assert.equal(installedHost({ ...env, PI_BIN: link }), root);
  assert.equal(installedLauncher(env), launcher);
  const result = spawnSync(launcher, ["--version"], { env, encoding: "utf8" });
  assert.equal(result.status, 0); assert.equal(result.stdout.trim(), "1.1.0");
  // Traditional direct package-bin installations still work without a managed install directory.
  assert.equal(installedHost({ ...env, PI_BIN: join(root, "dist/bundle/cli.js") }), root);
}));

test("installedHost: invalid overrides, version traversal/mismatch, incomplete releases fail actionably", () => fixture(({ install, root, current, manifest, json, env }) => {
  assert.throws(() => installedHost({ ...env, PI_PACKAGE_ROOT: "/missing" }), /Invalid Pi package root.*PI_PACKAGE_ROOT/);
  assert.throws(() => installedHost({ ...env, PI_MANAGED_INSTALL_ROOT: "/missing" }), /Cannot read managed Pi version.*PI_PACKAGE_ROOT/);
  for (const version of ["", ".", "..", "../1.1.0", "1.1.0\n1.0.4", "not-a-version", " 1.1.0", "1.1.0 ", "1.1.0\n\n"]) {
    writeFileSync(current, version);
    assert.throws(() => installedHost(env), /Invalid managed Pi version/);
  }
  writeFileSync(current, "1.1.1\n"); assert.throws(() => installedHost(env), /Invalid Pi package root/);
  writeFileSync(current, "1.1.0\n");
  for (const changes of [{ name: "wrong" }, { version: "1.0.4" }, { version: "invalid" }, { bin: { pi: "../../escape" } }, { bin: { pi: "/tmp/pi" } }]) {
    json({ ...manifest, ...changes }); assert.throws(() => installedHost(env), /Invalid Pi package root/);
  }
  json(manifest);
  rmSync(join(install, "releases/1.1.0/node_modules/.bin/pi"));
  assert.throws(() => installedHost(env), /launcher target is missing.*Repair/);
  rmSync(current); assert.throws(() => installedHost(env), /Cannot read managed Pi version/);
  assert.throws(() => installedHost({ ...env, PI_BIN: "message-jump-no-such-bin" }), /Cannot locate.*PI_BIN/);
  writeFileSync(join(root, "package.json"), "invalid json");
  assert.throws(() => installedHost({ ...env, PI_PACKAGE_ROOT: root }), /Invalid Pi package root.*PI_PACKAGE_ROOT/);
  assert.throws(() => installedHost({ ...env, PI_BIN: join(root, manifest.bin.pi) }), /Cannot inspect package manifest.*PI_PACKAGE_ROOT/);
}));
