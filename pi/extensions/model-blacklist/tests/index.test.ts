import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { Provider } from "@earendil-works/pi-ai/compat";
import modelBlacklist from "../index.ts";
import { unwrapProvider } from "../provider-wrap.ts";
import { fakeProvider } from "./helpers.ts";

const APPLIED_KEY = Symbol.for("pi.model-blacklist.applied");

function createHarness(providers: Provider[]) {
	const current = new Map(providers.map((provider) => [provider.id, provider]));
	const handlers = new Map<string, ((...args: unknown[]) => unknown)[]>();
	const commands = new Map<string, { description: string; handler: (args: string, ctx: unknown) => unknown }>();
	const notices: { message: string; type: string }[] = [];
	const pi = {
		on: (event: string, handler: (...args: unknown[]) => unknown) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand: (name: string, options: { description: string; handler: (args: string, ctx: unknown) => unknown }) => {
			commands.set(name, options);
		},
		registerProvider: (provider: Provider) => current.set(provider.id, provider),
	};
	const ctx = {
		modelRegistry: {
			getProvider: (providerId: string) => current.get(providerId),
			getAll: () => [...current.values()].flatMap((provider) => [...provider.getModels()]),
		},
		ui: { notify: (message: string, type: string) => notices.push({ message, type }) },
	};
	modelBlacklist(pi as never);
	const start = () => (handlers.get("session_start") ?? []).map((handler) => handler({ type: "session_start", reason: "startup" }, ctx));
	const command = () => commands.get("model-blacklist")!.handler("", ctx);
	return { current, notices, start, command };
}

function writeConfig(contents: unknown): void {
	mkdirSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true });
	writeFileSync(join(process.env.PI_CODING_AGENT_DIR!, "model-blacklist.json"), typeof contents === "string" ? contents : JSON.stringify(contents));
}

test.beforeEach(() => {
	(globalThis as unknown as Record<symbol, unknown>)[APPLIED_KEY] = new Set<string>();
	rmSync(join(process.env.PI_CODING_AGENT_DIR!, "model-blacklist.json"), { force: true });
});

test("session_start filters configured providers silently", () => {
	writeConfig({ providers: { alpha: ["drop"] } });
	const alpha = fakeProvider("alpha", ["keep", "drop"]);
	const { current, notices, start } = createHarness([alpha]);

	start();

	assert.deepEqual(notices, []);
	assert.equal(unwrapProvider(current.get("alpha")!), alpha);
	assert.deepEqual(current.get("alpha")!.getModels().map((model) => model.id), ["keep"]);
});

test("session_start warns about a malformed config and hides nothing", () => {
	writeConfig("{bad");
	const alpha = fakeProvider("alpha", ["keep", "drop"]);
	const { current, notices, start } = createHarness([alpha]);

	start();

	assert.equal(notices.length, 1);
	assert.equal(notices[0]!.type, "warning");
	assert.match(notices[0]!.message, /no models are hidden/);
	assert.equal(current.get("alpha"), alpha);
});

test("the command applies rules, reports patterns, and restores removed rules", async () => {
	writeConfig({ providers: { alpha: ["drop"] }, global: ["*-preview"] });
	const alpha = fakeProvider("alpha", ["keep", "drop", "hy4-preview"]);
	const beta = fakeProvider("beta", ["hy4-preview"]);
	const { current, notices, command } = createHarness([alpha, beta]);

	await command();
	assert.equal(current.get("alpha")!.getModels().length, 1);
	assert.equal(current.get("beta")!.getModels().length, 0);
	assert.equal(notices.at(-1)!.type, "info");
	assert.match(notices.at(-1)!.message, /2 pattern/);
	assert.match(notices.at(-1)!.message, /alpha: drop, \*-preview/);
	assert.match(notices.at(-1)!.message, /beta: \*-preview/);

	writeConfig({ providers: { beta: ["hy4-preview"] }, global: [] });
	await command();
	assert.equal(current.get("alpha"), alpha);
	assert.deepEqual(current.get("alpha")!.getModels().map((model) => model.id), ["keep", "drop", "hy4-preview"]);
	assert.deepEqual(current.get("beta")!.getModels().map((model) => model.id), []);
});

test("the command reports unknown providers and an empty configuration", async () => {
	writeConfig({ providers: { ghost: ["x"] } });
	const { notices, command } = createHarness([]);

	await command();
	assert.match(notices.at(-1)!.message, /Unknown providers \(ignored\): ghost/);

	writeConfig({ providers: {}, global: [] });
	await command();
	assert.match(notices.at(-1)!.message, /No providers configured; no models are hidden/);
});
