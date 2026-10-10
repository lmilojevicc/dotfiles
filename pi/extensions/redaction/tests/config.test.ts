import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, chmod, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isActive, loadConfig, offConfig, parseConfigJson, privateConfigPath, safeStatus, validateConfig } from "../src/config.ts";

test("XDG path is global-only; all omitted flags and missing config are off", async () => {
  assert.equal(privateConfigPath({ XDG_CONFIG_HOME: "/synthetic/config" }, "/synthetic/home"), "/synthetic/config/pi-redaction/config.json");
  assert.equal(privateConfigPath({ XDG_CONFIG_HOME: "relative" }, "/synthetic/home"), "/synthetic/home/.config/pi-redaction/config.json");
  assert.deepEqual(validateConfig({}), offConfig());
  assert.equal(isActive(validateConfig({ literals: { synthetic: "PRIVATE" } })), false);
  const dir = await mkdtemp(join(tmpdir(), "redaction-config-"));
  try { assert.equal((await loadConfig(join(dir, "missing"))).state, "inactive"); }
  finally { await rm(dir, { recursive: true, force: true }); }
});
test("strict schema rejects unknown flags, non-booleans, collisions and duplicate JSON keys privately", () => {
  for (const invalid of [null, [], { extra: true }, { sources: { userMessages: 1 } }, { detectors: { unknown: true } }, { literals: { "": "X" } }, { literals: { one: "X", two: "X" } }, { literals: { one: "two", two: "THREE" } }, { literals: { "prefix-ALIAS": "ALIAS" } }]) {
    assert.throws(() => validateConfig(invalid), { message: "Invalid redaction configuration" });
  }
  assert.throws(() => parseConfigJson('{"sources":{"userMessages":false,"userMessages":true}}'), { message: "Invalid redaction configuration" });
  assert.throws(() => parseConfigJson('{"literals":{"synthetic":"X","syntheti\\u0063":"Y"}}'));
  assert.equal(parseConfigJson('{"literals":{"a":"A","b":"B"},"sources":{"toolResults":true}}').sources.toolResults, true);
  assert.throws(() => parseConfigJson('synthetic raw config'), { message: "Invalid redaction configuration" });
});
test("owner-only config loading and status never expose dictionary or filesystem errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "redaction-config-"));
  const parent = join(dir, "private");
  await mkdir(parent, { mode: 0o700 });
  const path = join(parent, "config.json");
  try {
    const config = { literals: { "synthetic@example.test": "PRIVATE_MAIL" }, sources: { toolResults: true } };
    await writeFile(path, JSON.stringify(config), { mode: 0o600 });
    const loaded = await loadConfig(path);
    assert.equal(loaded.state, "active");
    const status = safeStatus(loaded);
    assert.match(status, /literals=1/);
    assert.ok(!status.includes("synthetic@example.test") && !status.includes("PRIVATE_MAIL") && !status.includes(path));
    await chmod(path, 0o644);
    assert.equal((await loadConfig(path)).state, "invalid");
    await chmod(path, 0o600);
    await chmod(parent, 0o777);
    assert.equal((await loadConfig(path)).state, "invalid");
    await chmod(parent, 0o700);
    await writeFile(path, "not valid synthetic policy");
    assert.equal((await loadConfig(path)).state, "invalid");
    const link = join(parent, "symlink.json");
    await symlink(path, link);
    assert.equal((await loadConfig(link)).state, "invalid");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
