import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { installedHost } from "./installed-host.mjs";
const root = installedHost();
assert.equal(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version, "1.0.4", "smoke requires supported installed Pi");
const result = spawnSync("python3", [fileURLToPath(new URL("./real-pi-pty.py", import.meta.url)),
  join(root, "dist/bundle/cli.js"), fileURLToPath(new URL("../index.ts", import.meta.url)),
  fileURLToPath(new URL("./real-pi-probe.ts", import.meta.url))], { encoding: "utf8", timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
assert.ifError(result.error);
assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
process.stdout.write(result.stdout);
