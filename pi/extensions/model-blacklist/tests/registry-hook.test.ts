import assert from "node:assert/strict";
import test from "node:test";
import { unwrapProvider } from "../provider-wrap.ts";
import { installRegistryHook, type HookState } from "../registry-hook.ts";
import { compileRules } from "../rules.ts";
import { fakeProvider, fakeRuntime, ids } from "./helpers.ts";

function stateFor(config: { providers: Record<string, string[]>; global?: string[] }): HookState {
	return { rules: compileRules({ providers: config.providers, global: config.global ?? [] }), applied: new Set() };
}

test("a config re-registration of a targeted provider is wrapped again", () => {
	const runtime = fakeRuntime();
	const state = stateFor({ providers: { commandcode: ["claude-*"] } });
	installRegistryHook(runtime, state);

	runtime.registerProvider("commandcode", { models: ["claude-opus-5-5", "deepseek-v4.1-flash"] });

	assert.deepEqual(ids(runtime.getProvider("commandcode")!.getModels()), ["deepseek-v4.1-flash"]);
	assert.deepEqual([...state.applied], ["commandcode"]);
});

test("a native registration is wrapped before it lands, and an existing wrapper passes through", () => {
	const runtime = fakeRuntime();
	const state = stateFor({ providers: { alpha: ["drop"] } });
	installRegistryHook(runtime, state);

	const alpha = fakeProvider("alpha", ["keep", "drop"]);
	runtime.registerNativeProvider(alpha);
	const wrapped = runtime.getProvider("alpha")!;
	assert.equal(unwrapProvider(wrapped), alpha);
	assert.deepEqual(ids(wrapped.getModels()), ["keep"]);

	runtime.registerNativeProvider(wrapped);
	assert.equal(runtime.getProvider("alpha"), wrapped);
});

test("untargeted providers and an unset rule set are left alone", () => {
	const runtime = fakeRuntime();
	const state: HookState = { applied: new Set() };
	installRegistryHook(runtime, state);

	runtime.registerProvider("alpha", { models: ["drop"] });
	assert.deepEqual(ids(runtime.getProvider("alpha")!.getModels()), ["drop"]);

	state.rules = compileRules({ providers: { beta: ["drop"] }, global: [] });
	runtime.registerProvider("alpha", { models: ["drop"] });
	assert.equal(unwrapProvider(runtime.getProvider("alpha")!), runtime.getProvider("alpha"));
	assert.deepEqual([...state.applied], []);
});

test("global patterns target every registering provider", () => {
	const runtime = fakeRuntime();
	installRegistryHook(runtime, stateFor({ providers: {}, global: ["*-preview"] }));

	runtime.registerProvider("gamma", { models: ["hy4", "hy4-preview"] });
	assert.deepEqual(ids(runtime.getProvider("gamma")!.getModels()), ["hy4"]);
});

test("the hook reads the latest rules and installs only once per runtime", () => {
	const runtime = fakeRuntime();
	const state = stateFor({ providers: { alpha: ["one"] } });
	assert.equal(installRegistryHook(runtime, state), true);
	assert.equal(installRegistryHook(runtime, state), false);

	state.rules = compileRules({ providers: { alpha: ["two"] }, global: [] });
	runtime.registerProvider("alpha", { models: ["one", "two"] });
	assert.deepEqual(ids(runtime.getProvider("alpha")!.getModels()), ["one"]);
});
