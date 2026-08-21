import type { Model, ModelThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";

export const PROVIDER_ID = "command-code";
export const PROVIDER_NAME = "Command Code";
export const COMMAND_CODE_API = "command-code" as const;
export const COMMAND_CODE_BASE_URL = "https://api.commandcode.ai";
export const GATEWAY_DEFAULT_MAX_TOKENS = 64_000;
export const COMMAND_CODE_PRICING_METADATA = Object.freeze({
  sourceUrl: "https://commandcode.ai/docs/resources/pricing-limits",
  retrievedAt: "2026-08-21T12:52:28Z",
  units: "USD per 1,000,000 tokens",
  ratePolicy: "currently advertised primary flat token rate",
  omittedCharges: Object.freeze([
    "routing, ZDR, and provider-specific variation",
    "temporary deals, time-of-day pricing, and long-context tiers",
    "media, web-search, reasoning, fixed-request, and alternate cache charges",
  ]),
  verifiedFreeModelIds: Object.freeze([
    "poolside/laguna-s-2.1-free",
    "stealth/ox-alpha",
  ]),
  unknownPriceModelIds: Object.freeze([] as string[]),
});
export const COMMAND_CODE_UNKNOWN_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

type Effort = Exclude<ModelThinkingLevel, "off">;
type Seed = readonly [
  id: string,
  name: string,
  contextWindow: number,
  efforts: readonly Effort[],
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite?: number,
  maxTokens?: number,
];

// Command Code 1.31.0 bundled fallback catalogue. Context windows come from the
// Provider API. Prices are Command Code's advertised primary rates in
// COMMAND_CODE_PRICING_METADATA units, except IDs explicitly marked unknown.
// Conditional charges are not representable by Pi's flat cost fields. The five
// entries marked OpenRouter below use inferred
// output limits only, never OpenRouter pricing.
const seeds: readonly Seed[] = [
  ["deepseek/deepseek-v4-pro", "DeepSeek V4 Pro (latest)", 1_000_000, ["high", "max"], 0.66, 1.98, 0.022],
  ["deepseek/deepseek-v4-flash", "DeepSeek V4 Flash (latest)", 1_000_000, ["high", "max"], 0.22, 0.66, 0.007],
  ["moonshotai/Kimi-K3", "Kimi K3", 1_000_000, [], 3, 15, 0.3],
  ["moonshotai/Kimi-K2.7-Code", "Kimi K2.7 Code", 256_000, [], 0.95, 4, 0.19],
  ["moonshotai/Kimi-K2.7-Code-Highspeed", "Kimi K2.7 Code HighSpeed", 262_000, [], 1.9, 8, 0.38],
  ["moonshotai/Kimi-K2.6", "Kimi K2.6", 256_000, [], 0.95, 4, 0.16],
  ["moonshotai/Kimi-K2.5", "Kimi K2.5", 256_000, [], 0.6, 3, 0.1],
  ["zai-org/GLM-5.3", "GLM-5.3", 1_000_000, [], 1.4, 4.4, 0.26],
  ["zai-org/GLM-5.2", "GLM-5.2", 1_000_000, ["high", "max"], 1.4, 4.4, 0.26],
  ["zai-org/GLM-5.2-Fast", "GLM-5.2 Fast", 1_000_000, [], 3, 10.25, 0.5],
  // OpenRouter: https://openrouter.ai/api/v1/models/z-ai/glm-5.1-20260406/endpoints
  // 131,072 top-provider completion; context comes from Command Code.
  ["zai-org/GLM-5.1", "GLM-5.1", 200_000, [], 1.4, 4.4, 0.26, 0, 131_072],
  ["zai-org/GLM-5", "GLM-5", 200_000, [], 1, 3.2, 0.2],
  ["MiniMaxAI/MiniMax-M3", "MiniMax M3", 1_000_000, [], 0.3, 1.2, 0.06],
  // OpenRouter: https://openrouter.ai/api/v1/models/minimax/minimax-m2.7-20260318/endpoints
  ["MiniMaxAI/MiniMax-M2.7", "MiniMax M2.7", 200_000, [], 0.3, 1.2, 0.06, 0, 131_072],
  ["MiniMaxAI/MiniMax-M2.5", "MiniMax M2.5", 200_000, [], 0.3, 1.2, 0.03],
  ["xiaomi/mimo-v2.5-pro", "MiMo V2.5 Pro", 1_000_000, [], 0.435, 0.87, 0.0036],
  ["xiaomi/mimo-v2.5", "MiMo V2.5", 1_000_000, [], 0.14, 0.28, 0.0028],
  ["Qwen/Qwen3.8-Max", "Qwen 3.8 Max", 1_000_000, ["low", "medium", "xhigh"], 2, 6, 0.25, 2.5],
  ["Qwen/Qwen3.8-27B", "Qwen 3.8 27B", 262_144, [], 0.4, 3, 0.04],
  ["Qwen/Qwen3.7-Max", "Qwen 3.7 Max", 1_000_000, [], 2.5, 7.5, 0.5, 3.13],
  ["Qwen/Qwen3.7-Plus", "Qwen 3.7 Plus", 1_000_000, [], 0.4, 1.6, 0.08, 0.5],
  ["Qwen/Qwen3.7-Flash", "Qwen 3.7 Flash", 1_000_000, [], 0.03, 0.13, 0.006, 0.038],
  // OpenRouter: https://openrouter.ai/api/v1/models/qwen/qwen3.6-max-preview-20260420/endpoints
  ["Qwen/Qwen3.6-Max-Preview", "Qwen 3.6 Max Preview", 200_000, [], 1.3, 7.8, 0.26, 1.63, 65_536],
  // OpenRouter: https://openrouter.ai/api/v1/models/qwen/qwen3.6-plus/endpoints
  ["Qwen/Qwen3.6-Plus", "Qwen 3.6 Plus", 200_000, [], 0.5, 3, 0.1, 0, 65_536],
  ["stepfun/Step-3.7-Flash", "Step 3.7 Flash", 256_000, [], 0.2, 1.15, 0.04],
  ["stepfun/Step-3.5-Flash", "Step 3.5 Flash", 1_000_000, [], 0.1, 0.3, 0.02],
  ["tencent/hy3-paid", "Tencent Hy3", 262_144, [], 0.14, 0.58, 0.035],
  ["nvidia/nemotron-3-ultra-550b-a55b", "Nemotron 3 Ultra", 1_000_000, [], 0.6, 2.4, 0.12],
  ["thinkingmachines/inkling", "Inkling", 256_000, [], 1, 4.05, 0.17],
  ["thinkingmachines/inkling-small", "Inkling Small", 1_000_000, [], 0.5, 1.2, 0.1],
  ["poolside/laguna-s-2.1-free", "Laguna S 2.1", 256_000, [], 0, 0, 0],
  ["claude-sonnet-5", "Claude Sonnet 5", 1_000_000, ["low", "medium", "high", "xhigh", "max"], 2, 10, 0.2, 2.5],
  ["claude-sonnet-4-6", "Claude Sonnet 4.6", 1_000_000, ["low", "medium", "high", "xhigh", "max"], 3, 15, 0.3, 3.75],
  ["claude-fable-5", "Claude Fable 5", 1_000_000, ["low", "medium", "high", "xhigh", "max"], 10, 50, 1, 12.5],
  ["claude-opus-5", "Claude Opus 5", 1_000_000, ["low", "medium", "high", "xhigh", "max"], 5, 25, 0.5, 6.25],
  ["claude-opus-4-8", "Claude Opus 4.8", 1_000_000, ["low", "medium", "high", "xhigh", "max"], 5, 25, 0.5, 6.25],
  ["claude-opus-4-7", "Claude Opus 4.7", 1_000_000, ["low", "medium", "high", "xhigh", "max"], 5, 25, 0.5, 6.25],
  ["claude-haiku-4-5-20251001", "Claude Haiku 4.5", 200_000, [], 1, 5, 0.1, 1.25],
  ["gpt-5.6-sol", "GPT-5.6 Sol", 1_050_000, ["low", "medium", "high", "xhigh", "max"], 5, 30, 0.5, 6.25],
  ["gpt-5.6-terra", "GPT-5.6 Terra", 1_050_000, ["low", "medium", "high", "xhigh", "max"], 2, 12, 0.2, 2.5],
  ["gpt-5.6-luna", "GPT-5.6 Luna", 1_050_000, ["low", "medium", "high", "xhigh", "max"], 0.2, 1.2, 0.02, 0.25],
  // OpenRouter: https://openrouter.ai/api/v1/models/openai/gpt-5.5-20260423/endpoints
  ["gpt-5.5", "GPT-5.5", 400_000, ["low", "medium", "high", "xhigh"], 5, 30, 0.5, 0, 128_000],
  ["gpt-5.4", "GPT-5.4", 400_000, ["low", "medium", "high", "xhigh"], 2.5, 15, 0.25],
  ["gpt-5.3-codex", "GPT-5.3 Codex", 400_000, ["low", "medium", "high", "xhigh"], 2, 8, 0.5],
  ["gpt-5.4-mini", "GPT-5.4 Mini", 400_000, ["low", "medium", "high"], 0.75, 4.5, 0.075],
  ["google/gemini-3.7-flash", "Gemini 3.7 Flash", 1_048_576, [], 0.75, 3.75, 0.075, 0.04167],
  ["google/gemini-3.6-flash", "Gemini 3.6 Flash", 1_000_000, ["low", "medium", "high"], 1.5, 7.5, 0.15],
  ["google/gemini-3.5-flash", "Gemini 3.5 Flash", 1_000_000, ["low", "medium", "high"], 1.5, 9, 0.15],
  ["google/gemini-3.5-flash-lite", "Gemini 3.5 Flash Lite", 1_000_000, ["low", "medium", "high"], 0.3, 2.5, 0.03],
  ["google/gemini-3.1-flash-lite", "Gemini 3.1 Flash Lite", 1_000_000, ["low", "medium", "high"], 0.25, 1.5, 0.03],
  ["sakana/fugu-ultra", "Fugu Ultra", 1_000_000, ["high", "xhigh"], 5, 30, 0.5],
  ["stealth/ox-alpha", "Ox Alpha", 1_048_576, [], 0, 0, 0],
  ["meta/muse-spark-1.1", "Muse Spark 1.1", 1_048_576, [], 1.25, 4.25, 0.15],
  ["meta/muse-spark-1.2", "Muse Spark 1.2", 1_048_576, [], 1.25, 4.25, 0.15],
  ["meta/muse-spark-1.2-contributor", "Muse Spark 1.2 Contributor", 1_048_576, [], 0.1, 0.2, 0.002],
  ["xai/grok-4.5", "Grok 4.5", 500_000, ["low", "medium", "high"], 2, 6, 0.5],
  ["xai/grok-4.6", "Grok 4.6", 500_000, ["low", "medium", "high", "xhigh"], 2, 6, 0.5],
];

function thinkingMap(efforts: readonly Effort[]): ThinkingLevelMap | undefined {
  if (!efforts.length) return undefined;
  const supported = new Set<ModelThinkingLevel>(efforts);
  const levels: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  return Object.fromEntries(levels.map((level) => [level, supported.has(level) ? level : null]));
}

export const COMMAND_CODE_MODELS_URL = `${COMMAND_CODE_BASE_URL}/provider/v1/models`;
export const COMMAND_CODE_CATALOGUE_LIMITS = Object.freeze({ responseBytes: 256 * 1024, timeoutMs: 3_000 });

export const COMMAND_CODE_MODELS: readonly Model<typeof COMMAND_CODE_API>[] = seeds.map(
  ([id, name, contextWindow, efforts, input, output, cacheRead, cacheWrite = 0, maxTokens = GATEWAY_DEFAULT_MAX_TOKENS]) => ({
    id,
    name,
    api: COMMAND_CODE_API,
    provider: PROVIDER_ID,
    baseUrl: COMMAND_CODE_BASE_URL,
    reasoning: efforts.length > 0,
    thinkingLevelMap: thinkingMap(efforts),
    input: ["text"],
    cost: COMMAND_CODE_PRICING_METADATA.unknownPriceModelIds.some((unknownId) => unknownId === id)
      ? COMMAND_CODE_UNKNOWN_COST
      : { input, output, cacheRead, cacheWrite },
    contextWindow,
    maxTokens,
  }),
);

type LiveModel = Readonly<{ id: string; name: string; contextWindow: number }>;
type FetchLike = typeof globalThis.fetch;
type CatalogueOptions = { fetch?: FetchLike; timeoutMs?: number };
type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : null;
}

export function parseCommandCodeCatalogue(value: unknown): readonly LiveModel[] | undefined {
  const root = object(value);
  if (!root || root.object !== "list" || !Array.isArray(root.data) || root.data.length === 0 || root.data.length > 1_000) {
    return undefined;
  }

  const models: LiveModel[] = [];
  const ids = new Set<string>();
  for (const value of root.data) {
    const model = object(value);
    if (!model
      || model.object !== "model"
      || model.owned_by !== "command-code"
      || typeof model.created !== "number"
      || !Number.isSafeInteger(model.created)
      || model.created < 0
      || typeof model.id !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(model.id)
      || typeof model.name !== "string"
      || model.name.length === 0
      || model.name.length > 200
      || /[\u0000-\u001f\u007f]/.test(model.name)
      || typeof model.context_length !== "number"
      || !Number.isSafeInteger(model.context_length)
      || model.context_length <= 0
      || model.context_length > 100_000_000) {
      return undefined;
    }
    const normalizedId = model.id.toLowerCase();
    if (ids.has(normalizedId)) return undefined;
    ids.add(normalizedId);
    models.push({ id: model.id, name: model.name, contextWindow: model.context_length });
  }
  return models;
}

export function mergeCommandCodeCatalogue(
  liveModels: readonly LiveModel[],
  fallbackModels: readonly Model<typeof COMMAND_CODE_API>[] = COMMAND_CODE_MODELS,
): readonly Model<typeof COMMAND_CODE_API>[] {
  const fallbackById = new Map(fallbackModels.map((model) => [model.id.toLowerCase(), model]));
  const models = liveModels.map<Model<typeof COMMAND_CODE_API>>((live) => {
    const fallback = fallbackById.get(live.id.toLowerCase());
    if (fallback) {
      return {
        ...fallback,
        id: live.id,
        name: live.name,
        contextWindow: live.contextWindow,
        maxTokens: Math.min(fallback.maxTokens, live.contextWindow),
      };
    }
    return {
      id: live.id,
      name: live.name,
      api: COMMAND_CODE_API,
      provider: PROVIDER_ID,
      baseUrl: COMMAND_CODE_BASE_URL,
      reasoning: false,
      input: ["text"],
      cost: COMMAND_CODE_UNKNOWN_COST,
      contextWindow: live.contextWindow,
      maxTokens: Math.min(GATEWAY_DEFAULT_MAX_TOKENS, live.contextWindow),
    };
  });
  validateCatalogue(models);
  return models;
}

async function readWithSignal(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  signal.throwIfAborted();
  return await new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    reader.read().then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function cancelResponseBody(response: Response): void {
  try { void response.body?.cancel().catch(() => undefined); } catch { /* best-effort cleanup */ }
}

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const declaredBytes = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredBytes) && declaredBytes > COMMAND_CODE_CATALOGUE_LIMITS.responseBytes) {
    cancelResponseBody(response);
    throw new Error("catalogue response too large");
  }
  if (!response.body) throw new Error("catalogue response has no body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  let complete = false;
  try {
    while (true) {
      const { done, value } = await readWithSignal(reader, signal);
      if (done) {
        complete = true;
        break;
      }
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > COMMAND_CODE_CATALOGUE_LIMITS.responseBytes) throw new Error("catalogue response too large");
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    if (!complete) {
      try { void reader.cancel().catch(() => undefined); } catch { /* best-effort cleanup */ }
    }
    try { reader.releaseLock(); } catch { /* pending cancellation releases later */ }
  }
  return JSON.parse(text);
}

export async function resolveCommandCodeModels(
  options: CatalogueOptions = {},
): Promise<readonly Model<typeof COMMAND_CODE_API>[]> {
  const fetch = options.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? COMMAND_CODE_CATALOGUE_LIMITS.timeoutMs;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(COMMAND_CODE_MODELS_URL, {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
    if (response.status !== 200) {
      cancelResponseBody(response);
      return COMMAND_CODE_MODELS;
    }
    const liveModels = parseCommandCodeCatalogue(await readBoundedJson(response, controller.signal));
    return liveModels ? mergeCommandCodeCatalogue(liveModels) : COMMAND_CODE_MODELS;
  } catch {
    return COMMAND_CODE_MODELS;
  } finally {
    clearTimeout(timeout);
  }
}

export function validateCatalogue(models: readonly Model<typeof COMMAND_CODE_API>[] = COMMAND_CODE_MODELS): void {
  if (models.length === 0) throw new Error("Command Code catalogue must not be empty");
  const ids = new Set(models.map((model) => model.id.toLowerCase()));
  if (ids.size !== models.length) throw new Error("Command Code catalogue contains duplicate model IDs");
  for (const model of models) {
    const costs = Object.values(model.cost);
    if (!model.id
      || !model.name
      || model.provider !== PROVIDER_ID
      || model.api !== COMMAND_CODE_API
      || !Number.isSafeInteger(model.contextWindow)
      || model.contextWindow <= 0
      || !Number.isSafeInteger(model.maxTokens)
      || model.maxTokens <= 0
      || model.maxTokens > model.contextWindow
      || !model.input.includes("text")
      || costs.some((cost) => typeof cost !== "number" || !Number.isFinite(cost) || cost < 0)) {
      throw new Error(`Invalid Command Code model metadata for ${model.id}`);
    }
  }
}

export function validateBundledCatalogue(): void {
  validateCatalogue(COMMAND_CODE_MODELS);
  if (COMMAND_CODE_MODELS.length !== 57) {
    throw new Error(`Command Code fallback catalogue must contain exactly 57 models; found ${COMMAND_CODE_MODELS.length}`);
  }
  if (!COMMAND_CODE_MODELS.some((model) => model.id === "deepseek/deepseek-v4-flash")) {
    throw new Error("Command Code fallback catalogue is missing DeepSeek V4 Flash");
  }

  const verifiedFreeIds = new Set(COMMAND_CODE_PRICING_METADATA.verifiedFreeModelIds);
  const unknownPriceIds = new Set(COMMAND_CODE_PRICING_METADATA.unknownPriceModelIds);
  const zeroPricedIds = COMMAND_CODE_MODELS
    .filter((model) => Object.values(model.cost).every((cost) => cost === 0))
    .map((model) => model.id);
  const classifiedZeroIds = new Set([...verifiedFreeIds, ...unknownPriceIds]);
  if (verifiedFreeIds.size !== COMMAND_CODE_PRICING_METADATA.verifiedFreeModelIds.length
    || unknownPriceIds.size !== COMMAND_CODE_PRICING_METADATA.unknownPriceModelIds.length
    || classifiedZeroIds.size !== verifiedFreeIds.size + unknownPriceIds.size
    || zeroPricedIds.length !== classifiedZeroIds.size
    || zeroPricedIds.some((id) => !classifiedZeroIds.has(id))) {
    throw new Error("Command Code free/unknown pricing metadata does not match the bundled catalogue");
  }
}

validateBundledCatalogue();
