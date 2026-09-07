import type { ModelThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";

export const COMMAND_CODE_THINKING_METADATA = Object.freeze({
  sourcePackage: "command-code",
  sourceVersion: "1.50.0",
  sourceFile: "dist/cli.mjs",
  sourceTable: "yr (getSupportedEfforts)",
});

type Effort = Exclude<ModelThinkingLevel, "off" | "minimal">;
const throughMax = ["low", "medium", "high", "xhigh", "max"] as const;
const throughXhigh = ["low", "medium", "high", "xhigh"] as const;
const throughHigh = ["low", "medium", "high"] as const;

// Checked-in exact-ID subset of the official CLI 1.50.0 effort table: existing
// fallback IDs plus Muse 1.3. No family inference, prices, or catalogue membership.
// The CLI's "Default" row is not evidence that reasoning can be switched off.
const effortsById = new Map<string, readonly Effort[]>([
  ["claude-sonnet-5", throughMax],
  ["claude-sonnet-4-6", throughMax],
  ["claude-fable-5", throughMax],
  ["claude-opus-5", throughMax],
  ["claude-opus-4-8", throughMax],
  ["claude-opus-4-7", throughMax],
  ["gpt-5.6-sol", throughMax],
  ["gpt-5.6-terra", throughMax],
  ["gpt-5.6-luna", throughMax],
  ["gpt-5.5", throughXhigh],
  ["gpt-5.4", throughXhigh],
  ["gpt-5.3-codex", throughXhigh],
  ["gpt-5.4-mini", throughHigh],
  ["deepseek/deepseek-v4-pro", ["high", "max"]],
  ["deepseek/deepseek-v4-flash", ["high", "max"]],
  ["moonshotai/kimi-k3", ["low", "high", "max"]],
  ["zai-org/glm-5.3", ["low", "high", "max"]],
  ["zai-org/glm-5.2", ["high", "max"]],
  ["google/gemini-3.7-flash", throughHigh],
  ["google/gemini-3.6-flash", throughHigh],
  ["google/gemini-3.5-flash", throughHigh],
  ["google/gemini-3.5-flash-lite", throughHigh],
  ["google/gemini-3.1-flash-lite", throughHigh],
  ["sakana/fugu-ultra", ["high", "xhigh"]],
  ["xai/grok-4.5", throughHigh],
  ["xai/grok-4.6", throughXhigh],
  ["qwen/qwen3.8-max", ["low", "medium", "xhigh"]],
  ["qwen/qwen3.8-27b", ["low", "medium", "xhigh"]],
  ["meta/muse-spark-1.1", throughXhigh],
  ["meta/muse-spark-1.2", throughXhigh],
  ["meta/muse-spark-1.2-contributor", throughXhigh],
  ["meta/muse-spark-1.3", throughMax],
  ["meta/muse-spark-1.3-contributor", throughXhigh],
]);

export function commandCodeThinking(id: string): { reasoning: boolean; thinkingLevelMap?: ThinkingLevelMap } {
  const efforts = effortsById.get(id.toLowerCase());
  if (!efforts) return { reasoning: false };
  const levels: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  const supported = new Set<ModelThinkingLevel>(efforts);
  return {
    reasoning: true,
    thinkingLevelMap: Object.fromEntries(levels.map((level) => [level, supported.has(level) ? level : null])),
  };
}
