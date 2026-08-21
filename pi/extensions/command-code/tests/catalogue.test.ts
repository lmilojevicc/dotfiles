import assert from "node:assert/strict";
import test from "node:test";
import {
  COMMAND_CODE_API,
  COMMAND_CODE_CATALOGUE_LIMITS,
  COMMAND_CODE_MODELS,
  COMMAND_CODE_PRICING_METADATA,
  COMMAND_CODE_UNKNOWN_COST,
  GATEWAY_DEFAULT_MAX_TOKENS,
  PROVIDER_ID,
  mergeCommandCodeCatalogue,
  parseCommandCodeCatalogue,
  resolveCommandCodeModels,
  validateBundledCatalogue,
  validateCatalogue,
} from "../src/catalogue.ts";

const expectedSnapshotCosts = new Map<string, readonly [number, number, number, number]>([
  ["deepseek/deepseek-v4-pro", [0.66, 1.98, 0.022, 0]],
  ["deepseek/deepseek-v4-flash", [0.22, 0.66, 0.007, 0]],
  ["moonshotai/Kimi-K3", [3, 15, 0.3, 0]],
  ["moonshotai/Kimi-K2.7-Code", [0.95, 4, 0.19, 0]],
  ["moonshotai/Kimi-K2.7-Code-Highspeed", [1.9, 8, 0.38, 0]],
  ["moonshotai/Kimi-K2.6", [0.95, 4, 0.16, 0]],
  ["moonshotai/Kimi-K2.5", [0.6, 3, 0.1, 0]],
  ["zai-org/GLM-5.3", [1.4, 4.4, 0.26, 0]],
  ["zai-org/GLM-5.2", [1.4, 4.4, 0.26, 0]],
  ["zai-org/GLM-5.2-Fast", [3, 10.25, 0.5, 0]],
  ["zai-org/GLM-5.1", [1.4, 4.4, 0.26, 0]],
  ["zai-org/GLM-5", [1, 3.2, 0.2, 0]],
  ["MiniMaxAI/MiniMax-M3", [0.3, 1.2, 0.06, 0]],
  ["MiniMaxAI/MiniMax-M2.7", [0.3, 1.2, 0.06, 0]],
  ["MiniMaxAI/MiniMax-M2.5", [0.3, 1.2, 0.03, 0]],
  ["xiaomi/mimo-v2.5-pro", [0.435, 0.87, 0.0036, 0]],
  ["xiaomi/mimo-v2.5", [0.14, 0.28, 0.0028, 0]],
  ["Qwen/Qwen3.8-Max", [2, 6, 0.25, 2.5]],
  ["Qwen/Qwen3.8-27B", [0.4, 3, 0.04, 0]],
  ["Qwen/Qwen3.7-Max", [2.5, 7.5, 0.5, 3.13]],
  ["Qwen/Qwen3.7-Plus", [0.4, 1.6, 0.08, 0.5]],
  ["Qwen/Qwen3.7-Flash", [0.03, 0.13, 0.006, 0.038]],
  ["Qwen/Qwen3.6-Max-Preview", [1.3, 7.8, 0.26, 1.63]],
  ["Qwen/Qwen3.6-Plus", [0.5, 3, 0.1, 0]],
  ["stepfun/Step-3.7-Flash", [0.2, 1.15, 0.04, 0]],
  ["stepfun/Step-3.5-Flash", [0.1, 0.3, 0.02, 0]],
  ["tencent/hy3-paid", [0.14, 0.58, 0.035, 0]],
  ["nvidia/nemotron-3-ultra-550b-a55b", [0.6, 2.4, 0.12, 0]],
  ["thinkingmachines/inkling", [1, 4.05, 0.17, 0]],
  ["thinkingmachines/inkling-small", [0.5, 1.2, 0.1, 0]],
  ["poolside/laguna-s-2.1-free", [0, 0, 0, 0]],
  ["claude-sonnet-5", [2, 10, 0.2, 2.5]],
  ["claude-sonnet-4-6", [3, 15, 0.3, 3.75]],
  ["claude-fable-5", [10, 50, 1, 12.5]],
  ["claude-opus-5", [5, 25, 0.5, 6.25]],
  ["claude-opus-4-8", [5, 25, 0.5, 6.25]],
  ["claude-opus-4-7", [5, 25, 0.5, 6.25]],
  ["claude-haiku-4-5-20251001", [1, 5, 0.1, 1.25]],
  ["gpt-5.6-sol", [5, 30, 0.5, 6.25]],
  ["gpt-5.6-terra", [2, 12, 0.2, 2.5]],
  ["gpt-5.6-luna", [0.2, 1.2, 0.02, 0.25]],
  ["gpt-5.5", [5, 30, 0.5, 0]],
  ["gpt-5.4", [2.5, 15, 0.25, 0]],
  ["gpt-5.3-codex", [2, 8, 0.5, 0]],
  ["gpt-5.4-mini", [0.75, 4.5, 0.075, 0]],
  ["google/gemini-3.7-flash", [0.75, 3.75, 0.075, 0.04167]],
  ["google/gemini-3.6-flash", [1.5, 7.5, 0.15, 0]],
  ["google/gemini-3.5-flash", [1.5, 9, 0.15, 0]],
  ["google/gemini-3.5-flash-lite", [0.3, 2.5, 0.03, 0]],
  ["google/gemini-3.1-flash-lite", [0.25, 1.5, 0.03, 0]],
  ["sakana/fugu-ultra", [5, 30, 0.5, 0]],
  ["stealth/ox-alpha", [0, 0, 0, 0]],
  ["meta/muse-spark-1.1", [1.25, 4.25, 0.15, 0]],
  ["meta/muse-spark-1.2", [1.25, 4.25, 0.15, 0]],
  ["meta/muse-spark-1.2-contributor", [0.1, 0.2, 0.002, 0]],
  ["xai/grok-4.5", [2, 6, 0.5, 0]],
  ["xai/grok-4.6", [2, 6, 0.5, 0]],
]);

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

test("bundled prices match the audited Command Code snapshot", () => {
  assert.equal(COMMAND_CODE_PRICING_METADATA.sourceUrl, "https://commandcode.ai/docs/resources/pricing-limits");
  assert.equal(COMMAND_CODE_PRICING_METADATA.retrievedAt, "2026-08-21T12:52:28Z");
  assert.equal(COMMAND_CODE_PRICING_METADATA.units, "USD per 1,000,000 tokens");
  assert.equal(COMMAND_CODE_PRICING_METADATA.ratePolicy, "currently advertised primary flat token rate");
  assert.deepEqual(COMMAND_CODE_PRICING_METADATA.omittedCharges, [
    "routing, ZDR, and provider-specific variation",
    "temporary deals, time-of-day pricing, and long-context tiers",
    "media, web-search, reasoning, fixed-request, and alternate cache charges",
  ]);
  assert.equal(expectedSnapshotCosts.size, 57);
  assert.deepEqual([...expectedSnapshotCosts.keys()], COMMAND_CODE_MODELS.map((model) => model.id));

  for (const model of COMMAND_CODE_MODELS) {
    const expected = expectedSnapshotCosts.get(model.id);
    assert.ok(expected, `missing expected Command Code price for ${model.id}`);
    assert.deepEqual(
      [model.cost.input, model.cost.output, model.cost.cacheRead, model.cost.cacheWrite],
      expected,
      `Command Code price drift for ${model.id}`,
    );
  }
});

test("verified free fallback models remain distinct from future unknown-price placeholders", () => {
  assert.deepEqual(COMMAND_CODE_PRICING_METADATA.verifiedFreeModelIds, [
    "poolside/laguna-s-2.1-free",
    "stealth/ox-alpha",
  ]);
  assert.deepEqual(COMMAND_CODE_PRICING_METADATA.unknownPriceModelIds, []);

  const paidModels = COMMAND_CODE_MODELS.filter((model) => Object.values(model.cost).some((cost) => cost > 0));
  assert.equal(paidModels.length, 55);
  for (const id of COMMAND_CODE_PRICING_METADATA.verifiedFreeModelIds) {
    const cost = COMMAND_CODE_MODELS.find((model) => model.id === id)?.cost;
    assert.deepEqual(cost, COMMAND_CODE_UNKNOWN_COST);
    assert.notStrictEqual(cost, COMMAND_CODE_UNKNOWN_COST);
  }
});

test("live catalogue overlay preserves paid and free prices while safely defaulting new IDs", () => {
  const parsed = parseCommandCodeCatalogue(livePayload(
    liveModel("CLAUDE-SONNET-5", "Live Sonnet", 900_000),
    liveModel("POOLSIDE/LAGUNA-S-2.1-FREE", "Live Laguna", 200_000),
    liveModel("vendor/new-model", "New Model", 123_456),
  ));
  assert.ok(parsed);

  const models = mergeCommandCodeCatalogue(parsed);
  const knownPaid = models[0];
  const knownFree = models[1];
  const added = models[2];
  assert.ok(knownPaid);
  assert.equal(knownPaid.id, "CLAUDE-SONNET-5");
  assert.equal(knownPaid.name, "Live Sonnet");
  assert.equal(knownPaid.contextWindow, 900_000);
  assert.equal(knownPaid.reasoning, true);
  assert.equal(knownPaid.cost.input, 2);
  assert.deepEqual(knownFree?.cost, COMMAND_CODE_UNKNOWN_COST);
  assert.notStrictEqual(knownFree?.cost, COMMAND_CODE_UNKNOWN_COST);
  assert.ok(added);
  assert.equal(added.id, "vendor/new-model");
  assert.equal(added.reasoning, false);
  assert.deepEqual(added.input, ["text"]);
  assert.strictEqual(added.cost, COMMAND_CODE_UNKNOWN_COST);
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
