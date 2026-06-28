/**
 * nvidia-nimo-fix — re-enables NVIDIA NIM models excluded from the built-in catalog.
 *
 * The built-in NVIDIA provider excludes several models (DeepSeek V4, MiniMax M2.7, etc.)
 * from its catalog because they have native first-class providers with better API support
 * (proper thinking format, Anthropic Messages API, etc.). Those native providers should be
 * preferred for full functionality.
 *
 * This extension registers ALL NVIDIA NIM models including the previously excluded ones so
 * they appear in the model selector. Use with caution: reasoning/thinking may behave differently
 * through NVIDIA's generic OpenAI-compatible endpoint compared to the native providers.
 *
 * ## Usage
 * Drop into ~/.pi/agent/extensions/ and run /reload, or start with:
 *   pi -e ~/.pi/agent/extensions/nvidia-nimo-fix.ts
 *
 * Auth is handled via the existing NVIDIA_API_KEY env var or nvidia entry in auth.json.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
const NVIDIA_HEADERS: Record<string, string> = { "NVCF-POLL-SECONDS": "3600" };
const NVIDIA_COMPAT: Record<string, unknown> = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	maxTokensField: "max_tokens",
	supportsStrictMode: false,
	supportsLongCacheRetention: false,
};

const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export default function nvidiaNimoFix(pi: ExtensionAPI) {
	pi.registerProvider("nvidia", {
		baseUrl: NVIDIA_BASE_URL,
		api: "openai-completions",
		apiKey: "$NVIDIA_API_KEY",
		headers: NVIDIA_HEADERS,
		models: [
			// ── Existing built-in models (copied from nvidia.models.ts) ──

			{
				id: "meta/llama-3.1-70b-instruct",
				name: "Llama 3.1 70b Instruct",
				reasoning: false,
				input: ["text"],
				cost: zeroCost,
				contextWindow: 128000,
				maxTokens: 4096,
				compat: NVIDIA_COMPAT,
			},
			{
				id: "meta/llama-3.1-8b-instruct",
				name: "Llama 3.1 8B Instruct",
				reasoning: false,
				input: ["text"],
				cost: zeroCost,
				contextWindow: 16000,
				maxTokens: 4096,
				compat: NVIDIA_COMPAT,
			},
			{
				id: "meta/llama-3.2-11b-vision-instruct",
				name: "Llama 3.2 11b Vision Instruct",
				reasoning: false,
				input: ["text", "image"],
				cost: zeroCost,
				contextWindow: 128000,
				maxTokens: 4096,
				compat: NVIDIA_COMPAT,
			},
			{
				id: "meta/llama-3.2-90b-vision-instruct",
				name: "Llama-3.2-90B-Vision-Instruct",
				reasoning: false,
				input: ["text", "image"],
				cost: zeroCost,
				contextWindow: 128000,
				maxTokens: 8192,
				compat: NVIDIA_COMPAT,
			},
			{
				id: "meta/llama-3.3-70b-instruct",
				name: "Llama 3.3 70b Instruct",
				reasoning: false,
				input: ["text"],
				cost: zeroCost,
				contextWindow: 128000,
				maxTokens: 4096,
				compat: NVIDIA_COMPAT,
			},
			{
				id: "mistralai/mistral-large-3-675b-instruct-2512",
				name: "Mistral Large 3 675B Instruct 2512",
				reasoning: false,
				input: ["text", "image"],
				cost: zeroCost,
				contextWindow: 262144,
				maxTokens: 262144,
				compat: NVIDIA_COMPAT,
			},
			{
				id: "mistralai/mistral-small-4-119b-2603",
				name: "mistral-small-4-119b-2603",
				reasoning: true,
				input: ["text", "image"],
				cost: zeroCost,
				contextWindow: 128000,
				maxTokens: 8192,
				compat: NVIDIA_COMPAT,
			},
			{
				id: "moonshotai/kimi-k2.6",
				name: "Kimi K2.6",
				reasoning: true,
				input: ["text", "image"],
				cost: zeroCost,
				contextWindow: 262144,
				maxTokens: 262144,
				compat: NVIDIA_COMPAT,
			},
			{
				id: "nvidia/nemotron-3-nano-30b-a3b",
				name: "nemotron-3-nano-30b-a3b",
				reasoning: true,
				input: ["text"],
				cost: zeroCost,
				contextWindow: 131072,
				maxTokens: 131072,
				compat: NVIDIA_COMPAT,
			},
			{
				id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
				name: "Nemotron 3 Nano Omni",
				reasoning: true,
				input: ["text", "image"],
				cost: zeroCost,
				contextWindow: 256000,
				maxTokens: 65536,
				compat: NVIDIA_COMPAT,
			},
			{
				id: "nvidia/nemotron-3-super-120b-a12b",
				name: "Nemotron 3 Super",
				reasoning: true,
				input: ["text"],
				cost: { input: 0.2, output: 0.8, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 262144,
				maxTokens: 262144,
				compat: NVIDIA_COMPAT,
			},
			{
				id: "nvidia/nemotron-3-ultra-550b-a55b",
				name: "Nemotron 3 Ultra 550B A55B",
				reasoning: true,
				input: ["text"],
				cost: { input: 0.5, output: 2.5, cacheRead: 0.15, cacheWrite: 0 },
				contextWindow: 1000000,
				maxTokens: 65536,
				compat: NVIDIA_COMPAT,
			},
			{
				id: "nvidia/nvidia-nemotron-nano-9b-v2",
				name: "nvidia-nemotron-nano-9b-v2",
				reasoning: true,
				input: ["text"],
				cost: zeroCost,
				contextWindow: 131072,
				maxTokens: 131072,
				compat: NVIDIA_COMPAT,
			},
			{
				id: "openai/gpt-oss-120b",
				name: "GPT-OSS-120B",
				reasoning: true,
				input: ["text"],
				cost: zeroCost,
				contextWindow: 128000,
				maxTokens: 8192,
				compat: NVIDIA_COMPAT,
			},
			{
				id: "openai/gpt-oss-20b",
				name: "GPT OSS 20B",
				reasoning: true,
				input: ["text"],
				cost: zeroCost,
				contextWindow: 131072,
				maxTokens: 32768,
				compat: NVIDIA_COMPAT,
			},
			{
				id: "qwen/qwen3.5-122b-a10b",
				name: "Qwen3.5 122B-A10B",
				reasoning: true,
				input: ["text", "image"],
				cost: zeroCost,
				contextWindow: 262144,
				maxTokens: 65536,
				compat: NVIDIA_COMPAT,
			},
			{
				id: "stepfun-ai/step-3.5-flash",
				name: "Step 3.5 Flash",
				reasoning: true,
				input: ["text"],
				cost: zeroCost,
				contextWindow: 256000,
				maxTokens: 16384,
				compat: NVIDIA_COMPAT,
			},
			{
				id: "stepfun-ai/step-3.7-flash",
				name: "Step 3.7 Flash",
				reasoning: true,
				input: ["text", "image"],
				cost: zeroCost,
				contextWindow: 256000,
				maxTokens: 16384,
				compat: NVIDIA_COMPAT,
			},
			{
				id: "z-ai/glm-5.1",
				name: "GLM-5.1",
				reasoning: true,
				input: ["text"],
				cost: zeroCost,
				contextWindow: 131072,
				maxTokens: 131072,
				compat: NVIDIA_COMPAT,
			},

			// ── Previously excluded models (now re-enabled) ──

			{
				id: "deepseek-ai/deepseek-v4-flash",
				name: "DeepSeek V4 Flash",
				reasoning: true,
				input: ["text"],
				cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
				contextWindow: 1000000,
				maxTokens: 384000,
				compat: NVIDIA_COMPAT,
			},
			{
				id: "deepseek-ai/deepseek-v4-pro",
				name: "DeepSeek V4 Pro",
				reasoning: true,
				input: ["text"],
				cost: { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0 },
				contextWindow: 1000000,
				maxTokens: 384000,
				compat: NVIDIA_COMPAT,
			},
			{
				id: "minimaxai/minimax-m2.7",
				name: "MiniMax M2.7",
				reasoning: true,
				input: ["text"],
				cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 },
				contextWindow: 204800,
				maxTokens: 131072,
				compat: NVIDIA_COMPAT,
			},
			{
				id: "minimaxai/minimax-m3",
				name: "MiniMax M3",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0.6, output: 2.4, cacheRead: 0.12, cacheWrite: 0 },
				contextWindow: 512000,
				maxTokens: 128000,
				compat: NVIDIA_COMPAT,
			},
		],
	});
}
