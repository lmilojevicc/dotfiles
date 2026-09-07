// Deliberately run WITHOUT register-sdk-loader.mjs or any Node resolve hooks.
// Only locating the installed Pi test host is test-specific; aliases/Jiti and
// extension factory loading below are Pi's unchanged production implementation.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";

process.env.JITI_FS_CACHE = "false";

test("Pi production loadExtensions awaits factory and registers native Command Code model offline", async () => {
  const sdkRoot = process.env.PI_COMMAND_CODE_TEST_SDK
    ? pathToFileURL(resolve(process.env.PI_COMMAND_CODE_TEST_SDK) + "/")
    : new URL("../", import.meta.resolve("@earendil-works/pi-coding-agent"));
  const metadata = JSON.parse(await readFile(new URL("package.json", sdkRoot), "utf8"));
  assert.equal(metadata.version, "0.85.1", "Re-audit production loader compatibility when upgrading Pi");
  const entry = fileURLToPath(new URL("../index.ts", import.meta.url));
  const cwd = fileURLToPath(new URL("../", import.meta.url));
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let completed = false;
  const id = "meta/muse-spark-1.3-contributor";
  globalThis.fetch = async (input, init) => {
    calls += 1;
    assert.equal(String(input), "https://api.commandcode.ai/provider/v1/models");
    assert.equal(init?.method ?? "GET", "GET");
    assert.equal(new Headers(init?.headers).has("authorization"), false);
    await new Promise((done) => setImmediate(done));
    assert.equal(completed, false, "factory must wait for discovery");
    return Response.json({ object: "list", data: [{
      id, object: "model", created: 1_787_311_867, owned_by: "command-code",
      name: "Offline production loader fixture", context_length: 1_048_576,
    }] });
  };
  try {
    // This internal entrypoint is the actual loader; public SDK exports omit it.
    const { loadExtensions } = await import(new URL("dist/core/extensions/loader.js", sdkRoot).href);
    const loaded = await loadExtensions([entry], cwd);
    completed = true;
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    assert.equal(calls, 1);
    assert.equal(loaded.runtime.pendingProviderRegistrations.length, 0);
    const registrations = loaded.runtime.pendingNativeProviderRegistrations;
    assert.equal(registrations.length, 1);
    assert.equal(registrations[0].extensionPath, entry);
    const provider = registrations[0].provider;
    assert.equal(provider.id, "command-code");
    const models = provider.getModels();
    assert.equal(models.length, 1, "live fixture, not fallback, was awaited");
    assert.equal(models[0].id, id);
    assert.equal(models[0].provider, "command-code");
    assert.equal(models[0].api, "command-code");
    assert.equal(models[0].name, "Offline production loader fixture");
    assert.equal(models[0].contextWindow, 1_048_576);
    assert.equal(loaded.extensions[0].commands.has("command-code-usage"), true);
    // Do not call credential resolution, refresh, inference, or usage handlers.
  } finally {
    globalThis.fetch = originalFetch;
  }
});
