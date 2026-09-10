import assert from "node:assert/strict";
import test from "node:test";
import {
  clampThinkingLevel,
  createModels,
  getSupportedThinkingLevels,
  type ModelThinkingLevel,
  type ModelsPublication,
  type Provider,
  type RefreshModelsContext,
} from "@earendil-works/pi-ai";
import commandCodeExtension, { createCommandCodeProvider } from "../index.ts";
import {
  COMMAND_CODE_MODELS,
  COMMAND_CODE_MODELS_URL,
  COMMAND_CODE_UNKNOWN_COST,
  fetchCommandCodeModels,
  mergeCommandCodeCatalogue,
  parseCommandCodeCatalogue,
} from "../src/catalogue.ts";
import { COMMAND_CODE_THINKING_METADATA } from "../src/thinking.ts";
import { buildPayload } from "../src/protocol.ts";

function payload(...ids: string[]) {
  return { object: "list", data: ids.map((id) => ({
    id, object: "model", created: 1_787_311_867, owned_by: "command-code",
    name: `Live ${id}`, context_length: 1_048_576,
  })) };
}
function response(...ids: string[]) { return Response.json(payload(...ids)); }
function catalogue(...ids: string[]) { return mergeCommandCodeCatalogue(parseCommandCodeCatalogue(payload(...ids))!); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function context(overrides: Partial<RefreshModelsContext> = {}): RefreshModelsContext {
  return {
    allowNetwork: true,
    signal: new AbortController().signal,
    async publish(publication) {
      assert.equal(Object.hasOwn(publication, "persist"), false);
      publication.update?.();
      return true;
    },
    ...overrides,
  };
}
// Exercise the real SDK's refresh/auth/generation machinery without reading credentials.
function configured(provider: Provider): Provider {
  return { ...provider, auth: { apiKey: {
    name: "Test credentials",
    async check() { return { type: "api_key", source: "test" }; },
    async resolve() { return { auth: { apiKey: "test-only" }, source: "test" }; },
  } } };
}

const museEfforts = ["low", "medium", "high", "xhigh"] as const;
for (const id of ["meta/muse-spark-1.1", "meta/muse-spark-1.2", "meta/muse-spark-1.2-contributor", "meta/muse-spark-1.3", "meta/muse-spark-1.3-contributor"]) {
  test(`${id}: real Pi thinking levels, clamping, and serialized payload`, () => {
    assert.equal(COMMAND_CODE_THINKING_METADATA.sourceVersion, "1.50.0");
    const expected: ModelThinkingLevel[] = id === "meta/muse-spark-1.3" ? [...museEfforts, "max"] : [...museEfforts];
    for (const model of [...catalogue(id, `${id}-unverified`), ...catalogue(id.toUpperCase())]) {
      if (model.id.endsWith("-unverified")) {
        assert.deepEqual(getSupportedThinkingLevels(model), ["off"]);
        assert.equal(buildPayload(model, { messages: [] }, { reasoning: "max" }).params.reasoning_effort, undefined);
        continue;
      }
      assert.deepEqual(getSupportedThinkingLevels(model), expected);
      assert.equal(clampThinkingLevel(model, "off"), "low");
      assert.equal(clampThinkingLevel(model, "minimal"), "low");
      assert.equal(clampThinkingLevel(model, "max"), expected.at(-1));
      for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max", undefined] as const) {
        const serialized = JSON.parse(JSON.stringify(buildPayload(model, { messages: [] }, { reasoning: level === "off" ? undefined : level })));
        if (level && expected.includes(level)) assert.equal(serialized.params.reasoning_effort, level);
        else assert.equal(Object.hasOwn(serialized.params, "reasoning_effort"), false);
      }
      assert.deepEqual(model.input, ["text"]);
      assert.equal(model.maxTokens, 64_000);
      if (id.includes("1.3")) assert.strictEqual(model.cost, COMMAND_CODE_UNKNOWN_COST);
    }
    const fallback = COMMAND_CODE_MODELS.find((model) => model.id === id);
    assert.ok(fallback, `missing audited fallback ${id}`);
    assert.deepEqual(getSupportedThinkingLevels(fallback), expected);
  });
}

test("DeepSeek V4.1 refresh exposes low/high/max through real Pi helpers and Command Code payloads", async (t) => {
  const id = "deepseek/deepseek-v4.1-flash";
  const models = createModels();
  models.setProvider(configured(createCommandCodeProvider()));
  t.mock.method(globalThis, "fetch", async () => response(id));
  const result = await models.refresh();
  assert.equal(result.errors.size, 0);
  const model = models.getModel("command-code", id)!;
  assert.ok(model);
  assert.deepEqual(getSupportedThinkingLevels(model), ["low", "high", "max"]);
  assert.equal(clampThinkingLevel(model, "off"), "low");
  assert.equal(clampThinkingLevel(model, "minimal"), "low");
  assert.equal(clampThinkingLevel(model, "max"), "max");
  for (const level of ["low", "high", "max", "minimal", "medium", "xhigh", undefined] as const) {
    const serialized = JSON.parse(JSON.stringify(buildPayload(model, { messages: [] }, { reasoning: level })));
    assert.equal(serialized.params.model, id);
    if (level === "low" || level === "high" || level === "max") {
      assert.equal(serialized.params.reasoning_effort, level);
    } else {
      assert.equal(Object.hasOwn(serialized.params, "reasoning_effort"), false);
    }
  }
  assert.deepEqual(getSupportedThinkingLevels(catalogue("deepseek/deepseek-v4-flash")[0]!), ["high", "max"]);
});

test("other verified effort changes preserve holes; unrelated models remain conservative", () => {
  for (const [id, levels] of [
    ["moonshotai/Kimi-K3", ["low", "high", "max"]],
    ["zai-org/GLM-5.3", ["low", "high", "max"]],
    ["google/gemini-3.7-flash", ["low", "medium", "high"]],
    ["Qwen/Qwen3.8-27B", ["low", "medium", "xhigh"]],
  ] as const) {
    const model = catalogue(id)[0]!;
    assert.deepEqual(getSupportedThinkingLevels(model), levels);
    for (const level of levels) assert.equal(buildPayload(model, { messages: [] }, { reasoning: level }).params.reasoning_effort, level);
  }
  const unknown = catalogue("vendor/new-model")[0]!;
  assert.equal(unknown.reasoning, false);
  assert.strictEqual(unknown.cost, COMMAND_CODE_UNKNOWN_COST);
  assert.equal(buildPayload({ ...unknown, reasoning: true }, { messages: [] }, { reasoning: "high" }).params.reasoning_effort, undefined);
});

test("async factory awaits discovery before registration; repeated factories are independent, including fallback", async (t) => {
  const pending = deferred<Response>();
  const events: string[] = [];
  t.mock.method(globalThis, "fetch", async () => { events.push("fetch"); return await pending.promise; });
  const providers: Provider[] = [];
  const pi = {
    registerProvider(provider: Provider) {
      events.push("provider");
      assert.equal(provider.getModels()[0]?.id, "meta/muse-spark-1.3-contributor");
      providers.push(provider);
    },
    registerCommand() { events.push("command"); },
  };
  const startup = commandCodeExtension(pi as unknown as Parameters<typeof commandCodeExtension>[0]);
  assert.deepEqual(events, ["fetch"]);
  pending.resolve(response("meta/muse-spark-1.3-contributor"));
  await startup;
  assert.deepEqual(events, ["fetch", "provider", "command"]);

  t.mock.method(globalThis, "fetch", async () => { throw new Error("offline"); });
  const fallbackPi = { ...pi, registerProvider(provider: Provider) { providers.push(provider); } };
  await commandCodeExtension(fallbackPi as unknown as Parameters<typeof commandCodeExtension>[0]);
  await commandCodeExtension(fallbackPi as unknown as Parameters<typeof commandCodeExtension>[0]);
  assert.strictEqual(providers[1]!.getModels(), COMMAND_CODE_MODELS);
  assert.notStrictEqual(providers[1], providers[2]);
  const models = createModels();
  models.setProvider(configured(providers[1]!));
  const muse13Ids = ["meta/muse-spark-1.3", "meta/muse-spark-1.3-contributor"];
  for (const id of muse13Ids) {
    const model = models.getModel("command-code", id);
    assert.ok(model, `failed factory discovery must retain ${id}`);
    assert.ok(providers[2]!.getModels().some((model) => model.id === id));
    const expected: ModelThinkingLevel[] = id === "meta/muse-spark-1.3" ? [...museEfforts, "max"] : [...museEfforts];
    assert.deepEqual(getSupportedThinkingLevels(model), expected);
    assert.equal(clampThinkingLevel(model, "off"), "low");
    assert.equal(clampThinkingLevel(model, "max"), expected.at(-1));
    for (const level of expected) {
      const serialized = JSON.parse(JSON.stringify(buildPayload(model, { messages: [] }, { reasoning: level === "off" ? undefined : level })));
      assert.equal(serialized.params.reasoning_effort, level);
    }
    assert.equal(model.contextWindow, 1_048_576);
    assert.equal(model.maxTokens, 64_000);
    assert.deepEqual(model.input, ["text"]);
    assert.strictEqual(model.cost, COMMAND_CODE_UNKNOWN_COST);
  }
  t.mock.method(globalThis, "fetch", async () => response("vendor/refreshed"));
  const result = await models.refresh();
  assert.equal(result.errors.size, 0);
  assert.deepEqual(models.getModels("command-code").map((model) => model.id), ["vendor/refreshed"]);
  for (const id of muse13Ids) assert.equal(models.getModel("command-code", id), undefined);
  assert.strictEqual(providers[2]!.getModels(), COMMAND_CODE_MODELS);
  assert.equal(providers[0]!.getModels()[0]?.id, "meta/muse-spark-1.3-contributor");
});

test("real Models refresh publishes authoritative ordering/removals synchronously without storage mutations", async (t) => {
  const stale = { models: catalogue("vendor/stored-stale"), checkedAt: 1 };
  const models = createModels({ modelsStore: {
    async read() { return stale; },
    async write() { assert.fail("must not persist"); },
    async delete() { assert.fail("must not delete persisted data"); },
  } });
  const provider = createCommandCodeProvider();
  models.setProvider(configured(provider));
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (...[url, init]: Parameters<typeof fetch>) => {
    calls++;
    assert.equal(url, COMMAND_CODE_MODELS_URL);
    assert.equal(init?.redirect, "error");
    assert.deepEqual(init?.headers, { Accept: "application/json" });
    assert.ok(init?.signal instanceof AbortSignal);
    return response("vendor/first", "META/MUSE-SPARK-1.3-CONTRIBUTOR");
  });
  await models.refresh({ allowNetwork: false, force: true });
  assert.equal(calls, 0);
  assert.strictEqual(provider.getModels(), COMMAND_CODE_MODELS);
  const result = await models.refresh({ force: true });
  assert.equal(result.errors.size, 0);
  assert.equal(result.aborted, false);
  assert.equal(calls, 1);
  assert.deepEqual(models.getModels("command-code").map((m) => m.id), ["vendor/first", "META/MUSE-SPARK-1.3-CONTRIBUTOR"]);
  assert.equal(models.getModel("command-code", "stealth/ox-alpha"), undefined);
  assert.deepEqual(getSupportedThinkingLevels(provider.getModels()[1]!), museEfforts);
  t.mock.method(globalThis, "fetch", async () => response("META/MUSE-SPARK-1.3-CONTRIBUTOR", "vendor/first"));
  await models.refresh();
  assert.deepEqual(provider.getModels().map((m) => m.id), ["META/MUSE-SPARK-1.3-CONTRIBUTOR", "vendor/first"]);
});

test("refresh failure retains last good list; body timeout and caller cancellation settle", async (t) => {
  const provider = createCommandCodeProvider(catalogue("vendor/last-good"));
  const previous = provider.getModels();
  for (const fetch of [
    async () => new Response("unavailable", { status: 503 }),
    async () => new Response("{"),
    async () => Response.json({ object: "list", data: [] }),
    async () => { throw new Error("offline"); },
    async () => new Response(new Uint8Array(256 * 1024 + 1)),
  ]) {
    t.mock.method(globalThis, "fetch", fetch);
    await provider.refreshModels!(context({ publish: async () => assert.fail("failure must not publish") }));
    assert.strictEqual(provider.getModels(), previous);
  }
  let cancelled = false;
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    cancel() { cancelled = true; return new Promise(() => {}); },
  })));
  assert.equal(await fetchCommandCodeModels({ timeoutMs: 5 }), undefined);
  assert.equal(cancelled, true);
  cancelled = false;
  const controller = new AbortController();
  const refresh = provider.refreshModels!(context({ signal: controller.signal, publish: async () => assert.fail("abort must not publish") }));
  controller.abort();
  await refresh;
  assert.equal(cancelled, true);
  assert.strictEqual(provider.getModels(), previous);
});

test("real coding-agent composition keeps models.json overrides above refreshed native models", async (t) => {
  // Internal integration seam, resolved relative to the installed SDK, not a
  // copied composer stub. Supply config in memory without reading user files.
  const sdk = import.meta.resolve("@earendil-works/pi-coding-agent");
  const { ModelConfig } = await import(new URL("./core/model-config.js", sdk).href);
  const { composeModelProvider } = await import(new URL("./core/provider-composer.js", sdk).href);
  const config = await ModelConfig.load(undefined);
  const id = "meta/muse-spark-1.3-contributor";
  t.mock.method(config, "getProvider", () => ({ modelOverrides: { [id]: {
    name: "User label", thinkingLevelMap: { xhigh: null }, cost: { input: 7 },
  } } }));
  const base = createCommandCodeProvider(catalogue(id));
  const effective: Provider = composeModelProvider("command-code", configured(base), config, undefined);
  const models = createModels();
  models.setProvider(effective);
  t.mock.method(globalThis, "fetch", async () => response("vendor/first", id));
  await models.refresh();
  const model = models.getModel("command-code", id)!;
  assert.deepEqual(effective.getModels().map((m) => m.id), ["vendor/first", id]);
  assert.equal(model.name, "User label");
  assert.equal(model.cost.input, 7);
  assert.deepEqual(getSupportedThinkingLevels(model), ["low", "medium", "high"]);
  assert.equal(base.getModels()[1]!.name, `Live ${id}`);
  assert.deepEqual(getSupportedThinkingLevels(base.getModels()[1]!), museEfforts);
});

test("pre-aborted and network-disabled refreshes do no I/O; rejected publication leaves state unchanged", async (t) => {
  const provider = createCommandCodeProvider();
  t.mock.method(globalThis, "fetch", async () => assert.fail("must not fetch"));
  await provider.refreshModels!(context({ allowNetwork: false }));
  await provider.refreshModels!(context({ signal: AbortSignal.abort() }));
  t.mock.method(globalThis, "fetch", async () => response("vendor/rejected-generation"));
  let publication: ModelsPublication | undefined;
  await provider.refreshModels!(context({ publish: async (value) => { publication = value; return false; } }));
  assert.equal(typeof publication?.update, "function");
  assert.equal(Object.hasOwn(publication!, "persist"), false);
  assert.strictEqual(provider.getModels(), COMMAND_CODE_MODELS);
});

test("real Models rejects stale overlapping refresh and cancellation even when fetch resolves late", async (t) => {
  const models = createModels();
  const provider = createCommandCodeProvider();
  models.setProvider(configured(provider));
  const started = deferred<AbortSignal>();
  const pending = deferred<Response>();
  t.mock.method(globalThis, "fetch", async (...[_url, init]: Parameters<typeof fetch>) => {
    started.resolve(init!.signal!);
    return await pending.promise; // deliberately ignore abort until response arrival
  });
  const older = models.refresh();
  const signal = await started.promise;
  t.mock.method(globalThis, "fetch", async () => response("vendor/newest"));
  await models.refresh();
  assert.equal(signal.aborted, true);
  pending.resolve(response("vendor/stale"));
  await older;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(provider.getModels().map((m) => m.id), ["vendor/newest"]);

  const nextStarted = deferred<void>();
  t.mock.method(globalThis, "fetch", async (...[_url, init]: Parameters<typeof fetch>) => {
    nextStarted.resolve();
    return await new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }));
  });
  const controller = new AbortController();
  const cancelled = models.refresh({ signal: controller.signal });
  await nextStarted.promise;
  controller.abort();
  assert.equal((await cancelled).aborted, true);
  assert.deepEqual(provider.getModels().map((m) => m.id), ["vendor/newest"]);
});
