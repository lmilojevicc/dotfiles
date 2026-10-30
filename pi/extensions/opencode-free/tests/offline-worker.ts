/**
 * Child process for the offline tests: loads the extension under whatever
 * offline switches the parent put in the environment and reports every request
 * a `session_start` refresh and a catalog refresh attempted. Not a test file.
 */
import type { Provider } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const requested: string[] = [];

function json(value: unknown): Response {
	return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

function urlOf(input: string | URL | Request): string {
	if (typeof input === "string") return input;
	return input instanceof URL ? input.href : input.url;
}

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

const extension = await import("../index.ts");

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
handlers.get("session_start")?.({});
await providers[0]?.refreshModels?.({
	allowNetwork: true,
	signal: new AbortController().signal,
	async publish() {
		return true;
	},
});
// Let any unawaited background work reach its first request.
await new Promise((resolve) => setTimeout(resolve, 100));

console.log(JSON.stringify(requested));
