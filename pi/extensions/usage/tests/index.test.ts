import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderAdapter, ProviderSnapshot } from "../core.ts";
import usage, { __testing } from "../index.ts";
import { adapterContext, jsonResponse, settle, tempDir } from "./helpers.ts";

function adapter(id: string, options: { visible?: boolean; used?: number; fail?: boolean } = {}): ProviderAdapter & { calls: number } {
	const result = {
		id, title: id, calls: 0,
		hasCredentials: async () => options.visible ?? true,
		fetch: async (): Promise<ProviderSnapshot> => {
			result.calls += 1;
			if (options.fail) throw new Error("down");
			return { providerId: id, title: id, observedAt: 0, rows: [{ label: id, windows: options.used === undefined ? [] : [{ label: "weekly", usedPercent: options.used }] }] };
		},
	};
	return result;
}

test("footer prefers the session model's provider, else the first visible provider with data", async () => {
	const signal = new AbortController().signal;
	const context = adapterContext();
	__testing.clearSnapshotCache();
	const adapters = [adapter("hidden", { visible: false, used: 90 }), adapter("nodata"), adapter("first", { used: 12.4 }), adapter("model", { used: 57.6 })];
	assert.equal(await __testing.computeStatus({ model: { provider: "model" } } as never, adapters, context, signal), "model 58% used");
	assert.equal(await __testing.computeStatus({ model: { provider: "other" } } as never, adapters, context, signal), "first 12% used");
	assert.equal(adapters[0]!.calls, 0, "providers without credentials are never fetched");
	assert.equal(await __testing.computeStatus({} as never, [adapter("x", { fail: true }), adapter("y")], context, signal), undefined);
});

test("footer cache dedupes in-flight fetches and keeps the last good snapshot on failure", async () => {
	__testing.clearSnapshotCache();
	const signal = new AbortController().signal;
	const context = adapterContext();
	let fail = false;
	let calls = 0;
	const flaky: ProviderAdapter = {
		id: "flaky", title: "flaky", hasCredentials: async () => true,
		fetch: async () => {
			calls += 1;
			if (fail) throw new Error("down");
			return { providerId: "flaky", title: "flaky", observedAt: 0, rows: [{ label: "x", windows: [{ label: "5h", usedPercent: 40 }] }] };
		},
	};
	const [first, second] = await Promise.all([__testing.fetchSnapshot(flaky, context, signal), __testing.fetchSnapshot(flaky, context, signal)]);
	assert.equal(first, second);
	assert.equal(calls, 1);
	fail = true;
	await assert.rejects(__testing.fetchSnapshot(flaky, context, signal, true), { message: "down" });
	assert.equal(await __testing.computeStatus({} as never, [flaky], context, signal), "flaky 40% used", "fresh cache serves the footer");
});

test("setStatus is guarded by hasUI", () => {
	const calls: unknown[] = [];
	__testing.setStatus({ hasUI: false, ui: { setStatus: (...args: unknown[]) => calls.push(args) } } as never, "x");
	assert.equal(calls.length, 0);
	__testing.setStatus({ hasUI: true, ui: { setStatus: (...args: unknown[]) => calls.push(args) } } as never, "x");
	assert.deepEqual(calls, [["usage", "x"]]);
});

test("extension registers /usage and publishes exactly the `usage` status key, cleared on shutdown", async (t) => {
	process.env.PI_CODING_AGENT_DIR = tempDir(t);
	const savedBaseUrl = process.env.PI_USAGE_CPA_BASE_URL;
	delete process.env.PI_USAGE_CPA_BASE_URL;
	// A fake Claude token makes the adapter visible without touching the real login.
	process.env.PI_USAGE_CLAUDE_TOKEN = "sk-ant-test-token";
	t.after(() => {
		delete process.env.PI_CODING_AGENT_DIR;
		delete process.env.PI_USAGE_CLAUDE_TOKEN;
		if (savedBaseUrl !== undefined) process.env.PI_USAGE_CPA_BASE_URL = savedBaseUrl;
	});
	const urls: string[] = [];
	t.mock.method(globalThis, "fetch", async (url: string) => {
		urls.push(String(url));
		return String(url) === "https://opencode.ai/zen/go/v1/usage"
			? jsonResponse({ usage: { rolling: { status: "ok", percent: 8 }, weekly: { status: "ok", percent: 22 }, monthly: { status: "ok", percent: 57 } } })
			: jsonResponse({}, 404);
	});
	const commands = new Map<string, unknown>();
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	usage({
		registerCommand: (name: string, options: unknown) => commands.set(name, options),
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, handler),
	} as never);
	assert.deepEqual([...commands.keys()], ["usage"]);
	assert.deepEqual([...handlers.keys()].sort(), ["after_provider_response", "agent_settled", "model_select", "session_shutdown", "session_start"]);

	const statuses: Array<[string, string | undefined]> = [];
	const ctx = {
		hasUI: true,
		mode: "tui",
		model: { provider: "opencode-go" },
		readKeychainItem: async () => undefined,
		ui: { setStatus: (key: string, text: string | undefined) => statuses.push([key, text]) },
		modelRegistry: {
			getProviderAuthStatus: (id: string) => ({ configured: id === "opencode-go" }),
			getProviderAuth: async (id: string) => id === "opencode-go" ? { auth: { apiKey: "sk-SECRET-zen", baseUrl: "https://opencode.ai/zen/go/v1" } } : undefined,
		},
	};
	handlers.get("session_start")!({}, ctx);
	await settle();
	assert.deepEqual(statuses, [["usage", "opencode-go 57% used"]]);
	assert.deepEqual(urls, ["https://opencode.ai/zen/go/v1/usage"]);
	handlers.get("agent_settled")!({}, ctx);

	// Claude rate-limit headers arrive for free; they publish a footer value and cost no request.
	const claudeCtx = { ...ctx, model: { provider: "claude-bridge" } };
	const before = urls.length;
	handlers.get("after_provider_response")!(
		{
			type: "after_provider_response",
			status: 200,
			headers: {
				"anthropic-ratelimit-unified-status": "allowed",
				"anthropic-ratelimit-unified-5h-utilization": "0.38",
				"anthropic-ratelimit-unified-5h-reset": "1760563800",
				"anthropic-ratelimit-unified-7d-utilization": "0.08",
				"anthropic-ratelimit-unified-7d-reset": "1760763600",
			},
		},
		claudeCtx,
	);
	await settle();
	assert.equal(urls.length, before, "live headers never trigger a request");
	assert.deepEqual(statuses.at(-1), ["usage", "claude 38% used"], "the footer prefers the session's provider through its alias");
	const live = __testing.mergeLiveSnapshot;
	assert.equal(typeof live, "function", "the live merge path is exposed for tests");
	await settle();
	assert.equal(urls.length, 1, "footer refreshes reuse the 5-minute cache");
	handlers.get("session_shutdown")!({}, ctx);
	assert.deepEqual(statuses.at(-1), ["usage", undefined]);
	assert.ok(statuses.every(([key]) => key === "usage"));

	const headless: unknown[] = [];
	handlers.get("session_start")!({}, { ...ctx, hasUI: false, ui: { setStatus: (...args: unknown[]) => headless.push(args) } });
	await settle();
	assert.equal(headless.length, 0, "no footer writes without a UI");
});
