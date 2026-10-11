import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { installedHost, installedLauncher } from "./installed-host.mjs";
const root = installedHost();
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
assert.ok(["1.0.4", "1.1.0"].includes(manifest.version), "smoke requires Pi 1.0.4 or 1.1.0");
const cli = process.env.PI_PACKAGE_ROOT ? join(root, manifest.bin.pi) : installedLauncher();
const version = spawnSync(cli, ["--version"], { encoding: "utf8" });
assert.equal(version.status, 0, version.stderr);
assert.equal(version.stdout.trim(), manifest.version, "launcher and discovered package must select the same version");
const result = spawnSync("python3", [fileURLToPath(new URL("./real-pi-pty.py", import.meta.url)),
  cli, root, fileURLToPath(new URL("../index.ts", import.meta.url)),
  fileURLToPath(new URL("./real-pi-probe.ts", import.meta.url))], { encoding: "utf8", timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
assert.ifError(result.error);
assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
process.stdout.write(result.stdout);
