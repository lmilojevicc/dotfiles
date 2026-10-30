/**
 * Pure helpers: the request fingerprint, the OpenCode identifier, free-model
 * merging, metadata precedence, the availability filter, and error rewriting.
 * Nothing here touches the network or the disk.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import {
	descendingHex,
	describeZenError,
	ensureFingerprintTools,
	extractModelsDev,
	familyKey,
	filterDiscoveredModels,
	mergeFreeModels,
	openCodeProjectId,
	openCodeSessionId,
	synthesizeFreeModel,
} from "../index.ts";

function referenceDescendingHex(timestamp: number, counter: number): string {
	const current = BigInt(timestamp) * 0x1000n + BigInt(counter);
	const value = ~current;
	return Array.from({ length: 6 }, (_, index) =>
		Number((value >> BigInt(40 - 8 * index)) & 0xffn)
			.toString(16)
			.padStart(2, "0"),
	).join("");
}

test("descendingHex matches OpenCode's byte-wise Identifier.descending()", () => {
	for (const timestamp of [0, 1, 1_600_000_000_000, 1_792_000_000_000, Date.now()]) {
		for (const counter of [1, 2, 4095, 4096]) {
			assert.equal(descendingHex(timestamp, counter), referenceDescendingHex(timestamp, counter), `descendingHex(${timestamp}, ${counter})`);
		}
	}
});

test("session ids keep the gateway shape and rotate after the TTL", () => {
	const id = openCodeSessionId("session-a", 1_792_000_000_000);
	assert.match(id, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
	assert.equal(id, openCodeSessionId("session-a", 1_792_000_000_001), "stable within its TTL");
	assert.notEqual(id, openCodeSessionId("session-b", 1_792_000_000_000), "different sessions get different ids");
	assert.notEqual(openCodeSessionId("session-a", 1_792_000_000_000 + 2 * 60 * 60 * 1000), id, "rotates after the TTL");
	assert.equal(id.slice(4, 16), descendingHex(1_792_000_000_000, 1), "the timestamp prefix decodes to the request time");
});

test("project ids are stable 40 character hex strings", () => {
	assert.match(openCodeProjectId("/tmp/example"), /^[0-9a-f]{40}$/);
	assert.equal(openCodeProjectId("/tmp/example"), openCodeProjectId("/tmp/example"));
});

test("a request without tools gets the read marker and cannot call it", () => {
	const completions = ensureFingerprintTools({ model: "big-pickle", tools: [] }, "openai-completions") as {
		tools: Array<Record<string, unknown>>;
		tool_choice?: string;
	};
	assert.deepEqual(
		completions.tools.map((tool) => (tool.function as Record<string, unknown>).name),
		["read"],
		"completions get a single read marker wrapped in `function`",
	);
	assert.equal(completions.tools.length, 1, "no shell stub is added");
	assert.ok(
		completions.tools.every((tool) => tool.type === "function"),
		"completions tool type",
	);
	assert.match(String((completions.tools[0].function as Record<string, unknown>).description), /not executable/);
	assert.equal(completions.tool_choice, "none", "a request without tools cannot call the marker");

	const omitted = ensureFingerprintTools({ model: "big-pickle" }, "openai-completions") as { tools: unknown[]; tool_choice?: string };
	assert.equal(omitted.tools.length, 1, "a missing tools array gets the marker");
	assert.equal(omitted.tool_choice, "none", "a missing tools array cannot call the marker");
});

test("the responses API keeps its tool_choice and flat tool shape", () => {
	const responses = ensureFingerprintTools({ model: "big-pickle" }, "openai-responses") as {
		tools: Array<Record<string, unknown>>;
		tool_choice?: string;
	};
	assert.deepEqual(
		responses.tools.map((tool) => tool.name),
		["read"],
		"responses tools stay flat",
	);
	assert.equal(responses.tool_choice, undefined, "responses requests keep their tool_choice");
});

test("a tool-bearing request only gains the marker", () => {
	const piTools = [
		{ type: "function", function: { name: "write", description: "pi write", parameters: {} } },
		{ type: "function", function: { name: "bash", description: "pi bash", parameters: {} } },
	];
	const withTools = ensureFingerprintTools({ tools: piTools }, "openai-completions") as {
		tools: Array<Record<string, unknown>>;
		tool_choice?: string;
	};
	assert.deepEqual(
		withTools.tools.map((tool) => (tool.function as Record<string, unknown>).name),
		["write", "bash", "read"],
	);
	assert.equal(withTools.tool_choice, undefined, "tool-bearing requests keep tool use enabled");
});

test("a real read tool is never touched or duplicated", () => {
	const kept = ensureFingerprintTools(
		{ tools: [{ type: "function", function: { name: "read", description: "pi read", parameters: {} } }] },
		"openai-completions",
	) as { tools: Array<Record<string, unknown>>; tool_choice?: string };
	assert.equal(kept.tools.length, 1);
	assert.equal((kept.tools[0].function as Record<string, unknown>).description, "pi read");
	assert.equal(kept.tool_choice, undefined);
});

test("an explicit tool_choice wins and non-object payloads pass through", () => {
	const explicit = ensureFingerprintTools({ tools: [], tool_choice: "auto" }, "openai-completions") as { tool_choice?: string };
	assert.equal(explicit.tool_choice, "auto");
	assert.equal(ensureFingerprintTools(null, "openai-completions"), null);
});

const catalog = [
	{ id: "live-free", name: "Live Free", api: "openai-completions", cost: { input: 0, output: 0 }, contextWindow: 1000, maxTokens: 100, type: "chat" },
	{ id: "dead-free", name: "Dead Free", api: "openai-completions", cost: { input: 0, output: 0 }, contextWindow: 1000, maxTokens: 100, type: "chat" },
	{ id: "paid", name: "Paid", api: "openai-completions", cost: { input: 1, output: 1 }, type: "chat" },
	{ id: "an-anthropic-free", name: "Anthropic Free", api: "anthropic-messages", cost: { input: 0, output: 0 }, type: "chat" },
	{ id: "jev-1.13-free", name: "Jev", api: "typesafe-system-one", cost: { input: 0, output: 0 }, type: "classifier" },
];
const stored = [
	{ id: "kept-from-store", provider: "opencode-free", name: "Kept", api: "openai-completions", cost: { input: 0, output: 0 } },
	{ id: "dead-free", provider: "opencode-free", name: "Stale Dead", api: "openai-completions", cost: { input: 0, output: 0 } },
	{ id: "other-provider", provider: "somebody-else", api: "openai-completions", cost: { input: 0, output: 0 } },
] as unknown as Model<Api>[];

test("mergeFreeModels intersects catalog, store and live ids", () => {
	const merged = mergeFreeModels({
		catalog,
		knownIds: new Set(catalog.map((entry) => entry.id)),
		stored,
		liveIds: new Set(["live-free", "kept-from-store", "jev-1.13-free", "brand-new-free", "paid"]),
	});
	assert.deepEqual(
		merged.map((model) => model.id).sort(),
		["brand-new-free", "kept-from-store", "live-free"],
		"catalog + stored + live-only ids; dead/paid/unsupported entries dropped",
	);

	const offline = mergeFreeModels({ catalog, knownIds: new Set(catalog.map((entry) => entry.id)), stored });
	assert.deepEqual(
		offline.map((model) => model.id).sort(),
		["dead-free", "kept-from-store", "live-free"],
		"without a live list nothing is dropped",
	);
});

test("a stored classifier is dropped once the catalog classifies it", () => {
	const storedWithClassifier = [
		...stored,
		{ id: "jev-1.13-free", provider: "opencode-free", name: "Jev", api: "openai-completions", cost: { input: 0, output: 0 } },
	] as unknown as Model<Api>[];
	assert.ok(
		!mergeFreeModels({
			catalog,
			knownIds: new Set(catalog.map((entry) => entry.id)),
			stored: storedWithClassifier,
			liveIds: new Set(["live-free", "jev-1.13-free"]),
		}).some((model) => model.id === "jev-1.13-free"),
	);
});

test("live-only ids are not synthesized without catalog knowledge", () => {
	assert.deepEqual(
		mergeFreeModels({ stored: [], liveIds: new Set(["brand-new-free"]) }).map((model) => model.id),
		[],
		"without a catalog classifiers cannot be told from chat models",
	);
});

const modelsDevFixture = {
	zai: {
		models: {
			"glm-5.3-flash": { name: "GLM 5.3 Flash", cost: { input: 0.15, output: 0.5 }, limit: { context: 1000000, output: 131072 } },
		},
	},
	opencode: {
		models: {
			"glm-5.3-flash-free": {
				name: "GLM 5.3 Flash Free",
				cost: { input: 0, output: 0, cache_read: 0 },
				limit: { context: 200000, output: 32000 },
				modalities: { input: ["text", "image", "video", "pdf"] },
				reasoning: true,
				canonical_model_id: "zhipuai/glm-5.3-flash",
			},
			"no-canonical-free": { name: "No Canonical", cost: { input: 0, output: 0 }, limit: { context: 111, output: 22 } },
			"space-bunny-free": {
				name: "Space Bunny Free",
				cost: { input: 0, output: 0 },
				limit: { context: 1, output: 2 },
				modalities: { input: ["text"] },
			},
			"glm-5.3-flash": { name: "Paid", cost: { input: 0.15, output: 0.5 }, limit: { context: 1000000, output: 131072 } },
		},
	},
};
const extracted = extractModelsDev(modelsDevFixture);

test("models.dev extraction keeps only free entries and prefers the vendor's limits", () => {
	assert.deepEqual(Object.keys(extracted).sort(), ["glm-5.3-flash-free", "no-canonical-free", "space-bunny-free"]);
	assert.equal(extracted["glm-5.3-flash-free"]?.contextWindow, 1000000, "vendor limits replace the free entry's policy numbers");
	assert.equal(extracted["glm-5.3-flash-free"]?.maxTokens, 131072, "vendor output limit replaces the free entry's");
	assert.equal(extracted["no-canonical-free"]?.contextWindow, 111, "entries without a canonical id keep their own limits");
	assert.deepEqual(extracted["glm-5.3-flash-free"]?.input, ["text", "image"], "unsupported modalities are dropped");
});

const paidSibling = {
	id: "glm-5.3-flash",
	provider: "opencode-free",
	name: "GLM 5.3 Flash",
	api: "openai-completions",
	baseUrl: "https://opencode.ai/inference/v1",
	reasoning: true,
	input: ["text", "image"],
	contextWindow: 1000000,
	maxTokens: 131072,
} as unknown as Model<Api>;

test("synthesizeFreeModel prefers the sibling, then models.dev, then defaults", () => {
	const exact = synthesizeFreeModel("glm-5.3-flash-free", [paidSibling], extracted["glm-5.3-flash-free"]);
	assert.equal(exact.contextWindow, 1000000, "the sibling is the same upstream model, so its window wins");
	assert.equal(exact.maxTokens, 131072, "the sibling's output limit wins over policy numbers");
	assert.deepEqual(exact.input, ["text", "image"]);
	assert.ok(exact.inputLimits, "image input gets resize limits");
	assert.equal(exact.api, "openai-completions", "the protocol still comes from the sibling");
	assert.equal(exact.name, "GLM 5.3 Flash Free", "models.dev still supplies the display name");

	const noSibling = synthesizeFreeModel("no-canonical-free", [], { contextWindow: 111, maxTokens: 22, input: ["text", "image"] });
	assert.equal(noSibling.contextWindow, 111, "without a sibling models.dev limits apply");
	assert.deepEqual(noSibling.input, ["text", "image"]);

	assert.equal(synthesizeFreeModel("glm-5.3-flash-free", [paidSibling]).contextWindow, 1000000, "without models.dev the sibling is the fallback");
	assert.equal(synthesizeFreeModel("brand-new-free").contextWindow, 200000, "without any metadata the conservative default applies");
});

test("synthesized models keep the provider endpoint and pick the right API", () => {
	const synthesized = synthesizeFreeModel("brand-new-free");
	assert.equal(synthesized.provider, "opencode-free");
	assert.equal(synthesized.baseUrl, "https://opencode.ai/inference/v1");
	assert.equal(synthesizeFreeModel("muse-spark-9-free").api, "openai-responses");
	assert.equal(synthesizeFreeModel("claude-x-free").api, "anthropic-messages");
});

test("synthesizeFreeModel clones a same-family sibling's metadata", () => {
	assert.equal(familyKey("glm-5.3-flash-free"), familyKey("glm-5.3-flash"));
	assert.equal(familyKey("muse-spark-1.2-contributor-free"), familyKey("muse-spark-1.3-contributor-free"));
	const siblingTemplate = {
		id: "glm-5.3-flash",
		provider: "opencode-free",
		name: "GLM 5.3 Flash",
		api: "openai-completions",
		baseUrl: "https://opencode.ai/inference/v1",
		input: ["text", "image"],
		contextWindow: 999,
		maxTokens: 111,
	} as unknown as Model<Api>;
	const cloned = synthesizeFreeModel("glm-5.3-flash-free", [siblingTemplate]);
	assert.equal(cloned.contextWindow, 999);
	assert.equal(cloned.maxTokens, 111);
	assert.deepEqual(cloned.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, "cloned free models keep zero cost");
	assert.equal(cloned.name, "GLM 5.3 Flash Free");
});

test("mergeFreeModels forwards models.dev metadata to synthesized and catalog models", () => {
	const mergedWithMeta = mergeFreeModels({ stored: [], liveIds: new Set(["glm-5.3-flash-free"]), knownIds: new Set(), meta: extracted });
	assert.equal(mergedWithMeta.find((model) => model.id === "glm-5.3-flash-free")?.maxTokens, 131072);

	const catalogWithSibling = mergeFreeModels({
		catalog: [
			{
				id: "glm-5.3-flash-free",
				name: "GLM Free",
				api: "openai-completions",
				cost: { input: 0, output: 0 },
				contextWindow: 200000,
				maxTokens: 32000,
				input: ["text"],
				type: "chat",
			},
			{
				id: "glm-5.3-flash",
				name: "GLM",
				api: "openai-completions",
				cost: { input: 0.15, output: 0.5 },
				contextWindow: 1000000,
				maxTokens: 131072,
				input: ["text", "image"],
				reasoning: true,
				type: "chat",
			},
			{
				id: "solo-free",
				name: "Solo Free",
				api: "openai-completions",
				cost: { input: 0, output: 0 },
				contextWindow: 200000,
				maxTokens: 32000,
				input: ["text"],
				type: "chat",
			},
		],
		knownIds: new Set(["glm-5.3-flash-free", "glm-5.3-flash", "solo-free"]),
		liveIds: new Set(["glm-5.3-flash-free", "solo-free"]),
		meta: { "solo-free": { contextWindow: 1048576, maxTokens: 131072, input: ["text", "image"] } },
	});
	const catalogSibling = catalogWithSibling.find((model) => model.id === "glm-5.3-flash-free");
	assert.equal(catalogSibling?.contextWindow, 1000000, "a free catalog entry takes its sibling's window");
	assert.equal(catalogSibling?.maxTokens, 131072, "a free catalog entry takes its sibling's output limit");
	assert.deepEqual(catalogSibling?.input, ["text", "image"], "modalities are unioned with the sibling's");
	assert.equal(catalogWithSibling.find((model) => model.id === "solo-free")?.contextWindow, 1048576, "models.dev covers catalog models without a sibling");
});

test("filterDiscoveredModels keeps known candidates and survives without discovery", () => {
	const candidates = [
		{ id: "glm-5.3-flash-free", provider: "opencode-free", contextWindow: 200000, maxTokens: 32000 },
		{ id: "custom-from-models-json", provider: "opencode-free", contextWindow: 5, maxTokens: 5 },
	] as unknown as Model<Api>[];
	const latest = [{ id: "glm-5.3-flash-free", provider: "opencode-free", contextWindow: 1048576, maxTokens: 131072 }] as unknown as Model<Api>[];

	const filtered = filterDiscoveredModels(candidates, latest, new Set(["glm-5.3-flash-free"]), new Set(["glm-5.3-flash-free"]));
	assert.deepEqual(filtered, candidates, "candidates keep the models.json overrides Pi composed into them");
	assert.deepEqual(filterDiscoveredModels(candidates, []).map((model) => model.id), candidates.map((model) => model.id), "an empty discovery leaves the list alone");
	assert.deepEqual(
		filterDiscoveredModels(candidates, latest, undefined, new Set(["glm-5.3-flash-free"])).map((model) => model.id),
		candidates.map((model) => model.id),
		"without a live list nothing is dropped",
	);
});

test("filterDiscoveredModels drops only discovery-owned ids the live endpoint dropped", () => {
	const candidates = [
		{ id: "glm-5.3-flash-free", provider: "opencode-free" },
		{ id: "retired-free", provider: "opencode-free" },
		{ id: "custom-from-models-json", provider: "opencode-free" },
	] as unknown as Model<Api>[];
	const latest = [{ id: "glm-5.3-flash-free", provider: "opencode-free" }] as unknown as Model<Api>[];
	const liveIds = new Set(["glm-5.3-flash-free", "custom-from-models-json"]);
	const discoveryIds = new Set(["glm-5.3-flash-free", "retired-free"]);

	assert.deepEqual(
		filterDiscoveredModels(candidates, latest, liveIds, discoveryIds).map((model) => model.id),
		["glm-5.3-flash-free", "custom-from-models-json"],
		"a retired discovery id disappears and an unknown addition survives",
	);
	assert.deepEqual(
		filterDiscoveredModels(candidates, latest, liveIds).map((model) => model.id),
		["glm-5.3-flash-free", "retired-free", "custom-from-models-json"],
		"without provenance nothing is assumed to be ours",
	);
});

test("describeZenError turns terse gateway errors into actionable text", () => {
	assert.match(describeZenError("FreeTierError"), /fingerprint/);
	assert.match(describeZenError("FreeUsageLimitError"), /daily quota for this IP/);
	assert.match(describeZenError("RegionError"), /region restriction/);
	assert.match(describeZenError('{"error":"insufficient balance"}'), /balance is empty/);
	assert.match(describeZenError("RateLimitError"), /transient/);
	assert.equal(describeZenError(""), "");
	assert.equal(describeZenError(undefined), "");
});
