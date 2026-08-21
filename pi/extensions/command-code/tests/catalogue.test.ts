import assert from "node:assert/strict";
import test from "node:test";
import {
  COMMAND_CODE_API,
  COMMAND_CODE_CATALOGUE_LIMITS,
  COMMAND_CODE_MODELS,
  GATEWAY_DEFAULT_MAX_TOKENS,
  PROVIDER_ID,
  mergeCommandCodeCatalogue,
  parseCommandCodeCatalogue,
  resolveCommandCodeModels,
  validateBundledCatalogue,
  validateCatalogue,
} from "../src/catalogue.ts";

function liveModel(id: string, name: string, contextLength: number): Record<string, unknown> {
  return {
    id,
    object: "model",
    created: 1_787_311_867,
    owned_by: "command-code",
    name,
    context_length: contextLength,
  };
}

function livePayload(...models: Record<string, unknown>[]): Record<string, unknown> {
  return { object: "list", data: models };
}

function neverCancellingBody(chunks: Uint8Array[], onCancel: () => void): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk) controller.enqueue(chunk);
    },
    cancel() {
      onCancel();
      return new Promise<void>(() => {});
    },
  });
}

async function settlesPromptly<T>(promise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("operation hung")), 500);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

test("bundled fallback catalogue projects the current audited model set", () => {
  assert.equal(COMMAND_CODE_MODELS.length, 57);
  assert.equal(new Set(COMMAND_CODE_MODELS.map((model) => model.id.toLowerCase())).size, 57);
  assert.ok(COMMAND_CODE_MODELS.every((model) =>
    model.provider === PROVIDER_ID
    && model.api === COMMAND_CODE_API
    && model.contextWindow > 0
    && model.maxTokens > 0
    && model.maxTokens <= model.contextWindow));
  assert.equal(COMMAND_CODE_MODELS.find((model) => model.id === "deepseek/deepseek-v4-flash")?.maxTokens, GATEWAY_DEFAULT_MAX_TOKENS);
  assert.equal(COMMAND_CODE_MODELS.find((model) => model.id === "zai-org/GLM-5.1")?.maxTokens, 131_072);
  assert.equal(COMMAND_CODE_MODELS.find((model) => model.id === "gpt-5.5")?.contextWindow, 400_000);
  assert.equal(COMMAND_CODE_MODELS.find((model) => model.id === "google/gemini-3.7-flash")?.cost.input, 0.75);
  validateBundledCatalogue();
});

test("live catalogue overlay preserves known metadata and safely defaults new IDs", () => {
  const parsed = parseCommandCodeCatalogue(livePayload(
    liveModel("CLAUDE-SONNET-5", "Live Sonnet", 900_000),
    liveModel("vendor/new-model", "New Model", 123_456),
  ));
  assert.ok(parsed);

  const models = mergeCommandCodeCatalogue(parsed);
  const known = models[0];
  const added = models[1];
  assert.ok(known);
  assert.equal(known.id, "CLAUDE-SONNET-5");
  assert.equal(known.name, "Live Sonnet");
  assert.equal(known.contextWindow, 900_000);
  assert.equal(known.reasoning, true);
  assert.equal(known.cost.input, 2);
  assert.ok(added);
  assert.equal(added.id, "vendor/new-model");
  assert.equal(added.reasoning, false);
  assert.deepEqual(added.input, ["text"]);
  assert.deepEqual(added.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(added.maxTokens, GATEWAY_DEFAULT_MAX_TOKENS);
});

test("live catalogue clamps output limits to reduced live context windows", () => {
  const parsed = parseCommandCodeCatalogue(livePayload(
    liveModel("zai-org/GLM-5.1", "Known Small Context", 1_000),
    liveModel("vendor/new-small-model", "Unknown Small Context", 2_000),
  ));
  assert.ok(parsed);

  const models = mergeCommandCodeCatalogue(parsed);
  assert.equal(models[0]?.maxTokens, 1_000);
  assert.equal(models[1]?.maxTokens, 2_000);
  assert.ok(models.every((model) => model.maxTokens <= model.contextWindow));
});

test("runtime discovery uses a valid remote catalogue", async () => {
  const models = await resolveCommandCodeModels({
    fetch: async () => new Response(JSON.stringify(livePayload(
      liveModel("claude-sonnet-5", "Renamed Sonnet", 777_777),
      liveModel("vendor/new-model", "New Model", 88_000),
    )), { status: 200, headers: { "Content-Type": "application/json" } }),
  });

  assert.equal(models.length, 2);
  assert.equal(models[0]?.name, "Renamed Sonnet");
  assert.equal(models[0]?.contextWindow, 777_777);
  assert.equal(models[0]?.reasoning, true);
  assert.equal(models[1]?.reasoning, false);
});

test("runtime discovery falls back on malformed schema and HTTP failure", async () => {
  const malformed = await resolveCommandCodeModels({
    fetch: async () => new Response(JSON.stringify({ object: "list", data: [{ id: "missing-fields" }] })),
  });
  const httpFailure = await resolveCommandCodeModels({
    fetch: async () => new Response("unavailable", { status: 503 }),
  });

  assert.strictEqual(malformed, COMMAND_CODE_MODELS);
  assert.strictEqual(httpFailure, COMMAND_CODE_MODELS);
});

test("runtime discovery accepts only status 200 and does not await body cancellation", async () => {
  let cancellations = 0;
  const body = neverCancellingBody([
    new TextEncoder().encode(JSON.stringify(livePayload(liveModel("vendor/model", "Model", 1_000)))),
  ], () => { cancellations += 1; });
  const models = await settlesPromptly(resolveCommandCodeModels({
    fetch: async () => new Response(body, { status: 206 }),
  }));

  assert.strictEqual(models, COMMAND_CODE_MODELS);
  assert.equal(cancellations, 1);
});

test("runtime discovery cancels declared and streamed oversized bodies without waiting", async () => {
  let declaredCancellations = 0;
  const declared = await settlesPromptly(resolveCommandCodeModels({
    fetch: async () => new Response(neverCancellingBody([], () => { declaredCancellations += 1; }), {
      status: 200,
      headers: { "Content-Length": String(COMMAND_CODE_CATALOGUE_LIMITS.responseBytes + 1) },
    }),
  }));
  assert.strictEqual(declared, COMMAND_CODE_MODELS);
  assert.equal(declaredCancellations, 1);

  let streamedCancellations = 0;
  const streamed = await settlesPromptly(resolveCommandCodeModels({
    fetch: async () => new Response(neverCancellingBody([
      new Uint8Array(COMMAND_CODE_CATALOGUE_LIMITS.responseBytes + 1),
    ], () => { streamedCancellations += 1; }), { status: 200 }),
  }));
  assert.strictEqual(streamed, COMMAND_CODE_MODELS);
  assert.equal(streamedCancellations, 1);
});

test("runtime discovery falls back on invalid JSON, network rejection, and a missing body", async () => {
  const invalidJson = await resolveCommandCodeModels({ fetch: async () => new Response("{") });
  const rejected = await resolveCommandCodeModels({ fetch: async () => { throw new Error("offline"); } });
  const missingBody = await resolveCommandCodeModels({ fetch: async () => new Response(null, { status: 200 }) });

  assert.strictEqual(invalidJson, COMMAND_CODE_MODELS);
  assert.strictEqual(rejected, COMMAND_CODE_MODELS);
  assert.strictEqual(missingBody, COMMAND_CODE_MODELS);
});

test("runtime discovery times out and falls back", async () => {
  const models = await settlesPromptly(resolveCommandCodeModels({
    timeoutMs: 5,
    fetch: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }),
  }));
  assert.strictEqual(models, COMMAND_CODE_MODELS);
});

test("catalogue parsing rejects duplicate IDs and invalid fields", () => {
  assert.equal(parseCommandCodeCatalogue(livePayload(
    liveModel("vendor/model", "Model", 1_000),
    liveModel("VENDOR/MODEL", "Duplicate", 2_000),
  )), undefined);
  assert.equal(parseCommandCodeCatalogue(livePayload(liveModel("bad id", "Model", 1_000))), undefined);
});

test("catalogue validation rejects duplicate IDs and output limits beyond context", () => {
  const duplicate = COMMAND_CODE_MODELS.map((model, index) => index === 1 ? { ...model, id: COMMAND_CODE_MODELS[0]!.id } : model);
  assert.throws(() => validateCatalogue(duplicate), /duplicate model IDs/);
  assert.throws(() => validateCatalogue([{ ...COMMAND_CODE_MODELS[0]!, contextWindow: 1, maxTokens: 2 }]), /Invalid Command Code model metadata/);
});
