import assert from "node:assert/strict";
import test from "node:test";
import { catalogue, modelKey, providerCounts, searchModels, searchTier } from "../domain.ts";
import { model } from "./fixtures.ts";

const models = [model("alpha", "gpt-5", "Fast Thinker"), model("beta", "gpt-5", "Deep Thinker"), model("gamma", "gpt-5-mini")];
test("search matches provider, qualified identity, name, ID and fuzzy tokens", () => {
	assert.equal(searchModels(models, "alpha")[0], models[0]);
	assert.equal(searchModels(models, "beta/gpt-5")[0], models[1]);
	assert.equal(searchModels(models, "deep thinker")[0], models[1]);
	assert.equal(searchModels(models, "gpt5")[0]?.id, "gpt-5");
	assert.equal(searchModels(models, "dpthnkr")[0], models[1]);
	assert.equal(searchModels(models, "beta thinker")[0], models[1]);
});

test("exact then substring then fuzzy tiers outrank catalogue ordering", () => {
	const entries = [model("p", "s-o-n-n-e-t"), model("p", "my-sonnet-long"), model("p", "sonnet")];
	assert.equal(searchTier(model("p", "soon-net"), "sonnet"), 2);
	assert.equal(searchTier(entries[1], "sonnet"), 1);
	assert.equal(searchTier(entries[2], "sonnet"), 0);
	const ranked = searchModels([model("p", "soon-net"), entries[1], entries[2]], "sonnet");
	assert.deepEqual(ranked.map((entry) => entry.id), ["sonnet", "my-sonnet-long", "soon-net"]);
});

test("counts retain every available provider with live zero matches", () => {
	assert.deepEqual([...providerCounts(models, searchModels(models, "deep"))], [["alpha", 0], ["beta", 1], ["gamma", 0]]);
	assert.deepEqual([...providerCounts([], [])], []);
	assert.equal(searchModels(models, "no-such-model-xyz").length, 0);
});

test("nonempty scoped catalogue avoids registry and retains duplicate IDs by provider", () => {
	const ctx = { scopedModels: models.slice(0, 2).map((model) => ({ model })), modelRegistry: { getAvailable: () => { throw Error("scope leaked"); } } };
	assert.deepEqual(catalogue(ctx as never), models.slice(0, 2));
	assert.notEqual(modelKey(models[0]), modelKey(models[1]));
	assert.notEqual(modelKey(model("a/b", "c")), modelKey(model("a", "b/c")));
});

test("empty scope uses cached available registry and deduplicates only qualified identity", () => {
	let reads = 0;
	assert.deepEqual(catalogue({ scopedModels: [], modelRegistry: { getAvailable: () => { reads++; return [...models, models[0]]; } } } as never), models);
	assert.equal(reads, 1);
});
