/**
 * OpenCode Zen free provider for Pi.
 *
 * ## The gate
 *
 * OpenCode Zen's zero-cost lane is served only to requests that look like they
 * come from the official OpenCode client (verified 2026-10-16 against
 * opencode v2.0.26 by diffing real requests):
 *
 *   1. `User-Agent` must be `opencode/<channel>/<version>/<client>` with a
 *      version the server still accepts (old versions get 426, not 403).
 *   2. `x-opencode-session` (and its aliases) must be present and must decode
 *      as an OpenCode `Identifier.descending()` id: `ses_` + 12 hex of
 *      `~(unix_ms * 4096 + counter)` + 14 base62 characters. A syntactically
 *      valid id with an implausible timestamp is rejected.
 *   3. The request must stream and carry a tool named `read` in the API's tool
 *      shape. Requests without tools are only accepted when the system prompt
 *      matches OpenCode's own no-tool prompts (title generation), so Pi
 *      requests always get a `read` stub injected.
 *   4. `Authorization: Bearer public` selects the anonymous zero-cost lane.
 *
 * Everything above is enforced by the Zen gateway, not by this extension, and
 * it rotates. This file therefore refreshes both the OpenCode version and the
 * free model list from upstream instead of hardcoding either.
 *
 * ## What this extension does
 *
 *   - Injects the OpenCode fingerprint headers on every request.
 *   - Adds the gateway's required `read` tool to payloads that do not already
 *     carry one. The marker is described as not executable, and a request that
 *     offered no tools of its own additionally gets `tool_choice: "none"` so
 *     the model cannot call it. Real `read` tools are never touched.
 *   - Discovers the current free models from Pi's own catalog for the
 *     `opencode` provider (https://pi.dev/api/models/providers/opencode),
 *     intersected with the models the Zen endpoint currently serves, so new
 *     free models appear automatically and removed ones disappear. Results are
 *     cached on disk and published to Pi's models store whenever Pi refreshes
 *     catalogs, so offline startup keeps the last known list.
 *   - Fills metadata gaps for free models Pi's catalog has not listed yet, and
 *     corrects Zen's free-lane policy numbers with the upstream model's real
 *     capabilities. Probes on 2026-10-16 showed `glm-5.3-flash-free` serving
 *     1,048,576 tokens (its own catalog entry advertises 200K) and
 *     `deepseek-v4.1-flash-free` accepting ~1M, while
 *     `x-opencode-upstream-model-id` confirmed both route to the paid model of
 *     the same name. The paid sibling's entry therefore wins, then the vendor's
 *     models.dev entry for the canonical model, then conservative defaults.
 *   - Resolves the newest OpenCode version for the User-Agent from the
 *     homebrew tap formula (the v2 release channel), then from the locally
 *     installed `opencode` binary, then from a bundled fallback, and refreshes
 *     it in the background and after a FreeTierError.
 *
 * ## Environment overrides
 *
 *   OPENCODE_FREE_UA           full User-Agent override
 *   OPENCODE_FREE_VERSION      OpenCode version used to build the User-Agent
 *   OPENCODE_FREE_BASE_URL     inference base URL for every model
 *   OPENCODE_FREE_MODELS_URL   live model list endpoint
 *   OPENCODE_FREE_CATALOG_URL  Pi catalog endpoint for the `opencode` provider
 *   OPENCODE_FREE_VERSION_URL  endpoint that reports the latest OpenCode version
 *   OPENCODE_FREE_OFFLINE=1    skip all discovery requests (use cache/baseline)
 *
 * ## Startup cost
 *
 * Pi loads extensions in invocations that never start a session (`--list-models`,
 * package commands) and asks extensions not to do network or process work from
 * the factory. This extension therefore registers the last known catalogue from
 * disk (or the bundled baseline) synchronously, and refreshes the OpenCode
 * version and the catalogue from Pi's catalog refresh (`fetchModels`) and from a
 * background task started on `session_start` and cancelled on `session_shutdown`.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { getAgentDir, VERSION as PI_VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

const DEFAULT_BASE_URL = "https://opencode.ai/inference/v1";
const DEFAULT_MODELS_URL = "https://opencode.ai/zen/v1/models";
const DEFAULT_CATALOG_URL = "https://pi.dev/api/models/providers/opencode";
const DEFAULT_VERSION_URL = "https://raw.githubusercontent.com/anomalyco/homebrew-tap/master/opencode-v2.rb";
const DEFAULT_MODELS_DEV_URL = "https://models.dev/api.json";

/** Last resort when neither the version cache nor the network gives a version. */
const FALLBACK_OPENCODE_VERSION = "2.0.31";

/** APIs this provider can stream. Other Zen APIs (anthropic, google, classifier) are filtered out. */
const SUPPORTED_APIS = new Set<string>(["openai-completions", "openai-responses"]);

const BASE_URL = process.env.OPENCODE_FREE_BASE_URL ?? DEFAULT_BASE_URL;
const MODELS_URL = process.env.OPENCODE_FREE_MODELS_URL ?? DEFAULT_MODELS_URL;
const CATALOG_URL = process.env.OPENCODE_FREE_CATALOG_URL ?? DEFAULT_CATALOG_URL;
const VERSION_URL = process.env.OPENCODE_FREE_VERSION_URL ?? DEFAULT_VERSION_URL;
const MODELS_DEV_URL = process.env.OPENCODE_FREE_MODELS_DEV_URL ?? DEFAULT_MODELS_DEV_URL;

/** Same truthiness Pi's own `--offline` handling uses (`isTruthyEnvFlag` in dist/main.js). */
function truthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

/**
 * Pi normalizes `--offline` to `PI_OFFLINE=1` after reading argv, so checking
 * both covers an extension loaded either side of that. `PI_OFFLINE=0` is not
 * offline for Pi's own flag handling, so it must not be offline here either.
 */
const OFFLINE =
	process.argv.includes("--offline") || truthyEnvFlag(process.env.OPENCODE_FREE_OFFLINE) || truthyEnvFlag(process.env.PI_OFFLINE);

const AGENT_DIR = getAgentDir();
/** Exported for tests. */
export const CACHE_PATH = join(AGENT_DIR, "opencode-free.json");
const MODELS_STORE_PATH = join(AGENT_DIR, "models-store.json");

/** Catalog freshness window; older entries trigger a discovery request on startup. */
const CATALOG_TTL_MS = 15 * 60 * 1000;
const VERSION_TTL_MS = 6 * 60 * 60 * 1000;
/** models.dev is only consulted for models Pi's catalog does not know yet. */
const MODELS_DEV_TTL_MS = 24 * 60 * 60 * 1000;
const MODELS_DEV_TIMEOUT_MS = 4000;
const NETWORK_TIMEOUT_MS = 10_000;

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ID_MASK = 0xffffffffffffn;

/**
 * Seed catalog used when neither the cache nor the network has a model list
 * (first run while offline). Metadata matches what Pi's catalog served on
 * 2026-10-16; discovery replaces this list.
 */
const BASELINE_FREE_MODELS: Model<Api>[] = [
	{ id: "big-pickle", name: "Big Pickle", api: "openai-completions", provider: PROVIDER_ID, baseUrl: BASE_URL, reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsStore: false, supportsDeveloperRole: false, supportsStrictMode: true, maxTokensField: "max_tokens" }, contextWindow: 200000, maxTokens: 32000, type: "chat" },
	{ id: "deepseek-v4.1-flash-free", name: "DeepSeek V4.1 Flash Free", api: "openai-completions", provider: PROVIDER_ID, baseUrl: BASE_URL, reasoning: true, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsStore: false, supportsDeveloperRole: false, supportsStrictMode: true, maxTokensField: "max_tokens", requiresReasoningContentOnAssistantMessages: true }, contextWindow: 200000, maxTokens: 32000, thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" }, inputLimits: { images: { resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4718592, jpegQuality: 80 } } }, type: "chat" },
	{ id: "longcat-2.5-preview-free", name: "LongCat 2.5 Preview Free", api: "openai-completions", provider: PROVIDER_ID, baseUrl: BASE_URL, reasoning: true, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsStore: false, supportsDeveloperRole: false, supportsStrictMode: true, maxTokensField: "max_tokens" }, contextWindow: 1000000, maxTokens: 131072, inputLimits: { images: { resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4718592, jpegQuality: 80 } } }, type: "chat" },
	{ id: "mimo-v2.6-flash-free", name: "MiMo-V2.6-Flash Free", api: "openai-completions", provider: PROVIDER_ID, baseUrl: BASE_URL, reasoning: true, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsStore: false, supportsDeveloperRole: false, supportsStrictMode: true, maxTokensField: "max_tokens" }, contextWindow: 200000, maxTokens: 32000, inputLimits: { images: { resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4718592, jpegQuality: 80 } } }, type: "chat" },
	{ id: "muse-spark-1.3-contributor-free", name: "Muse Spark 1.3 Free", api: "openai-responses", provider: PROVIDER_ID, baseUrl: BASE_URL, reasoning: true, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { sessionAffinityFormat: "openai-nosession" }, contextWindow: 1048576, maxTokens: 131072, thinkingLevelMap: { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null }, inputLimits: { images: { resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4718592, jpegQuality: 80 } } }, type: "chat" },
	{ id: "nemotron-3.5-lightning-free", name: "Nemotron 3.5 Lightning Free", api: "openai-completions", provider: PROVIDER_ID, baseUrl: BASE_URL, reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsStore: false, supportsDeveloperRole: false, supportsStrictMode: true, maxTokensField: "max_tokens" }, contextWindow: 262144, maxTokens: 262144, type: "chat" },
	{ id: "space-bunny-free", name: "Space Bunny Free", api: "openai-completions", provider: PROVIDER_ID, baseUrl: BASE_URL, reasoning: true, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsStore: false, supportsDeveloperRole: false, supportsStrictMode: true, maxTokensField: "max_tokens" }, contextWindow: 1048576, maxTokens: 524288, thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" }, inputLimits: { images: { resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4718592, jpegQuality: 80 } } }, type: "chat" },
];

// ---------------------------------------------------------------------------
// On-disk cache
// ---------------------------------------------------------------------------

type CacheEntry = {
	version?: string;
	versionCheckedAt?: number;
	versionSource?: string;
	models?: Model<Api>[];
	liveIds?: string[];
	modelsCheckedAt?: number;
	/** Every id discovery has published, so availability filtering can tell our models from user additions. */
	discoveredIds?: string[];
	modelsDev?: Record<string, ModelsDevMeta>;
	modelsDevCheckedAt?: number;
};

function readCache(): CacheEntry {
	try {
		const parsed = JSON.parse(readFileSync(CACHE_PATH, "utf8")) as CacheEntry;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

let cacheWrites = 0;

/**
 * Merge the patch into the cache and replace the file atomically. Every BB
 * thread runs its own Pi process against the same cache file, so a plain
 * read-modify-write can expose a half-written JSON document or lose the other
 * writer's keys. Writing a complete temp file in the same directory and
 * renaming it means readers only ever see a complete document and the last
 * complete write wins.
 *
 * Exported for tests.
 */
export function writeCache(patch: Partial<CacheEntry>): void {
	cacheWrites += 1;
	const temp = join(dirname(CACHE_PATH), `.opencode-free.${process.pid}.${cacheWrites}.tmp`);
	try {
		mkdirSync(dirname(CACHE_PATH), { recursive: true });
		writeFileSync(temp, `${JSON.stringify({ ...readCache(), ...patch }, null, 1)}\n`);
		renameSync(temp, CACHE_PATH);
	} catch {
		// A read-only agent directory must not break the provider.
		rmSync(temp, { force: true });
	}
}

/** Pi's persisted catalog for this provider, used when discovery is offline. */
function readStoredModels(): Model<Api>[] {
	try {
		const store = JSON.parse(readFileSync(MODELS_STORE_PATH, "utf8")) as Record<string, { models?: Model<Api>[] }>;
		const models = store?.[PROVIDER_ID]?.models;
		return Array.isArray(models) ? models : [];
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------------
// OpenCode version -> User-Agent
// ---------------------------------------------------------------------------

function parseVersion(text: string): string | undefined {
	const match = text.match(/v?(\d+\.\d+\.\d+)/);
	return match?.[1];
}

/** Version of the locally installed OpenCode CLI, when one is on PATH. */
async function localOpenCodeVersion(signal?: AbortSignal): Promise<string | undefined> {
	try {
		const { stdout } = await promisify(execFile)("opencode", ["--version"], { encoding: "utf8", timeout: 4000, signal });
		return parseVersion(String(stdout));
	} catch {
		return undefined;
	}
}

const cache = readCache();
let openCodeVersion = process.env.OPENCODE_FREE_VERSION ?? cache.version ?? FALLBACK_OPENCODE_VERSION;
let versionRefreshInFlight: Promise<void> | undefined;

/** Ids this extension's discovery has ever published: the baseline plus everything seen since. */
const discoveredIds = new Set<string>(BASELINE_FREE_MODELS.map((model) => model.id));
for (const model of cache.models ?? []) {
	if (typeof model?.id === "string") discoveredIds.add(model.id);
}
for (const id of cache.discoveredIds ?? []) {
	if (typeof id === "string") discoveredIds.add(id);
}

function userAgent(): string {
	return process.env.OPENCODE_FREE_UA ?? `opencode/latest/${openCodeVersion}/cli`;
}

/**
 * Refresh the OpenCode version used for the fingerprint User-Agent. Runs in the
 * background: requests keep using the cached/local version until a newer one is
 * found. The homebrew tap tracks the v2 release channel, which is the channel
 * the Zen gateway currently accepts.
 */
function refreshOpenCodeVersion(signal?: AbortSignal): Promise<void> {
	if (OFFLINE) return Promise.resolve();
	if (versionRefreshInFlight) return versionRefreshInFlight;
	versionRefreshInFlight = (async () => {
		let version: string | undefined;
		let source = "tap";
		try {
			version = parseVersion(await fetchText(VERSION_URL, signal ? { signal } : {}));
		} catch {
			version = undefined;
		}
		if (!version) {
			version = await localOpenCodeVersion(signal);
			source = "local";
		}
		if (!version || signal?.aborted) return;
		openCodeVersion = version;
		writeCache({ version, versionCheckedAt: Date.now(), versionSource: source });
	})().finally(() => {
		versionRefreshInFlight = undefined;
	});
	return versionRefreshInFlight;
}

/**
 * Kick off a background version refresh when the cached one is stale. Never
 * awaited by its callers: requests keep the cached/local version until a newer
 * one arrives.
 */
function ensureFreshOpenCodeVersion(signal?: AbortSignal): void {
	if (OFFLINE) return;
	if (Date.now() - (readCache().versionCheckedAt ?? 0) < VERSION_TTL_MS) return;
	void refreshOpenCodeVersion(signal).catch(() => {});
}

// ---------------------------------------------------------------------------
// Session ids
// ---------------------------------------------------------------------------

/**
 * OpenCode's `Identifier.descending()`: `~(unix_ms * 4096 + counter)` as six
 * bytes of hex. The Zen gateway decodes this timestamp and rejects ids whose
 * timestamp is implausible, so it must be generated at request time, not
 * synthesized from a hash. Exported for tests.
 */
export function descendingHex(timestamp: number, counter = 1): string {
	const current = (BigInt(timestamp) * 0x1000n + BigInt(counter)) & ID_MASK;
	return (current ^ ID_MASK).toString(16).padStart(12, "0");
}

/** Deterministic 14 character base62 suffix so a Pi session keeps Zen affinity across restarts. */
function sessionSuffix(seed: string): string {
	let x = 0x811c9dc5;
	for (let i = 0; i < seed.length; i++) {
		x ^= seed.charCodeAt(i);
		x = Math.imul(x, 0x01000193) >>> 0;
	}
	let out = "";
	for (let i = 0; i < 14; i++) {
		x ^= x << 13;
		x >>>= 0;
		x ^= x >>> 17;
		x ^= x << 5;
		x >>>= 0;
		out += B62[x % 62];
	}
	return out;
}

const SESSION_TTL_MS = 60 * 60 * 1000;
const sessionIds = new Map<string, { id: string; at: number }>();

export function openCodeSessionId(seed: string, now = Date.now()): string {
	const cached = sessionIds.get(seed);
	if (cached && now - cached.at < SESSION_TTL_MS) return cached.id;
	const id = `ses_${descendingHex(now)}${sessionSuffix(seed)}`;
	sessionIds.set(seed, { id, at: now });
	return id;
}

const projectIds = new Map<string, string>();

/** OpenCode sends a 40 character hex project id; any stable value satisfies the gate. */
export function openCodeProjectId(directory: string): string {
	const cached = projectIds.get(directory);
	if (cached) return cached;
	const id = createHash("sha1").update(directory).digest("hex");
	projectIds.set(directory, id);
	return id;
}

// ---------------------------------------------------------------------------
// Request fingerprint
// ---------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;
type ToolDef = { type: "function"; name: string; description: string; parameters: JsonObject };

/**
 * The gateway only inspects the name, so the injected tool is described as an
 * unusable marker. It is only ever added when the client did not offer its own
 * `read` tool, which makes the warning accurate in every request that carries it.
 */
const READ_TOOL: ToolDef = {
	type: "function",
	name: "read",
	description: "Gateway protocol marker. This tool is not executable in this session; do not call it. Use only the tools listed in this request.",
	parameters: { type: "object", properties: {} },
};

function toolName(tool: unknown): string | undefined {
	if (!tool || typeof tool !== "object") return undefined;
	const entry = tool as JsonObject;
	if (typeof entry.name === "string") return entry.name;
	const fn = entry.function;
	if (fn && typeof fn === "object" && typeof (fn as JsonObject).name === "string") {
		return (fn as JsonObject).name as string;
	}
	return undefined;
}

/**
 * The gateway requires a tool named `read`; a shell tool is not required
 * (verified 2026-10-16). Add the marker only when the client did not provide a
 * real `read` tool, and keep it uncallable where the API allows it: a request
 * that offered no tools of its own gets `tool_choice: "none"`, which the chat
 * completions API accepts and the responses API rejects. Exported for tests.
 */
export function ensureFingerprintTools(payload: unknown, api: string): unknown {
	if (!payload || typeof payload !== "object") return payload;
	const body = payload as JsonObject;
	const existing = Array.isArray(body.tools) ? (body.tools as Array<Record<string, unknown>>) : [];
	const names = new Set(existing.map(toolName).filter((name): name is string => typeof name === "string"));
	if (names.has("read")) return payload;
	const addition = api === "openai-responses" ? READ_TOOL : { type: READ_TOOL.type, function: { name: READ_TOOL.name, description: READ_TOOL.description, parameters: READ_TOOL.parameters } };
	const next: JsonObject = { ...body, tools: [...existing, addition] };
	if (existing.length === 0 && api !== "openai-responses" && next.tool_choice === undefined) {
		next.tool_choice = "none";
	}
	return next;
}

function patchOptions(options?: StreamOptions | SimpleStreamOptions) {
	const session = openCodeSessionId(options?.sessionId ?? "opencode-free");
	const project = openCodeProjectId(process.cwd());
	const inner = options?.onPayload;
	return {
		...options,
		headers: {
			...(options?.headers ?? {}),
			"User-Agent": userAgent(),
			"x-opencode-client": "cli",
			"x-opencode-project": project,
			"x-opencode-session": session,
			"x-opencode-session-id": session,
			"x-session-affinity": session,
			"x-session-id": session,
		},
		async onPayload(payload: unknown, model: Model<Api>) {
			let next = payload;
			if (inner) {
				const replaced = await inner(next, model);
				if (replaced !== undefined) next = replaced;
			}
			return ensureFingerprintTools(next, model.api);
		},
	};
}

// ---------------------------------------------------------------------------
// Error messages
// ---------------------------------------------------------------------------

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
		return `${msg}\n\nOpenCode Zen free tier: the anonymous daily quota for this IP is exhausted and ${utcResetInfo()}. Pi sessions and subagents share the quota; retrying before the reset keeps failing.`;
	}
	if (msg.includes("FreeTierError")) {
		return `${msg}\n\nOpenCode Zen rejected the OpenCode client fingerprint on this request. The opencode-free extension refreshes its User-Agent and model catalog from upstream; run /reload or restart Pi if this persists, and check that the Zen free lane still exists.`;
	}
	if (msg.includes("RegionError") || /not available in your country/i.test(msg)) {
		return `${msg}\n\nOpenCode Zen region restriction: this model is unavailable from your current location.`;
	}
	if (/insufficient balance|insufficientBalance/i.test(msg)) {
		return `${msg}\n\nOpenCode Zen balance is empty. The free lane needs no funds, so a paid model id was requested.`;
	}
	if (msg.includes("RateLimitError") || /rate limit exceeded/i.test(msg)) {
		return `${msg}\n\nOpenCode Zen per-minute rate limit: transient, safe to retry after a short pause.`;
	}
	return msg;
}

/**
 * Pass-through stream that rewrites terminal error events with actionable
 * messages and refreshes the fingerprint version after a gate rejection.
 */
function guardStream(stream: AssistantMessageEventStream, model: Model<Api>): AssistantMessageEventStream {
	const out = createAssistantMessageEventStream();
	void (async () => {
		try {
			for await (const event of stream) {
				if (event.type === "error") {
					const message = event.error.errorMessage ?? "";
					if (message.includes("FreeTierError")) void refreshOpenCodeVersion().catch(() => {});
					out.push({ ...event, error: { ...event.error, errorMessage: describeZenError(message) } });
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

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function fetchText(url: string, init: RequestInit = {}, timeoutMs = NETWORK_TIMEOUT_MS): Promise<string> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const onAbort = () => controller.abort();
	init.signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const response = await fetch(url, { ...init, signal: controller.signal });
		if (!response.ok) throw new Error(`${url} responded ${response.status}`);
		return await response.text();
	} finally {
		clearTimeout(timer);
		init.signal?.removeEventListener("abort", onAbort);
	}
}

async function fetchJson(url: string, init: RequestInit = {}, timeoutMs = NETWORK_TIMEOUT_MS): Promise<unknown> {
	return JSON.parse(await fetchText(url, init, timeoutMs));
}

// ---------------------------------------------------------------------------
// Model catalog
// ---------------------------------------------------------------------------

function isFreeCost(cost: unknown): boolean {
	const tiers = Array.isArray(cost) ? cost : [cost];
	if (tiers.length === 0) return false;
	return tiers.every((tier) => {
		if (!tier || typeof tier !== "object") return false;
		const entry = tier as JsonObject;
		return Number(entry.input ?? -1) === 0 && Number(entry.output ?? -1) === 0;
	});
}

type Catalog = { chat: JsonObject[]; knownIds: Set<string> };

function parseCatalog(value: unknown): Catalog {
	const entries = Array.isArray(value)
		? value
		: value && typeof value === "object" && Array.isArray((value as JsonObject).models)
			? ((value as JsonObject).models as unknown[])
			: value && typeof value === "object"
				? Object.values(value as JsonObject)
				: [];
	const chat: JsonObject[] = [];
	const knownIds = new Set<string>();
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const model = entry as JsonObject;
		if (typeof model.id !== "string") continue;
		knownIds.add(model.id);
		if (model.type === undefined || model.type === "chat") chat.push(model);
	}
	return { chat, knownIds };
}

function defaultBaseUrlFor(api: string): string {
	return api === "anthropic-messages" ? BASE_URL.replace(/\/v1$/, "") : BASE_URL;
}

function toModel(raw: JsonObject, requireFree: boolean): Model<Api> | undefined {
	if (typeof raw.id !== "string") return undefined;
	if (requireFree && !isFreeCost(raw.cost)) return undefined;
	if (raw.type !== undefined && raw.type !== "chat") return undefined;
	const api = typeof raw.api === "string" ? raw.api : "openai-completions";
	if (!SUPPORTED_APIS.has(api)) return undefined;
	const baseUrl = typeof raw.baseUrl === "string" ? raw.baseUrl : defaultBaseUrlFor(api);
	return {
		...raw,
		api,
		provider: PROVIDER_ID,
		baseUrl: process.env.OPENCODE_FREE_BASE_URL ?? baseUrl,
		type: "chat",
	} as unknown as Model<Api>;
}

function guessApi(id: string): string {
	if (/muse-spark|gpt|codex|o[0-9]-/.test(id)) return "openai-responses";
	if (/claude/.test(id)) return "anthropic-messages";
	if (/gemini/.test(id)) return "google-generative-ai";
	return "openai-completions";
}

function prettyName(id: string): string {
	return id
		.split("-")
		.map((part) => (/^(glm|llm|vl|ai|v\d)/i.test(part) || /^v?\d/.test(part) ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)))
		.join(" ");
}

/** The same upstream model's id with the free-lane qualifiers removed. */
function stemId(id: string): string {
	return id.replace(/-contributor-free$/, "").replace(/-free$/, "");
}

function unionInput(...values: Array<Array<"text" | "image"> | undefined>): Array<"text" | "image"> {
	return [...new Set<"text" | "image">(["text", ...values.flatMap((value) => value ?? [])])];
}

/**
 * Limits and modalities belong to the upstream model, not to Zen's free-lane
 * policy numbers. Probing the live gateway on 2026-10-16 showed
 * `glm-5.3-flash-free` serving 1,048,576 tokens and `deepseek-v4.1-flash-free`
 * accepting ~1M while both advertised 200K/32K, and `x-opencode-upstream-model-id`
 * confirmed both route to the paid model of the same name. So the paid sibling
 * describes the real capabilities; models.dev covers models without one.
 */
function applyUpstreamCapabilities(
	model: Model<Api>,
	paidByStem: ReadonlyMap<string, Model<Api>>,
	anyByStem: ReadonlyMap<string, Model<Api>>,
	meta?: ModelsDevMeta,
): Model<Api> {
	const stem = stemId(model.id);
	const sibling = paidByStem.get(stem) ?? anyByStem.get(stem);
	const input = unionInput(model.input, sibling && sibling.id !== model.id ? sibling.input : undefined, meta?.input);
	const capabilities =
		sibling && sibling.id !== model.id
			? { contextWindow: sibling.contextWindow, maxTokens: sibling.maxTokens, reasoning: sibling.reasoning }
			: {
					contextWindow: meta?.contextWindow ?? model.contextWindow,
					maxTokens: meta?.maxTokens ?? model.maxTokens,
					reasoning: meta?.reasoning ?? model.reasoning,
				};
	return {
		...model,
		name: meta?.name ?? model.name,
		...capabilities,
		input,
		...(input.includes("image") && !model.inputLimits ? { inputLimits: IMAGE_LIMITS } : {}),
	} as Model<Api>;
}

/** Family key: strips the free/contributor qualifiers and version numbers. Exported for tests. */
export function familyKey(id: string): string {
	return id
		.toLowerCase()
		.replace(/-free$/, "")
		.replace(/-contributor/, "")
		.replace(/v?\d+(\.\d+)*/g, "")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

const IMAGE_LIMITS = { images: { resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4718592, jpegQuality: 80 } } };

function defaultFreeModel(id: string): Model<Api> {
	const api = guessApi(id);
	return {
		id,
		name: prettyName(id),
		api,
		provider: PROVIDER_ID,
		baseUrl: process.env.OPENCODE_FREE_BASE_URL ?? defaultBaseUrlFor(api),
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: api === "openai-responses" ? { sessionAffinityFormat: "openai-nosession" } : { supportsStore: false, supportsDeveloperRole: false, supportsStrictMode: true, maxTokensField: "max_tokens" },
		contextWindow: 200000,
		maxTokens: 32000,
		type: "chat",
	} as unknown as Model<Api>;
}

/**
 * Metadata for a free model the Zen endpoint serves but Pi's catalog does not
 * know yet, in descending order of trust:
 *
 *   1. the exact model entry in models.dev (`meta`),
 *   2. a same-family sibling from Pi's catalog or the persisted list,
 *   3. conservative defaults.
 *
 * Free variants can be smaller than the paid model of the same name, so the
 * exact entry must win over the sibling. Exported for tests.
 */
export function synthesizeFreeModel(id: string, templates: readonly Model<Api>[] = [], meta?: ModelsDevMeta): Model<Api> {
	const template = pickTemplate(id, templates);
	const base: Model<Api> =
		template && SUPPORTED_APIS.has(template.api)
			? ({ ...template, id, name: prettyName(id), provider: PROVIDER_ID, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as Model<Api>)
			: defaultFreeModel(id);
	if (!meta) return base;
	// The free lane routes to the same upstream model as its namesake, so a
	// sibling entry describes the real limits; models.dev only fills the gaps.
	const limitsFromTemplate = template !== undefined;
	const input = [...new Set<"text" | "image">(["text", ...(base.input ?? []), ...(meta.input ?? [])])];
	return {
		...base,
		name: meta.name ?? base.name,
		contextWindow: limitsFromTemplate ? base.contextWindow : (meta.contextWindow ?? base.contextWindow),
		maxTokens: limitsFromTemplate ? base.maxTokens : (meta.maxTokens ?? base.maxTokens),
		input,
		reasoning: limitsFromTemplate ? base.reasoning : (meta.reasoning ?? base.reasoning),
		...(input.includes("image") && !base.inputLimits ? { inputLimits: IMAGE_LIMITS } : {}),
	} as Model<Api>;
}

/**
 * Pick the sibling that describes the same upstream model: the exact id without
 * its free qualifiers first, then the closest family match.
 */
function pickTemplate(id: string, templates: readonly Model<Api>[]): Model<Api> | undefined {
	const stem = id.replace(/-contributor-free$/, "").replace(/-free$/, "");
	const exact = templates.find((candidate) => candidate.id === stem);
	if (exact) return exact;
	const key = familyKey(id);
	return templates.find((candidate) => candidate.id !== id && familyKey(candidate.id) === key);
}

/**
 * Merge the sources of truth for the free model list:
 *
 *   - Pi's `opencode` catalog (freshest full metadata),
 *   - the previously persisted list, so a catalog outage keeps known models,
 *   - the live Zen model list, which decides which ids still exist.
 *
 * Exported for tests.
 */
export function mergeFreeModels(input: { catalog?: JsonObject[]; knownIds?: Set<string>; stored?: readonly Model<Api>[]; liveIds?: Set<string>; meta?: Record<string, ModelsDevMeta> }): Model<Api>[] {
	const byId = new Map<string, Model<Api>>();
	// Siblings at any price supply metadata for free models the catalog has not listed yet.
	const templates: Model<Api>[] = [];
	const paidByStem = new Map<string, Model<Api>>();
	const anyByStem = new Map<string, Model<Api>>();
	for (const raw of input.catalog ?? []) {
		const anyPrice = toModel(raw, false);
		if (!anyPrice) continue;
		templates.push(anyPrice);
		const stem = stemId(anyPrice.id);
		if (!anyByStem.has(stem)) anyByStem.set(stem, anyPrice);
		if (!isFreeCost(raw.cost) && !paidByStem.has(stem)) paidByStem.set(stem, anyPrice);
	}
	for (const raw of input.catalog ?? []) {
		const model = toModel(raw, true);
		if (!model) continue;
		byId.set(model.id, applyUpstreamCapabilities(model, paidByStem, anyByStem, input.meta?.[model.id]));
	}
	// Persisted copies are candidates for the gap-filling pass below, never overrides:
	// a stale copy must not shadow the catalog or exact models.dev metadata.
	const storedCandidates: Model<Api>[] = [];
	for (const model of input.stored ?? []) {
		if (typeof model?.id !== "string" || model.provider !== PROVIDER_ID) continue;
		templates.push(model);
		storedCandidates.push(model);
	}
	// Free ids the server serves but the catalog has not listed yet. Synthesis
	// needs the catalog to rule out ids that are known to be non-chat models.
	if (input.liveIds && input.knownIds) {
		for (const id of input.liveIds) {
			if (byId.has(id) || input.knownIds.has(id)) continue;
			if (!/-free$/.test(id)) continue;
			const model = synthesizeFreeModel(id, templates, input.meta?.[id]);
			if (SUPPORTED_APIS.has(model.api)) byId.set(id, applyUpstreamCapabilities(model, paidByStem, anyByStem, input.meta?.[id]));
		}
	}
	// Gap fill from the persisted list; catalog-known ids stay authoritative.
	for (const model of storedCandidates) {
		if (byId.has(model.id) || input.knownIds?.has(model.id)) continue;
		if (input.liveIds && !input.liveIds.has(model.id)) continue;
		byId.set(model.id, applyUpstreamCapabilities(model, paidByStem, anyByStem, input.meta?.[model.id]));
	}
	if (input.liveIds) {
		for (const id of [...byId.keys()]) {
			if (!input.liveIds.has(id)) byId.delete(id);
		}
	}
	return [...byId.values()];
}

/** Ids the Zen endpoint currently serves; undefined when the list was unreachable. */
async function fetchLiveModelIds(signal: AbortSignal | undefined, timeoutMs: number): Promise<Set<string> | undefined> {
	try {
		const session = openCodeSessionId("opencode-free-models");
		const value = await fetchJson(
			MODELS_URL,
			{
				signal,
				headers: {
					accept: "application/json",
					"User-Agent": userAgent(),
					"x-opencode-client": "cli",
					"x-opencode-session": session,
					authorization: "Bearer public",
				},
			},
			timeoutMs,
		);
		const data = Array.isArray((value as JsonObject)?.data) ? ((value as JsonObject).data as unknown[]) : [];
		const ids = new Set(data.map((entry) => (entry as JsonObject)?.id).filter((id): id is string => typeof id === "string"));
		return ids.size > 0 ? ids : undefined;
	} catch {
		return undefined;
	}
}

async function fetchCatalog(signal: AbortSignal | undefined, timeoutMs: number): Promise<Catalog | undefined> {
	try {
		const url = new URL(CATALOG_URL);
		url.searchParams.set("types", "chat,classifier");
		url.searchParams.set("pi-version", PI_VERSION);
		const value = await fetchJson(url.href, { signal, headers: { accept: "application/json", "User-Agent": `pi/${PI_VERSION}` } }, timeoutMs);
		const catalog = parseCatalog(value);
		return catalog.chat.length > 0 ? catalog : undefined;
	} catch {
		return undefined;
	}
}

/** models.dev provider ids that differ from the canonical model id prefix. */
const VENDOR_ALIASES: Record<string, string> = { zhipuai: "zai" };

/** Exact-model metadata for the fields Pi's catalog owns when it knows the model. */
export type ModelsDevMeta = {
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	input?: Array<"text" | "image">;
	reasoning?: boolean;
};

/**
 * Free `opencode` entries from models.dev, keyed by model id. models.dev is the
 * upstream both Pi's catalog and OpenCode derive from; it lists new free models
 * before Pi's catalog does, and it separates a free variant from the paid model
 * of the same name (which can have a larger window). Exported for tests.
 */
export function extractModelsDev(value: unknown): Record<string, ModelsDevMeta> {
	const root = (value ?? {}) as JsonObject;
	const modelsOf = (providerId: string): JsonObject | undefined => {
		const provider = root[providerId];
		const models = provider && typeof provider === "object" ? (provider as JsonObject).models : undefined;
		return models && typeof models === "object" ? (models as JsonObject) : undefined;
	};
	const models = modelsOf("opencode");
	if (!models) return {};
	const out: Record<string, ModelsDevMeta> = {};
	for (const [id, raw] of Object.entries(models)) {
		if (!raw || typeof raw !== "object") continue;
		const model = raw as JsonObject;
		if (!isFreeCost(model.cost)) continue;
		// A free entry carries Zen's policy numbers, not the model's capabilities
		// (glm-5.3-flash-free advertises 200K/32K while the routed model serves
		// 1048576 tokens). The vendor's own entry for the canonical model has the
		// real limits, so prefer it.
		const canonical = typeof model.canonical_model_id === "string" ? model.canonical_model_id : undefined;
		const [vendorID, vendorModelID] = canonical ? canonical.split("/") : [];
		const vendorEntry = vendorID && vendorModelID ? modelsOf(VENDOR_ALIASES[vendorID] ?? vendorID)?.[vendorModelID] : undefined;
		const vendorLimit =
			vendorEntry && typeof vendorEntry === "object" && (vendorEntry as JsonObject).limit && typeof (vendorEntry as JsonObject).limit === "object"
				? ((vendorEntry as JsonObject).limit as JsonObject)
				: undefined;
		const limit = vendorLimit ?? (model.limit && typeof model.limit === "object" ? (model.limit as JsonObject) : {});
		const modalities = model.modalities && typeof model.modalities === "object" ? (model.modalities as JsonObject).input : undefined;
		const input = Array.isArray(modalities)
			? modalities.filter((entry): entry is "text" | "image" => entry === "text" || entry === "image")
			: undefined;
		const contextWindow = Number(limit.context);
		const maxTokens = Number(limit.output);
		out[id] = {
			...(typeof model.name === "string" && model.name.length > 0 ? { name: model.name } : {}),
			...(Number.isFinite(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
			...(Number.isFinite(maxTokens) && maxTokens > 0 ? { maxTokens } : {}),
			...(input && input.length > 0 ? { input: input.includes("text") ? input : (["text", ...input] as Array<"text" | "image">) } : {}),
			...(typeof model.reasoning === "boolean" ? { reasoning: model.reasoning } : {}),
		};
	}
	return out;
}

/**
 * models.dev metadata, fetched only when a live free model is missing from Pi's
 * catalog and the cache does not already cover it. The full response is several
 * megabytes, so it is fetched at most once per TTL and only when it changes
 * something.
 */
async function loadModelsDevMeta(
	catalog: Catalog | undefined,
	liveIds: Set<string> | undefined,
	signal: AbortSignal | undefined,
): Promise<Record<string, ModelsDevMeta> | undefined> {
	if (OFFLINE) return undefined;
	const cache = readCache();
	const cached = cache.modelsDev;
	const needed = liveIds ? [...liveIds].some((id) => /-free$/.test(id) && !catalog?.knownIds.has(id) && !cached?.[id]) : false;
	if (!needed) return cached;
	if (Date.now() - (cache.modelsDevCheckedAt ?? 0) < MODELS_DEV_TTL_MS) return cached;
	try {
		const value = await fetchJson(MODELS_DEV_URL, { signal, headers: { accept: "application/json" } }, MODELS_DEV_TIMEOUT_MS);
		const meta = extractModelsDev(value);
		if (Object.keys(meta).length === 0) return cached;
		writeCache({ modelsDev: meta, modelsDevCheckedAt: Date.now() });
		return meta;
	} catch {
		return cached;
	}
}

type Discovery = { models: Model<Api>[]; liveIds?: Set<string>; checkedAt: number };

let discovery: Discovery | undefined;
let discoveryFetch: Promise<Discovery> | undefined;

function cachedDiscovery(): Discovery | undefined {
	const entry = readCache();
	if (!entry.modelsCheckedAt || !Array.isArray(entry.models) || entry.models.length === 0) return undefined;
	const liveIds = Array.isArray(entry.liveIds) ? entry.liveIds.filter((id): id is string => typeof id === "string") : [];
	return { models: entry.models, liveIds: liveIds.length > 0 ? new Set(liveIds) : undefined, checkedAt: entry.modelsCheckedAt };
}

function buildDiscovery(
	catalog: Catalog | undefined,
	liveIds: Set<string> | undefined,
	options: { stored?: readonly Model<Api>[] },
	cached: Discovery | undefined,
	meta?: Record<string, ModelsDevMeta>,
): Discovery {
	// Our own cache is written by the same discovery, so it outranks Pi's store copy.
	const stored = [...(cached?.models ?? []), ...(options.stored ?? readStoredModels())];
	const effectiveLiveIds = liveIds ?? cached?.liveIds;
	const models = mergeFreeModels({ catalog: catalog?.chat, knownIds: catalog?.knownIds, stored, liveIds: effectiveLiveIds, meta });
	const fetched = catalog !== undefined || liveIds !== undefined;
	if (!fetched) return { models, liveIds: effectiveLiveIds, checkedAt: cached?.checkedAt ?? 0 };
	const result: Discovery = { models: models.length > 0 ? models : (cached?.models ?? []), liveIds: effectiveLiveIds, checkedAt: Date.now() };
	discovery = result;
	for (const model of result.models) discoveredIds.add(model.id);
	if (models.length > 0) {
		writeCache({
			models,
			liveIds: effectiveLiveIds ? [...effectiveLiveIds] : undefined,
			modelsCheckedAt: result.checkedAt,
			discoveredIds: [...discoveredIds],
		});
	}
	return result;
}

/**
 * Resolve the current free model list: cache inside its TTL, otherwise one
 * network round trip to the catalog and the live endpoint. A failed fetch
 * keeps the cached list without refreshing its timestamp, so the next call
 * retries.
 */
async function discoverFreeModels(options: { stored?: readonly Model<Api>[]; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<Discovery> {
	const cached = discovery ?? cachedDiscovery();
	if (cached) discovery = cached;
	if (cached && Date.now() - cached.checkedAt < CATALOG_TTL_MS) return buildDiscovery(undefined, undefined, options, cached);
	if (discoveryFetch) {
		await discoveryFetch;
		return buildDiscovery(undefined, undefined, options, discovery ?? cached);
	}
	if (OFFLINE) return buildDiscovery(undefined, undefined, options, cached);
	const timeoutMs = options.timeoutMs ?? NETWORK_TIMEOUT_MS;
	discoveryFetch = Promise.all([fetchCatalog(options.signal, timeoutMs), fetchLiveModelIds(options.signal, timeoutMs)])
		.then(async ([catalog, liveIds]) => buildDiscovery(catalog, liveIds, options, cached, await loadModelsDevMeta(catalog, liveIds, options.signal)))
		.finally(() => {
			discoveryFetch = undefined;
		});
	return discoveryFetch;
}

/**
 * Pi restores a provider's persisted catalog before any network refresh and
 * then publishes the fresh discovery through the provider's own model state, so
 * the candidates already carry the current metadata on top of any `models.json`
 * modelOverrides Pi composed into them. That leaves two jobs here:
 *
 *   - keep a known id's candidate object, so an override is not replaced by the
 *     raw discovery copy,
 *   - drop ids the live endpoint stopped serving, but only ones that came from
 *     this extension's discovery: a `models.json` addition this extension never
 *     saw must survive even when the endpoint does not list it.
 *
 * Exported for tests.
 */
export function filterDiscoveredModels(
	candidates: readonly Model<Api>[],
	latest: readonly Model<Api>[],
	liveIds?: Set<string>,
	discoveryIds?: ReadonlySet<string>,
): Model<Api>[] {
	if (latest.length === 0) return [...candidates];
	const known = new Set(latest.map((model) => model.id));
	const out: Model<Api>[] = [];
	for (const model of candidates) {
		if (known.has(model.id)) {
			out.push(model);
			continue;
		}
		// Without a live list there is no evidence that an id disappeared.
		if (!liveIds || liveIds.has(model.id)) {
			out.push(model);
			continue;
		}
		if (discoveryIds?.has(model.id)) continue;
		out.push(model);
	}
	return out;
}

/** Live free ids from the last discovery; lets `filterModels` hide removed baseline entries. */
let lastLiveIds: Set<string> | undefined;

/**
 * Background refresh started on `session_start` and cancelled on `session_shutdown`.
 *
 * It publishes the same state a `fetchModels` refresh does, including the live
 * ids `filterModels` needs to hide baseline entries the endpoint dropped.
 */
let sessionRefresh: AbortController | undefined;

function startBackgroundRefresh(): void {
	if (OFFLINE) return;
	stopBackgroundRefresh();
	const controller = new AbortController();
	sessionRefresh = controller;
	const { signal } = controller;
	void (async () => {
		ensureFreshOpenCodeVersion(signal);
		const result = await discoverFreeModels({ signal });
		if (result.liveIds) lastLiveIds = result.liveIds;
	})().catch(() => {
		// The next catalog refresh retries; nothing here is worth an extension error.
	});
}

function stopBackgroundRefresh(): void {
	sessionRefresh?.abort();
	sessionRefresh = undefined;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

/**
 * Registers the provider from the cache (or the bundled baseline) without any
 * network or process work: Pi already waits for async factories, but it also
 * loads extensions for invocations that never start a session, and the docs ask
 * extensions not to start processes or network requests in the factory. The
 * OpenCode version and the model catalogue are refreshed from `fetchModels`
 * (Pi's catalog refresh) and from a `session_start` background task.
 */
export default function openCodeFreeExtension(pi: ExtensionAPI): void {
	const cached = cachedDiscovery();
	if (cached) {
		// Seed the in-memory discovery so availability filtering works before the first refresh.
		discovery = cached;
		lastLiveIds = cached.liveIds;
		for (const model of cached.models) discoveredIds.add(model.id);
	}
	const models = cached?.models.length ? cached.models : BASELINE_FREE_MODELS;

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
			models,
			async fetchModels(context) {
				try {
					// Pi's `createProvider` already skips `fetchModels` when network access is disallowed or the
					// refresh was aborted; this guard only covers direct calls and a signal aborted since then.
					if (context.signal.aborted) return discovery?.models ?? models;
					ensureFreshOpenCodeVersion(context.signal);
					const stored = (context.stored?.models ?? []) as Model<Api>[];
					const result = await discoverFreeModels({ stored, signal: context.signal });
					if (result.liveIds) lastLiveIds = result.liveIds;
					return result.models;
				} catch {
					// A provider refresh must never surface an error for a lookup that keeps its own cache.
					return discovery?.models ?? BASELINE_FREE_MODELS;
				}
			},
			filterModels: (candidates) => filterDiscoveredModels(candidates, discovery?.models ?? [], lastLiveIds, discoveredIds),
			api: {
				"openai-responses": withFingerprint(openAIResponsesApi()),
				"openai-completions": withFingerprint(openAICompletionsApi()),
			},
		}),
	);

	pi.on("session_start", () => {
		startBackgroundRefresh();
	});
	pi.on("session_shutdown", () => {
		stopBackgroundRefresh();
	});
}
