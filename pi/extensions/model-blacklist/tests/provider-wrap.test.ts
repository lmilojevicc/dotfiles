import assert from "node:assert/strict";
import test from "node:test";
import { BLACKLIST_MARKER, unwrapProvider, wrapProvider } from "../provider-wrap.ts";
import { fakeProvider, ids, model } from "./helpers.ts";

test("wrappers remove blocked chat and non-chat models while keeping order", () => {
	const base = fakeProvider("test", ["a", "b", "c"], { allModels: [model("image-1", "test", "image")] });
	const wrapper = wrapProvider(base, (model) => model.id === "b");
	assert.deepEqual(ids(wrapper.getModels()), ["a", "c"]);
	assert.deepEqual(ids(wrapper.getAllModels!()), ["a", "c", "image-1"]);
	const imagesOnly = wrapProvider(base, (entry) => entry.id === "image-1");
	assert.deepEqual(ids(imagesOnly.getAllModels!()), ["a", "b", "c"]);

	const dynamic = new Set(["a"]);
	const liveWrapper = wrapProvider(base, (model) => dynamic.has(model.id));
	assert.deepEqual(ids(liveWrapper.getModels()), ["b", "c"]);
	dynamic.add("c");
	assert.deepEqual(ids(liveWrapper.getModels()), ["b"]);
});

test("availability filters chain the base policy and keep non-chat filtering", () => {
	const base = fakeProvider("test", ["keep", "base-filtered", "ours"], {
		filter: (id) => id !== "base-filtered",
	});
	const wrapper = wrapProvider(base, (model) => model.id === "ours");
	const all = base.getModels();
	assert.deepEqual(ids(wrapper.filterModels!(all, undefined)), ["keep"]);

	const withBaseAllFilter = fakeProvider("test", ["keep", "base-filtered", "ours"], {
		filterAll: (id) => id !== "base-filtered",
	});
	const wrappedAll = wrapProvider(withBaseAllFilter, (model) => model.id === "ours");
	assert.deepEqual(ids(wrappedAll.filterAllModels!(all, undefined)), ["keep"]);

	const noBaseFilter = fakeProvider("test", ["keep", "ours"], {});
	const wrappedNoBase = wrapProvider(noBaseFilter, (model) => model.id === "ours");
	assert.deepEqual(ids(wrappedNoBase.filterModels!(all, undefined)), ["keep", "base-filtered"]);
	assert.deepEqual(ids(wrappedNoBase.filterAllModels!(all, undefined)), ["keep", "base-filtered"]);
});

test("delegation keeps provider identity, auth, streaming, and discovery", () => {
	const base = fakeProvider("test", ["a"]);
	const wrapper = wrapProvider(base, () => false);
	assert.equal(wrapper.id, base.id);
	assert.equal(wrapper.name, base.name);
	assert.equal(wrapper.auth, base.auth);
	assert.equal(wrapper.streamSimple, base.streamSimple);
	assert.equal(wrapper.refreshModels, base.refreshModels);
	assert.deepEqual(ids(wrapper.getModels()), ["a"]);
});

test("getAllModels is only overridden when the base provides it", () => {
	const base = fakeProvider("test", ["a"], { withGetAllModels: false });
	const wrapper = wrapProvider(base, () => false);
	assert.equal(wrapper.getAllModels, undefined);
	const withAll = wrapProvider(fakeProvider("test", ["a"]), () => false);
	assert.ok(withAll.getAllModels);
});

test("unwrap returns the original provider and the marker stays non-enumerable", () => {
	const base = fakeProvider("test", ["a"]);
	const wrapper = wrapProvider(base, () => false);
	assert.equal(unwrapProvider(wrapper), base);
	assert.equal(unwrapProvider(base), base);
	assert.equal(Object.prototype.propertyIsEnumerable.call(wrapper, BLACKLIST_MARKER), false);
	assert.deepEqual(Object.getOwnPropertySymbols(wrapper), [BLACKLIST_MARKER]);

	const spread = { ...wrapper };
	assert.equal(unwrapProvider(spread), spread);
	assert.deepEqual(ids(spread.getModels()), ["a"]);
});

test("wrapping an unwrapped provider is idempotent instead of nested", () => {
	const base = fakeProvider("test", ["a", "b"]);
	const once = wrapProvider(base, (model) => model.id === "b");
	const twice = wrapProvider(unwrapProvider(once), (model) => model.id === "b");
	assert.equal(unwrapProvider(twice), base);
	assert.deepEqual(ids(twice.getModels()), ["a"]);
});
