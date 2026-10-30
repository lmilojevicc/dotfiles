import assert from "node:assert/strict";
import test from "node:test";
import { unwrapProvider } from "../provider-wrap.ts";
import { compileRules } from "../rules.ts";
import { installStoreHook, storedProviderIds } from "../store-hook.ts";
import { fakeProvider, fakeRuntime, ids, runtimeWithoutStore, stateFor } from "./helpers.ts";

test("providers already stored are filtered in place, without setProvider", () => {
	const alpha = fakeProvider("alpha", ["keep", "drop"]);
	const runtime = fakeRuntime([alpha]);
	const state = stateFor(compileRules({ providers: { alpha: ["drop"] }, global: [] }));

	assert.equal(installStoreHook(runtime, state), "installed");

	assert.deepEqual(runtime.setProviderCalls, []);
	const wrapped = runtime.providers.get("alpha")!;
	assert.equal(unwrapProvider(wrapped), alpha);
	assert.deepEqual(ids(wrapped.getModels()), ["keep"]);
	assert.deepEqual(ids(wrapped.getAllModels!()), ["keep"]);
});

test("a provider composed after installation is filtered on the way in", () => {
	const runtime = fakeRuntime();
	installStoreHook(runtime, stateFor(compileRules({ providers: { beta: ["drop"] }, global: [] })));

	const beta = fakeProvider("beta", ["keep", "drop"]);
	runtime.models!.setProvider!(beta);

	assert.deepEqual(runtime.setProviderCalls, ["beta"]);
	const stored = runtime.providers.get("beta")!;
	assert.equal(unwrapProvider(stored), beta);
	assert.deepEqual(ids(stored.getModels()), ["keep"]);
});

test("a recomposed provider that re-adds a hidden id is filtered again, not nested", () => {
	const runtime = fakeRuntime();
	const state = stateFor(
		compileRules({ providers: {}, global: ["*claude-{opus,sonnet,haiku}-<5.5*", "*gemini-<3.8*"] }),
	);
	installStoreHook(runtime, state);

	// Pi composes a fresh object from the models.json overlay, which re-adds the model.
	const first = fakeProvider("cliproxyapi", ["claude-opus-4-6-thinking", "claude-opus-5-5"]);
	runtime.models!.setProvider!(first);
	assert.deepEqual(ids(runtime.providers.get("cliproxyapi")!.getModels()), ["claude-opus-5-5"]);

	const second = fakeProvider("cliproxyapi", ["claude-opus-4-6-thinking", "claude-opus-5-5", "gemini-3.1-pro-low"]);
	runtime.models!.setProvider!(second);
	const stored = runtime.providers.get("cliproxyapi")!;
	assert.equal(unwrapProvider(stored), second);
	assert.deepEqual(ids(stored.getModels()), ["claude-opus-5-5"]);

	// Storing an object the hook already wrapped does not stack a second layer.
	runtime.models!.setProvider!(stored);
	assert.equal(unwrapProvider(runtime.providers.get("cliproxyapi")!), second);
	assert.deepEqual(ids(runtime.providers.get("cliproxyapi")!.getModels()), ["claude-opus-5-5"]);
});

test("new and removed rules take effect immediately on the stored wrapper", () => {
	const alpha = fakeProvider("alpha", ["keep", "drop"]);
	const runtime = fakeRuntime([alpha]);
	const state = stateFor(compileRules({ providers: { alpha: ["keep"] }, global: [] }));
	installStoreHook(runtime, state);
	const wrapped = runtime.providers.get("alpha")!;
	assert.deepEqual(ids(wrapped.getModels()), ["drop"]);

	state.rules = compileRules({ providers: { alpha: ["drop"] }, global: [] });
	assert.deepEqual(ids(wrapped.getModels()), ["keep"]);

	state.rules = compileRules({ providers: {}, global: [] });
	assert.deepEqual(ids(wrapped.getModels()), ["keep", "drop"]);
	assert.equal(unwrapProvider(wrapped), alpha);
	assert.equal(runtime.providers.get("alpha"), wrapped);
});

test("an unset rule set hides nothing", () => {
	const alpha = fakeProvider("alpha", ["keep", "drop"]);
	const runtime = fakeRuntime([alpha]);
	const state = stateFor();
	installStoreHook(runtime, state);

	runtime.models!.setProvider!(fakeProvider("beta", ["keep", "drop"]));
	state.rules = compileRules({ providers: { beta: ["drop"] }, global: [] });
	assert.deepEqual(ids(runtime.providers.get("beta")!.getModels()), ["keep"]);

	state.rules = undefined;
	assert.deepEqual(ids(runtime.providers.get("beta")!.getModels()), ["keep", "drop"]);
});

test("the hook installs once per store and keeps reading that store's state", () => {
	const runtime = fakeRuntime([fakeProvider("alpha", ["one", "two"])]);
	const state = stateFor();
	assert.equal(installStoreHook(runtime, state), "installed");
	assert.equal(installStoreHook(runtime, state), "already-installed");

	state.rules = compileRules({ providers: { alpha: ["one"] }, global: [] });
	assert.deepEqual(ids(runtime.providers.get("alpha")!.getModels()), ["two"]);
});

test("a store without Pi's shape is reported unsupported and left alone", () => {
	const runtime = runtimeWithoutStore();
	assert.equal(installStoreHook(runtime, stateFor(compileRules({ providers: {}, global: ["*"] }))), "unsupported");
	assert.equal(runtime.models, undefined);
	assert.equal(storedProviderIds(runtime), undefined);

	const shapeless = { models: { providers: new Map(), setProvider: undefined } } as never;
	assert.equal(installStoreHook(shapeless, stateFor()), "unsupported");
});

test("stored providers are listed in map order", () => {
	const runtime = fakeRuntime([fakeProvider("beta", []), fakeProvider("alpha", [])]);
	assert.deepEqual(storedProviderIds(runtime), ["beta", "alpha"]);
});
