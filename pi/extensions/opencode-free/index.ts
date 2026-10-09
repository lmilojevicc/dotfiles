/**
 * OpenCode Zen Free provider.
 *
 * OpenCode Zen's free tier is gated server-side to the OpenCode client
 * fingerprint, not to an account or API key:
 *   - User-Agent must look like `opencode/<...>`
 *   - `x-opencode-session` must be a canonical `ses_` + 12 hex + 14 base62 id
 *   - the request tool list must contain both a `read` and a shell tool
 *   - `Authorization: Bearer public` is accepted (anonymous free lane)
 *
 * This provider serves the zero-cost Zen models with that fingerprint so they
 * work in Pi, including inside subagents whose tool set lacks read/bash.
 *
 * Error handling: terminal errors are rewritten with actionable hints
 * (daily free-quota reset time, rotated fingerprint gate, region limits).
 *
 * Env overrides: OPENCODE_FREE_UA (fingerprint User-Agent),
 * OPENCODE_FREE_BASE_URL (endpoint, useful for proxies/tests).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createAssistantMessageEventStream,
	createProvider,
	openAICompletionsApi,
	openAIResponsesApi,
	type Api,
	type AssistantMessageEventStream,
	type Model,
	type ProviderStreams,
	type SimpleStreamOptions,
	type StreamOptions,
} from "@earendil-works/pi-ai/compat";

const PROVIDER_ID = "opencode-free";
const PROVIDER_NAME = "OpenCode Zen Free";
const BASE_URL = process.env.OPENCODE_FREE_BASE_URL ?? "https://opencode.ai/zen/v1";
const USER_AGENT = process.env.OPENCODE_FREE_UA ?? "opencode/latest/2.0.18/cli";
const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

const MODELS = [{"id":"big-pickle","name":"Big Pickle","api":"openai-completions","provider":"opencode-free","reasoning":true,"input":["text"],"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},"compat":{"supportsStore":false,"supportsDeveloperRole":false,"supportsStrictMode":true,"maxTokensField":"max_tokens"},"contextWindow":200000,"maxTokens":32000,"type":"chat"},{"id":"fledge-alpha-free","name":"Fledge Alpha Free","api":"openai-completions","provider":"opencode-free","reasoning":true,"input":["text","image"],"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},"compat":{"supportsStore":false,"supportsDeveloperRole":false,"supportsStrictMode":true,"maxTokensField":"max_tokens"},"contextWindow":1048576,"maxTokens":131072,"thinkingLevelMap":{"off":null,"minimal":null,"low":"low","medium":null,"high":"high","xhigh":null,"max":"max"},"inputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}},"type":"chat"},{"id":"ling-3.0-flash-fin-free","name":"Ling 3.0 Flash Fin Free","api":"openai-completions","provider":"opencode-free","reasoning":true,"input":["text"],"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},"compat":{"supportsStore":false,"supportsDeveloperRole":false,"supportsStrictMode":true,"maxTokensField":"max_tokens"},"contextWindow":262144,"maxTokens":32768,"type":"chat"},{"id":"ling-3.1-flash-free","name":"Ling 3.1 Flash Free","api":"openai-completions","provider":"opencode-free","reasoning":true,"input":["text"],"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},"compat":{"supportsStore":false,"supportsDeveloperRole":false,"supportsStrictMode":true,"maxTokensField":"max_tokens"},"contextWindow":262144,"maxTokens":32768,"type":"chat"},{"id":"longcat-2.5-preview-free","name":"LongCat 2.5 Preview Free","api":"openai-completions","provider":"opencode-free","reasoning":true,"input":["text","image"],"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},"compat":{"supportsStore":false,"supportsDeveloperRole":false,"supportsStrictMode":true,"maxTokensField":"max_tokens"},"contextWindow":1000000,"maxTokens":131072,"inputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}},"type":"chat"},{"id":"mimo-v2.6-flash-free","name":"MiMo-V2.6-Flash Free","api":"openai-completions","provider":"opencode-free","reasoning":true,"input":["text","image"],"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},"compat":{"supportsStore":false,"supportsDeveloperRole":false,"supportsStrictMode":true,"maxTokensField":"max_tokens"},"contextWindow":200000,"maxTokens":32000,"inputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}},"type":"chat"},{"id":"muse-spark-1.3-contributor-free","name":"Muse Spark 1.3 Free","api":"openai-responses","provider":"opencode-free","reasoning":true,"input":["text","image"],"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},"compat":{"sessionAffinityFormat":"openai-nosession"},"contextWindow":1048576,"maxTokens":131072,"thinkingLevelMap":{"off":null,"minimal":"minimal","low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":null},"inputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}},"type":"chat"},{"id":"nemotron-3-ultra-free","name":"Nemotron 3 Ultra Free","api":"openai-completions","provider":"opencode-free","reasoning":true,"input":["text"],"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},"compat":{"supportsStore":false,"supportsDeveloperRole":false,"supportsStrictMode":true,"maxTokensField":"max_tokens"},"contextWindow":1000000,"maxTokens":128000,"type":"chat"},{"id":"nemotron-3.5-lightning-free","name":"Nemotron 3.5 Lightning Free","api":"openai-completions","provider":"opencode-free","reasoning":true,"input":["text"],"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},"compat":{"supportsStore":false,"supportsDeveloperRole":false,"supportsStrictMode":true,"maxTokensField":"max_tokens"},"contextWindow":262144,"maxTokens":262144,"type":"chat"},{"id":"space-bunny-free","name":"Space Bunny Free","api":"openai-completions","provider":"opencode-free","reasoning":true,"input":["text","image"],"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},"compat":{"supportsStore":false,"supportsDeveloperRole":false,"supportsStrictMode":true,"maxTokensField":"max_tokens"},"contextWindow":1048576,"maxTokens":524288,"thinkingLevelMap":{"off":null,"minimal":null,"low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":"max"},"inputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}},"type":"chat"}];

/**
 * Canonical OpenCode session id: `ses_` + 12 hex + 14 base62.
 * Deterministic per Pi session so Zen session affinity stays stable.
 */
function openCodeSessionId(seed: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < seed.length; i++) {
		h ^= seed.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	let x = h;
	let hex = "";
	for (let i = 0; i < 12; i++) {
		x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
		hex += "0123456789abcdef"[x % 16];
	}
	x = h ^ 0x9e3779b9;
	let suffix = "";
	for (let i = 0; i < 14; i++) {
		x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
		suffix += B62[x % 62];
	}
	return `ses_${hex}${suffix}`;
}

type ToolDef = { type: "function"; name: string; description: string; parameters: Record<string, unknown> };

const READ_TOOL: ToolDef = {
	type: "function",
	name: "read",
	description: "Read the contents of a file.",
	parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};

const SHELL_TOOL: ToolDef = {
	type: "function",
	name: "bash",
	description: "Execute a shell command.",
	parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
};

function ensureFingerprintTools(payload: unknown, api: string): unknown {
	if (!payload || typeof payload !== "object") return payload;
	const p = payload as Record<string, unknown>;
	const existing = Array.isArray(p.tools) ? (p.tools as Array<Record<string, unknown>>) : [];
	const names = new Set(
		existing.map((t) => (typeof t?.name === "string" ? t.name : (t?.function as Record<string, unknown> | undefined)?.name)).filter((n): n is string => typeof n === "string"),
	);
	const missing: ToolDef[] = [];
	if (!names.has("read")) missing.push(READ_TOOL);
	if (!names.has("bash") && !names.has("shell")) missing.push(SHELL_TOOL);
	if (missing.length === 0) return payload;
	const additions =
		api === "openai-responses"
			? missing
			: missing.map(({ type, ...rest }) => ({ type, function: rest }));
	return { ...p, tools: [...existing, ...additions] };
}

function patchOptions(options?: StreamOptions | SimpleStreamOptions) {
	const session = openCodeSessionId(options?.sessionId ?? "opencode-free");
	const inner = options?.onPayload;
	return {
		...options,
		headers: {
			...(options?.headers ?? {}),
			"User-Agent": USER_AGENT,
			"x-opencode-client": "cli",
			"x-opencode-session": session,
			"x-session-affinity": session,
			"x-session-id": session,
		},
		async onPayload(payload: unknown, model: Model<never>) {
			let next = payload;
			if (inner) {
				const replaced = await inner(next as never, model as never);
				if (replaced !== undefined) next = replaced;
			}
			return ensureFingerprintTools(next, (model as Model<never>).api);
		},
	};
}

function utcResetInfo(): string {
	const now = Date.now();
	const resetMs = now - (now % 86_400_000) + 86_400_000;
	const minutes = Math.max(1, Math.round((resetMs - now) / 60_000));
	const h = Math.floor(minutes / 60);
	const m = minutes % 60;
	const eta = h > 0 ? `${h}h ${m}m` : `${m}m`;
	return `resets in ~${eta} (${new Date(resetMs).toISOString()})`;
}

/** Turn Zen's terse error bodies into actionable messages. Exported for tests. */
export function describeZenError(message: string | undefined): string {
	const msg = message ?? "";
	if (msg.includes("FreeUsageLimitError")) {
		return `${msg}\n\nOpenCode Zen free tier: the per-IP daily request quota is exhausted and ${utcResetInfo()}. Subagents share the same IP quota, and retrying before the reset will keep failing.`;
	}
	if (msg.includes("FreeTierError")) {
		return `${msg}\n\nOpenCode Zen rejected the OpenCode client fingerprint. Zen may have rotated the free-tier gate; update the opencode-free extension (User-Agent / x-opencode-session / required tools).`;
	}
	if (msg.includes("RegionError") || /not available in your country/i.test(msg)) {
		return `${msg}\n\nOpenCode Zen region restriction: this model is unavailable from your current location.`;
	}
	if (/insufficient balance|insufficientBalance/i.test(msg)) {
		return `${msg}\n\nOpenCode Zen balance is empty. Free models do not require funds, so this usually means a paid model id was requested.`;
	}
	if (msg.includes("RateLimitError") || /rate limit exceeded/i.test(msg)) {
		return `${msg}\n\nOpenCode Zen per-minute rate limit: transient, safe to retry after a short pause.`;
	}
	return msg;
}

/**
 * Pass-through stream that rewrites terminal error events with actionable
 * messages. FreeUsageLimitError is already classified as non-retryable by
 * pi-ai, so this only improves what the user sees.
 */
function guardStream(stream: AssistantMessageEventStream, model: Model<Api>): AssistantMessageEventStream {
	const out = createAssistantMessageEventStream();
	void (async () => {
		try {
			for await (const event of stream) {
				if (event.type === "error") {
					out.push({ ...event, error: { ...event.error, errorMessage: describeZenError(event.error.errorMessage) } });
				} else {
					out.push(event);
				}
			}
			out.end();
		} catch (error) {
			out.push({
				type: "error",
				reason: "error",
				error: {
					role: "assistant",
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "error",
					errorMessage: describeZenError(error instanceof Error ? error.message : String(error)),
					timestamp: Date.now(),
				},
			});
			out.end();
		}
	})();
	return out;
}

function withFingerprint(inner: ProviderStreams): ProviderStreams {
	return {
		...inner,
		stream: (model, context, options) => guardStream(inner.stream(model, context, patchOptions(options) as StreamOptions), model),
		streamSimple: (model, context, options) => guardStream(inner.streamSimple(model, context, patchOptions(options) as SimpleStreamOptions), model),
	};
}

export default function openCodeFreeExtension(pi: ExtensionAPI) {
	pi.registerProvider(
		createProvider({
			id: PROVIDER_ID,
			name: PROVIDER_NAME,
			baseUrl: BASE_URL,
			auth: {
				apiKey: {
					name: "OpenCode Zen free tier",
					async check() {
						return { type: "api_key", source: "anonymous free tier" };
					},
					async resolve() {
						return { auth: { apiKey: "public" }, source: "anonymous free tier" };
					},
				},
			},
			models: MODELS.map((m) => ({ ...m, baseUrl: BASE_URL })),
			api: {
				"openai-responses": withFingerprint(openAIResponsesApi()),
				"openai-completions": withFingerprint(openAICompletionsApi()),
			},
		}),
	);
}
