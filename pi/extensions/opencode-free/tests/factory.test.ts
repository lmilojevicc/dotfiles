/**
 * Loading must not do network or process work: Pi loads extensions for
 * invocations that never start a session. The catalogue comes from the cache,
 * and Pi's catalog refresh (`fetchModels`) does the refreshing.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import type { Model, Provider } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const agentDir = process.env.PI_CODING_AGENT_DIR as string;
const cachePath = join(agentDir, "opencode-free.json");
const cachedModel: Model<"openai-completions"> = {
	id: "cached-free",
	name: "Cached Free",
	api: "openai-completions",
	provider: "opencode-free",
	baseUrl: "https://opencode.ai/inference/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 32000,
};

// Seed a stale cache before the extension module reads it at import time: both
// the catalogue and the version are old enough to trigger a refresh.
mkdirSync(dirname(cachePath), { recursive: true });
writeFileSync(
	cachePath,
	`${JSON.stringify(
		{
			version: "9.9.9",
			versionCheckedAt: Date.now() - 7 * 60 * 60 * 1000,
			models: [cachedModel],
			liveIds: ["cached-free"],
			modelsCheckedAt: Date.now() - 20 * 60 * 1000,
			discoveredIds: ["cached-free"],
		},
		null,
		1,
	)}\n`,
);

const extension = await import("../index.ts");

const requested: string[] = [];
const originalFetch = globalThis.fetch;

function json(value: unknown): Response {
	return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

function urlOf(input: string | URL | Request): string {
	if (typeof input === "string") return input;
	return input instanceof URL ? input.href : input.url;
}

// Stub before the factory runs so a load-time request would be recorded.
globalThis.fetch = (async (input: string | URL | Request) => {
	const url = urlOf(input);
	requested.push(url);
	if (url.includes("/zen/v1/models")) return json({ data: [{ id: "fresh-free" }, { id: "second-free" }] });
	if (url.includes("/api/models/providers/opencode")) {
		return json(
			["fresh-free", "second-free"].map((id) => ({
				id,
				name: id,
				api: "openai-completions",
				cost: { input: 0, output: 0 },
				contextWindow: 200000,
				maxTokens: 32000,
				type: "chat",
			})),
		);
	}
	if (url.includes("homebrew")) return new Response('url "https://example.test/opencode-2.0.99.tgz"', { status: 200 });
	throw new Error(`unexpected fetch: ${url}`);
}) as typeof fetch;

after(() => {
	globalThis.fetch = originalFetch;
});

const providers: Provider[] = [];
const handlers = new Map<string, () => void>();
const pi = {
	registerProvider(provider: Provider) {
		providers.push(provider);
	},
	on(event: string, handler: () => void) {
		handlers.set(event, handler);
		return () => {};
	},
} as unknown as ExtensionAPI;

// Loading happens here, at module scope, exactly like Pi calling the factory.
const loadResult = extension.default(pi);
const loadedProviders = providers.length;
const requestedWhileLoading = requested.length;
const provider = providers[0];

async function until(condition: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("timed out waiting for the condition");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

test("the factory registers the cached catalogue without any network or process work", () => {
	assert.equal(loadResult, undefined, "the factory is synchronous: no caller awaits discovery");
	assert.equal(loadedProviders, 1, "the provider is registered immediately");
	assert.equal(requestedWhileLoading, 0, "no discovery or version request ran while loading");
	assert.deepEqual(
		provider.getModels().map((model) => model.id),
		["cached-free"],
		"the cached list is the best catalogue available at load time",
	);
	assert.equal(typeof provider.refreshModels, "function", "Pi's catalog refresh owns the fetching");
	assert.deepEqual([...handlers.keys()].sort(), ["session_shutdown", "session_start"]);
});

test("refreshModels refreshes the version and publishes the discovered catalogue", async () => {
	const controller = new AbortController();
	await provider.refreshModels?.({
		allowNetwork: true,
		signal: controller.signal,
		async publish(publication) {
			publication.update?.();
			return true;
		},
	});

	assert.deepEqual(
		provider
			.getModels()
			.map((model) => model.id)
			.sort(),
		["cached-free", "fresh-free", "second-free"],
		"the discovered list is published on top of the registered baseline",
	);
	assert.ok(
		requested.some((url) => url.includes("/api/models/providers/opencode")),
		"the Pi catalog is consulted",
	);
	assert.ok(
		requested.some((url) => url.includes("/zen/v1/models")),
		"the live endpoint is consulted",
	);

	await until(() => {
		try {
			return JSON.parse(readFileSync(cachePath, "utf8")).version === "2.0.99";
		} catch {
			return false;
		}
	});
	const cache = JSON.parse(readFileSync(cachePath, "utf8"));
	assert.equal(cache.version, "2.0.99", "the version refresh also runs during a catalog refresh");
	assert.deepEqual(
		cache.models.map((model: Model<"openai-completions">) => model.id).sort(),
		["fresh-free", "second-free"],
	);
	assert.ok(cache.discoveredIds.includes("cached-free"), "ids discovery has seen survive a restart");
	assert.ok(cache.discoveredIds.includes("fresh-free"));
});

// Pi's `createProvider` skips `fetchModels` entirely when network access is
// disallowed, so the extension only ever has to honour an aborted refresh.
test("refreshModels does no requests for an aborted refresh", async () => {
	const before = requested.length;
	const controller = new AbortController();
	controller.abort();
	await provider.refreshModels?.({
		allowNetwork: true,
		signal: controller.signal,
		async publish() {
			return true;
		},
	});
	assert.equal(requested.length, before, "an aborted refresh stays offline");
	assert.ok(provider.getModels().length > 0, "the current catalogue survives");
});

test("models.json additions survive the availability filter", () => {
	const candidates = [
		...provider.getModels().filter((model) => model.id !== "fresh-free"),
		{ ...cachedModel, id: "fresh-free", contextWindow: 4096, maxTokens: 1024 },
		{ ...cachedModel, id: "custom-from-models-json", contextWindow: 5, maxTokens: 5 },
	] as Model<"openai-completions">[];
	const filtered = provider.filterModels?.(candidates, undefined) ?? [];
	assert.deepEqual(
		filtered.map((model) => model.id).sort(),
		["custom-from-models-json", "fresh-free", "second-free"],
		"a models.json addition is kept even though the live endpoint does not list it",
	);
	assert.equal(
		filtered.find((model) => model.id === "fresh-free")?.contextWindow,
		4096,
		"a candidate keeps the models.json override Pi composed into it",
	);
});
