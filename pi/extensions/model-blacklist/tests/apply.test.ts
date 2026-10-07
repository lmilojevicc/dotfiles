import assert from "node:assert/strict";
import test from "node:test";
import type { Provider } from "@earendil-works/pi-ai/compat";
import { applyBlacklist, type ProviderSource } from "../apply.ts";
import { unwrapProvider } from "../provider-wrap.ts";
import { compileRules } from "../rules.ts";
import { fakeProvider } from "./helpers.ts";

function registryOf(providers: Provider[]): { registry: ProviderSource; current: Map<string, Provider> } {
	const current = new Map(providers.map((provider) => [provider.id, provider]));
	return {
		current,
		registry: {
			getProvider: (providerId) => current.get(providerId),
			getAll: () => [...current.values()].flatMap((provider) => [...provider.getModels()]),
		},
	};
}

test("applies only configured providers and reports unknown ones", () => {
	const alpha = fakeProvider("alpha", ["keep", "drop"]);
	const beta = fakeProvider("beta", ["keep", "drop"]);
	const { registry, current } = registryOf([alpha, beta]);
	const registered: Provider[] = [];

	const result = applyBlacklist({
		registry,
		rules: compileRules({ providers: { alpha: ["drop"], missing: ["gone"] }, global: [] }),
		register: (provider) => {
			registered.push(provider);
			current.set(provider.id, provider);
		},
	});

	assert.deepEqual(result, { applied: ["alpha"], restored: [], missing: ["missing"] });
	assert.equal(registered.length, 1);
	assert.equal(unwrapProvider(current.get("alpha")!), alpha);
	assert.deepEqual(current.get("alpha")!.getModels().map((model) => model.id), ["keep"]);
	assert.equal(current.get("beta"), beta);
	assert.deepEqual(current.get("beta")!.getModels().map((model) => model.id), ["keep", "drop"]);
});

test("global patterns target every provider that exposes a model", () => {
	const alpha = fakeProvider("alpha", ["hy4-preview", "hy4"]);
	const beta = fakeProvider("beta", ["mimo-preview"]);
	const { registry, current } = registryOf([alpha, beta]);
	const registered: string[] = [];

	const result = applyBlacklist({
		registry,
		rules: compileRules({ providers: {}, global: ["*-preview"] }),
		register: (provider) => {
			registered.push(provider.id);
			current.set(provider.id, provider);
		},
	});

	assert.deepEqual(registered.sort(), ["alpha", "beta"]);
	assert.deepEqual(result.applied.sort(), ["alpha", "beta"]);
	assert.deepEqual(current.get("alpha")!.getModels().map((model) => model.id), ["hy4"]);
	assert.deepEqual(current.get("beta")!.getModels().map((model) => model.id), []);
});

test("removing a rule restores the original provider without nesting", () => {
	const alpha = fakeProvider("alpha", ["keep", "drop"]);
	const { registry, current } = registryOf([alpha]);
	const register = (provider: Provider) => current.set(provider.id, provider);

	const first = applyBlacklist({
		registry,
		rules: compileRules({ providers: { alpha: ["drop"] }, global: [] }),
		register,
	});
	assert.deepEqual(first.applied, ["alpha"]);
	const wrapped = current.get("alpha")!;
	assert.equal(unwrapProvider(wrapped), alpha);
	assert.deepEqual(wrapped.getModels().map((model) => model.id), ["keep"]);

	const second = applyBlacklist({
		registry,
		rules: compileRules({ providers: { alpha: ["keep"] }, global: [] }),
		previouslyApplied: ["alpha"],
		register,
	});
	assert.deepEqual(second, { applied: ["alpha"], restored: [], missing: [] });
	assert.equal(unwrapProvider(current.get("alpha")!), alpha);
	assert.deepEqual(current.get("alpha")!.getModels().map((model) => model.id), ["drop"]);

	const third = applyBlacklist({
		registry,
		rules: compileRules({ providers: {}, global: [] }),
		previouslyApplied: ["alpha"],
		register,
	});
	assert.deepEqual(third, { applied: [], restored: ["alpha"], missing: [] });
	assert.equal(current.get("alpha"), alpha);
	assert.deepEqual(current.get("alpha")!.getModels().map((model) => model.id), ["keep", "drop"]);
});

test("restore is a no-op for providers another extension re-registered", () => {
	const replacement = fakeProvider("alpha", ["fresh"]);
	const { registry, current } = registryOf([replacement]);
	const register = (provider: Provider) => current.set(provider.id, provider);

	const result = applyBlacklist({
		registry,
		rules: compileRules({ providers: {}, global: [] }),
		previouslyApplied: ["alpha"],
		register,
	});

	assert.deepEqual(result, { applied: [], restored: [], missing: [] });
	assert.equal(current.get("alpha"), replacement);
});
