/**
 * `session_start` starts the discovery/version refresh in the background and
 * `session_shutdown` cancels it, so a BB thread that is torn down mid-request
 * leaves no in-flight work behind.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Provider } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// No cache and no models store: the factory must fall back to the baseline list.
const agentDir = process.env.PI_CODING_AGENT_DIR as string;
const cachePath = join(agentDir, "opencode-free.json");

const extension = await import("../index.ts");

const requested: Array<{ url: string; signal?: AbortSignal }> = [];
const originalFetch = globalThis.fetch;

function json(value: unknown): Response {
	return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

function urlOf(input: string | URL | Request): string {
	if (typeof input === "string") return input;
	return input instanceof URL ? input.href : input.url;
}

function hang(signal: AbortSignal | undefined): Promise<Response> {
	return new Promise((_, reject) => {
		signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
	});
}

globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
	const url = urlOf(input);
	requested.push({ url, signal: init?.signal ?? undefined });
	// The version lookup succeeds; the catalogue requests hang until the session ends.
	if (url.includes("homebrew")) return Promise.resolve(new Response('url "https://example.test/opencode-2.0.99.tgz"', { status: 200 }));
	if (url.includes("/zen/v1/models")) return Promise.resolve(json({ data: [{ id: "fresh-free" }] }));
	if (url.includes("models.dev")) return Promise.resolve(json({}));
	return hang(init?.signal ?? undefined);
}) as typeof fetch;

after(() => {
	globalThis.fetch = originalFetch;
});

const providers: Provider[] = [];
const handlers = new Map<string, (event: { type: string }) => void>();
const pi = {
	registerProvider(provider: Provider) {
		providers.push(provider);
	},
	on(event: string, handler: (event: { type: string }) => void) {
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

test("without a cache the factory still registers the bundled baseline", () => {
	assert.ok(provider.getModels().length > 0, "the baseline catalogue keeps the provider usable");
	assert.equal(requested.length, 0, "loading did not fetch anything");
	assert.ok(!existsSync(cachePath) || !readFileSync(cachePath, "utf8").includes("models"), "loading did not write a catalogue");
});

test("session_start refreshes in the background and session_shutdown cancels it", async () => {
	handlers.get("session_start")?.({ type: "session_start" });
	await until(() => requested.some((entry) => entry.url.includes("/api/models/providers/opencode")));
	assert.ok(requested.some((entry) => entry.url.includes("homebrew")), "the version lookup runs with the discovery");

	handlers.get("session_shutdown")?.({ type: "session_shutdown" });
	const catalogueRequest = requested.find((entry) => entry.url.includes("/api/models/providers/opencode"));
	assert.ok(catalogueRequest?.signal, "the background requests carry an abort signal");
	assert.equal(catalogueRequest.signal.aborted, true, "session_shutdown aborts the in-flight discovery request");

	// Give the aborted requests a chance to settle; nothing may be published.
	await new Promise((resolve) => setTimeout(resolve, 50));
	const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};
	assert.equal(cache.models, undefined, "a cancelled discovery does not publish a catalogue");
	assert.equal(cache.modelsCheckedAt, undefined, "a cancelled discovery does not mark the cache fresh");
});
