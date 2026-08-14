import type { Model, ModelThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";

export const PROVIDER_ID = "command-code";
export const PROVIDER_NAME = "Command Code";
export const COMMAND_CODE_API = "command-code" as const;
export const COMMAND_CODE_BASE_URL = "https://api.commandcode.ai";
export const GATEWAY_DEFAULT_MAX_TOKENS = 64_000;

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

// Command Code 1.22.0 bundled catalogue. The five entries marked OpenRouter below
// fill limits omitted by Command Code; they are compatibility metadata, not
// Command Code vendor claims. Source retrieval date: 2026-08-12.
const seeds: readonly Seed[] = [
  ["deepseek/deepseek-v4-pro", "DeepSeek V4 Pro (latest)", 1_000_000, ["high", "max"], 0.435, 0.87, 0.003625],
  ["deepseek/deepseek-v4-flash", "DeepSeek V4 Flash (latest)", 1_000_000, ["high", "max"], 0.14, 0.28, 0.0028],
  ["moonshotai/Kimi-K3", "Kimi K3", 1_000_000, [], 3, 15, 0.3],
  ["moonshotai/Kimi-K2.7-Code", "Kimi K2.7 Code", 262_144, [], 0.95, 4, 0.19],
  ["moonshotai/Kimi-K2.7-Code-Highspeed", "Kimi K2.7 Code HighSpeed", 268_288, [], 1.9, 8, 0.38],
  ["moonshotai/Kimi-K2.6", "Kimi K2.6", 262_144, [], 0.95, 4, 0.16],
  ["moonshotai/Kimi-K2.5", "Kimi K2.5", 262_144, [], 0.6, 3, 0.1],
  ["zai-org/GLM-5.2", "GLM-5.2", 1_000_000, ["high", "max"], 1.4, 4.4, 0.26],
  ["zai-org/GLM-5.2-Fast", "GLM-5.2 Fast", 1_000_000, [], 3, 10.25, 0.5],
  // OpenRouter: https://openrouter.ai/api/v1/models/z-ai/glm-5.1-20260406/endpoints
  // 204,800 context; 131,072 top-provider completion.
  ["zai-org/GLM-5.1", "GLM-5.1", 204_800, [], 1.4, 4.4, 0.26, 0, 131_072],
  ["zai-org/GLM-5", "GLM-5", 204_800, [], 1, 3.2, 0.2],
  ["MiniMaxAI/MiniMax-M3", "MiniMax M3", 1_000_000, [], 0.3, 1.2, 0.06],
  // OpenRouter: https://openrouter.ai/api/v1/models/minimax/minimax-m2.7-20260318/endpoints
  ["MiniMaxAI/MiniMax-M2.7", "MiniMax M2.7", 204_800, [], 0.3, 1.2, 0.06, 0, 131_072],
  ["MiniMaxAI/MiniMax-M2.5", "MiniMax M2.5", 204_800, [], 0.3, 1.2, 0.03],
  ["xiaomi/mimo-v2.5-pro", "MiMo V2.5 Pro", 1_000_000, [], 0.435, 0.87, 0.0036],
  ["xiaomi/mimo-v2.5", "MiMo V2.5", 1_000_000, [], 0.14, 0.28, 0.0028],
  ["Qwen/Qwen3.8-Max", "Qwen 3.8 Max", 1_000_000, ["low", "medium", "xhigh"], 2, 6, 0.25, 2.5],
  ["Qwen/Qwen3.7-Max", "Qwen 3.7 Max", 1_000_000, [], 2.5, 7.5, 0.5, 3.13],
  ["Qwen/Qwen3.7-Plus", "Qwen 3.7 Plus", 1_000_000, [], 0.4, 1.6, 0.08, 0.5],
  ["Qwen/Qwen3.7-Flash", "Qwen 3.7 Flash", 1_000_000, [], 0.03, 0.13, 0.006, 0.038],
  // OpenRouter: https://openrouter.ai/api/v1/models/qwen/qwen3.6-max-preview-20260420/endpoints
  ["Qwen/Qwen3.6-Max-Preview", "Qwen 3.6 Max Preview", 262_144, [], 1.3, 7.8, 0.26, 1.63, 65_536],
  // OpenRouter: https://openrouter.ai/api/v1/models/qwen/qwen3.6-plus/endpoints
  ["Qwen/Qwen3.6-Plus", "Qwen 3.6 Plus", 1_000_000, [], 0.5, 3, 0.1, 0, 65_536],
  ["stepfun/Step-3.7-Flash", "Step 3.7 Flash", 262_144, [], 0.2, 1.15, 0.04],
  ["stepfun/Step-3.5-Flash", "Step 3.5 Flash", 1_000_000, [], 0.1, 0.3, 0.02],
  ["tencent/hy3-paid", "Tencent Hy3", 268_288, [], 0.14, 0.58, 0.035],
  ["nvidia/nemotron-3-ultra-550b-a55b", "Nemotron 3 Ultra", 1_000_000, [], 0.6, 2.4, 0.12],
  ["thinkingmachines/inkling", "Inkling", 262_144, [], 1, 4.05, 0.17],
  ["thinkingmachines/inkling-small", "Inkling Small", 1_000_000, [], 0.5, 1.2, 0.1],
  ["poolside/laguna-s-2.1-free", "Laguna S 2.1", 262_144, [], 0, 0, 0],
  ["claude-sonnet-5", "Claude Sonnet 5", 1_000_000, ["low", "medium", "high", "xhigh", "max"], 2, 10, 0.2, 2.5],
  ["claude-sonnet-4-6", "Claude Sonnet 4.6", 1_000_000, ["low", "medium", "high", "xhigh", "max"], 3, 15, 0.3, 3.75],
  ["claude-fable-5", "Claude Fable 5", 1_000_000, ["low", "medium", "high", "xhigh", "max"], 10, 50, 1, 12.5],
  ["claude-opus-5", "Claude Opus 5", 1_000_000, ["low", "medium", "high", "xhigh", "max"], 5, 25, 0.5, 6.25],
  ["claude-opus-4-8", "Claude Opus 4.8", 1_000_000, ["low", "medium", "high", "xhigh", "max"], 5, 25, 0.5, 6.25],
  ["claude-opus-4-7", "Claude Opus 4.7", 1_000_000, ["low", "medium", "high", "xhigh", "max"], 5, 25, 0.5, 6.25],
  ["claude-haiku-4-5-20251001", "Claude Haiku 4.5", 204_800, [], 1, 5, 0.1, 1.25],
  ["gpt-5.6-sol", "GPT-5.6 Sol", 1_050_000, ["low", "medium", "high", "xhigh", "max"], 5, 30, 0.5, 6.25],
  ["gpt-5.6-terra", "GPT-5.6 Terra", 1_050_000, ["low", "medium", "high", "xhigh", "max"], 1, 6, 0.1, 1.25],
  ["gpt-5.6-luna", "GPT-5.6 Luna", 1_050_000, ["low", "medium", "high", "xhigh", "max"], 0.1, 0.6, 0.01, 0.125],
  // OpenRouter: https://openrouter.ai/api/v1/models/openai/gpt-5.5-20260423/endpoints
  ["gpt-5.5", "GPT-5.5", 1_050_000, ["low", "medium", "high", "xhigh"], 5, 30, 0.5, 0, 128_000],
  ["gpt-5.4", "GPT-5.4", 409_600, ["low", "medium", "high", "xhigh"], 2.5, 15, 0.25],
  ["gpt-5.3-codex", "GPT-5.3 Codex", 409_600, ["low", "medium", "high", "xhigh"], 2, 8, 0.5],
  ["gpt-5.4-mini", "GPT-5.4 Mini", 409_600, ["low", "medium", "high"], 0.75, 4.5, 0.075],
  ["google/gemini-3.6-flash", "Gemini 3.6 Flash", 1_000_000, ["low", "medium", "high"], 1.5, 7.5, 0.15],
  ["google/gemini-3.5-flash", "Gemini 3.5 Flash", 1_000_000, ["low", "medium", "high"], 1.5, 9, 0.15],
  ["google/gemini-3.5-flash-lite", "Gemini 3.5 Flash Lite", 1_000_000, ["low", "medium", "high"], 0.3, 2.5, 0.03],
  ["google/gemini-3.1-flash-lite", "Gemini 3.1 Flash Lite", 1_000_000, ["low", "medium", "high"], 0.25, 1.5, 0.03],
  ["sakana/fugu-ultra", "Fugu Ultra", 1_000_000, ["high", "xhigh"], 5, 30, 0.5],
  ["meta/muse-spark-1.1", "Muse Spark 1.1", 1_050_000, [], 1.25, 4.25, 0.15],
  ["meta/muse-spark-1.2", "Muse Spark 1.2", 1_050_000, [], 1.25, 4.25, 0.15],
  ["meta/muse-spark-1.2-contributor", "Muse Spark 1.2 Contributor", 1_050_000, [], 0.1, 0.2, 0.002],
  ["xai/grok-4.5", "Grok 4.5", 512_000, ["low", "medium", "high"], 2, 6, 0.5],
  ["xai/grok-4.6", "Grok 4.6", 512_000, ["low", "medium", "high", "xhigh"], 2, 6, 0.5],
];

function thinkingMap(efforts: readonly Effort[]): ThinkingLevelMap | undefined {
  if (!efforts.length) return undefined;
  const supported = new Set<ModelThinkingLevel>(efforts);
  const levels: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  return Object.fromEntries(levels.map((level) => [level, supported.has(level) ? level : null]));
}

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
    cost: { input, output, cacheRead, cacheWrite },
    contextWindow,
    maxTokens,
  }),
);

export function validateCatalogue(models = COMMAND_CODE_MODELS): void {
  if (models.length !== 53) throw new Error(`Command Code catalogue must contain exactly 53 models; found ${models.length}`);
  const ids = new Set(models.map((model) => model.id));
  if (ids.size !== models.length) throw new Error("Command Code catalogue contains duplicate model IDs");
  if (!ids.has("deepseek/deepseek-v4-flash")) throw new Error("Command Code catalogue is missing DeepSeek V4 Flash");
  for (const model of models) {
    if (model.provider !== PROVIDER_ID || model.api !== COMMAND_CODE_API || model.contextWindow <= 0 || model.maxTokens <= 0) {
      throw new Error(`Invalid Command Code model metadata for ${model.id}`);
    }
  }
}

validateCatalogue();
