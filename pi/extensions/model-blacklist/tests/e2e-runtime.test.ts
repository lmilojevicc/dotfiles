import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import modelBlacklist from "../index.ts";
import { unwrapProvider } from "../provider-wrap.ts";
import { ids } from "./helpers.ts";

const HOOK_STATE_KEY = Symbol.for("pi.model-blacklist.hook-state");

const PROVIDER = "cliproxyapi";
const BLOCKED = ["claude-opus-4-6-thinking", "claude-sonnet-4-6", "gemini-3.1-flash-lite", "gemini-3.1-pro-low"];
const KEPT = "claude-opus-5-5";

/**
 * End to end against Pi's real `ModelRuntime`. A provider defined only in
 * `models.json` is composed from nothing but that file, so Pi re-adds its models
 * every time it composes — the case where filtering the provider object before
 * composition used to leak every `models.json` model back into the catalogue.
 */
test("a models.json provider stays filtered through real composition", async () => {
	const dir = process.env.PI_CODING_AGENT_DIR!;
	writeFileSync(
		join(dir, "models.json"),
		JSON.stringify({
			providers: {
				[PROVIDER]: {
					baseUrl: "http://127.0.0.1:9/v1",
					api: "openai-completions",
					apiKey: "test-key",
					models: [...BLOCKED, KEPT].map((id) => ({ id })),
				},
			},
		}),
	);
	const writeRules = (rules: unknown): void => {
		writeFileSync(join(dir, "model-blacklist.json"), JSON.stringify(rules));
	};
	writeRules({ global: ["*claude-{opus,sonnet,haiku}-<5.5*", "*gemini-<3.8*"] });
	delete (globalThis as unknown as Record<symbol, unknown>)[HOOK_STATE_KEY];

	const runtime = await ModelRuntime.create({ refreshOnCreate: false });
	const before = await runtime.getAvailable();
	assert.deepEqual(ids(before.filter((model) => model.provider === PROVIDER)).sort(), [...BLOCKED, KEPT].sort());

	const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
	modelBlacklist({
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand: () => {},
	} as never);
	const ctx = {
		modelRegistry: { runtime },
		mode: "rpc" as const,
		hasUI: true,
		ui: { notify: () => {} },
	};
	const sessionStart = (reason: string): void => {
		for (const handler of handlers.get("session_start") ?? []) handler({ type: "session_start", reason }, ctx);
	};

	sessionStart("startup");
	assert.deepEqual(ids(runtime.getModels(PROVIDER)), [KEPT]);
	assert.deepEqual(ids(runtime.getAllModels(PROVIDER)), [KEPT]);

	// Pi's own availability pass reads through the stored provider.
	await runtime.getAvailable();
	assert.deepEqual(ids(runtime.getAvailableSnapshot().filter((model) => model.provider === PROVIDER)), [KEPT]);

	// A full recomposition writes a freshly composed provider holding every models.json model.
	await runtime.refresh({ allowNetwork: false });
	assert.deepEqual(ids(runtime.getModels(PROVIDER)), [KEPT]);
	assert.deepEqual(ids(runtime.getAllModels(PROVIDER)), [KEPT]);

	// Applying again does not stack wrappers on the stored provider.
	sessionStart("reload");
	sessionStart("reload");
	const stored = runtime.getProvider(PROVIDER)!;
	assert.equal(unwrapProvider(unwrapProvider(stored)), unwrapProvider(stored));
	assert.deepEqual(ids(stored.getModels()), [KEPT]);

	// An empty config unhides every model again.
	writeRules({});
	sessionStart("reload");
	assert.deepEqual(ids(runtime.getModels(PROVIDER)).sort(), [...BLOCKED, KEPT].sort());
});
