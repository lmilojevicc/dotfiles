/**
 * The `session_start` background discovery has to publish the same state a
 * catalog refresh does: without the live ids it learns, `filterModels` cannot
 * hide baseline entries that the endpoint stopped serving.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import type { Model, Provider } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const agentDir = process.env.PI_CODING_AGENT_DIR as string;
const cachePath = join(agentDir, "opencode-free.json");

function model(id: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "opencode-free",
		baseUrl: "https://opencode.ai/inference/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
	};
}

// A stale cache whose only model the endpoint no longer serves. The cache also
// seeds the live ids, so a refresh that forgets to update them leaves the stale
// id unhideable.
mkdirSync(dirname(cachePath), { recursive: true });
writeFileSync(
	cachePath,
	`${JSON.stringify(
		{
			models: [model("stale-free")],
			liveIds: ["stale-free"],
			modelsCheckedAt: Date.now() - 20 * 60 * 1000,
			discoveredIds: ["stale-free"],
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

// The endpoint now serves exactly one model.
globalThis.fetch = (async (input: string | URL | Request) => {
	const url = urlOf(input);
	requested.push(url);
	if (url.includes("/zen/v1/models")) return json({ data: [{ id: "fresh-free" }] });
	if (url.includes("/api/models/providers/opencode")) {
		return json([
			{
				id: "fresh-free",
				name: "fresh-free",
				api: "openai-completions",
				cost: { input: 0, output: 0 },
				contextWindow: 200000,
				maxTokens: 32000,
				type: "chat",
			},
		]);
	}
	if (url.includes("models.dev")) return json({});
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

extension.default(pi);
const provider = providers[0];

async function until(condition: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("timed out waiting for the condition");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function cachedLiveIds(): string[] | undefined {
	try {
		return JSON.parse(readFileSync(cachePath, "utf8")).liveIds;
	} catch {
		return undefined;
	}
}

test("the cached live ids keep the cached model selectable while discovery is pending", () => {
	const filtered = provider.filterModels?.([...provider.getModels()], undefined) ?? [];
	assert.deepEqual(
		filtered.map((entry) => entry.id),
		["stale-free"],
		"the cached live ids still list the cached model",
	);
});

test("the session_start discovery publishes the live ids it learned", async () => {
	handlers.get("session_start")?.({});

	await until(() => requested.some((url) => url.includes("/zen/v1/models")));
	await until(() => cachedLiveIds()?.join(",") === "fresh-free");
	assert.deepEqual(cachedLiveIds(), ["fresh-free"], "the background discovery persists the live ids");

	const candidates = [...provider.getModels(), model("fresh-free")] as Model<"openai-completions">[];
	const filtered = provider.filterModels?.(candidates, undefined) ?? [];
	assert.deepEqual(
		filtered.map((entry) => entry.id),
		["fresh-free"],
		"the model the endpoint stopped serving is hidden",
	);
});
