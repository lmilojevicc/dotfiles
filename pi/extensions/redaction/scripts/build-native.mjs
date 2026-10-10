#!/usr/bin/env node
// No npm dependencies. Run from any directory; cargo is the only build prerequisite.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const nativeDir = resolve(dirname(fileURLToPath(import.meta.url)), "../native");
const library = {
  darwin: "libpi_redaction.dylib",
  linux: "libpi_redaction.so",
  win32: "pi_redaction.dll",
}[process.platform];
if (!library) throw new Error("Unsupported native build platform");
// Explicit host target and directory avoid ambient cargo cross-compilation settings.
const rustc = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
const host = rustc.stdout?.match(/^host: (\S+)$/m)?.[1];
if (rustc.error || rustc.status !== 0 || !host) {
  throw new Error("Cannot identify Rust build host");
}
const targetDir = join(nativeDir, "target");
const result = spawnSync("cargo", [
  "build", "--locked", "--release", "--features", "node", "--lib",
  "--manifest-path", join(nativeDir, "Cargo.toml"), "--target-dir", targetDir,
  "--target", host,
], { stdio: "inherit", cwd: nativeDir });
if (result.error || result.status !== 0) {
  console.error("Native redaction build failed");
  process.exit(1);
}
mkdirSync(nativeDir, { recursive: true });
copyFileSync(join(targetDir, host, "release", library), join(nativeDir, "redaction.node"));
console.log("Built native/redaction.node");
