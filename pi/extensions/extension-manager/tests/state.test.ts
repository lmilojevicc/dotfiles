import assert from "node:assert/strict";
import test from "node:test";
import type { InventoryEntry } from "../discovery.ts";
import {
	baselineScope,
	entryKey,
	isScopeEnabled,
	planSave,
	reconcileOwned,
	toggledScope,
	type EntryScope,
} from "../state.ts";

const pkg = (id: string, installed = true): InventoryEntry => ({ kind: "package", id, label: id, installed });
const local = (id: string, enabled = true): InventoryEntry => ({
	kind: "local",
	id,
	label: id,
	path: `/agent/${id}`,
	enabled,
});

function plan(options: {
	entries: InventoryEntry[];
	scopes: Record<string, EntryScope>;
	packages?: unknown[];
	extensionPaths?: string[];
	config?: { packages?: Record<string, string>; extensions?: Record<string, string> };
	baseline?: Record<string, EntryScope>;
}) {
	const entries = options.entries;
	const baseline = new Map<string, EntryScope>();
	const staged = new Map<string, EntryScope>();
	for (const entry of entries) {
		const key = entryKey(entry);
		baseline.set(key, (options.baseline?.[key] as EntryScope | undefined) ?? "enabled");
		staged.set(key, (options.scopes[key] as EntryScope | undefined) ?? "enabled");
	}
	return planSave({
		packages: (options.packages ?? []) as never,
		extensionPaths: options.extensionPaths ?? [],
		entries,
		staged,
		baseline,
		config: { packages: options.config?.packages ?? {}, extensions: options.config?.extensions ?? {} },
	});
}

test("a tab shows the scope it can narrow, and BB never overrides a global disable", () => {
	assert.equal(isScopeEnabled("enabled", "global"), true);
	assert.equal(isScopeEnabled("enabled", "bb"), true);
	assert.equal(isScopeEnabled("bb", "global"), true);
	assert.equal(isScopeEnabled("bb", "bb"), false);
	assert.equal(isScopeEnabled("global", "global"), false);
	assert.equal(isScopeEnabled("global", "bb"), false);

	assert.equal(toggledScope("enabled", "global"), "global");
	assert.equal(toggledScope("bb", "global"), "global");
	assert.equal(toggledScope("global", "global"), "enabled");

	assert.equal(toggledScope("enabled", "bb"), "bb");
	assert.equal(toggledScope("bb", "bb"), "enabled");
	assert.equal(toggledScope("global", "bb"), undefined, "the BB tab cannot re-enable a global disable");
});

test("disabling a settings package moves its plain string into the tracked config", () => {
	const update = plan({
		entries: [pkg("npm:first"), pkg("npm:second")],
		packages: ["npm:first", "npm:second"],
		scopes: { "package:npm:first": "bb" },
	});
	assert.deepEqual(update.packages, ["npm:second"]);
	assert.deepEqual(update.config.packages, { "npm:first": "bb" });
	assert.equal(update.packagesChanged, true);
	assert.equal(update.extensionPathsChanged, false);
	assert.deepEqual(update.extensionPaths, []);
});

test("enabling a package everywhere appends it again as a plain string", () => {
	const update = plan({
		entries: [pkg("npm:first"), pkg("npm:second")],
		packages: ["npm:second"],
		config: { packages: { "npm:first": "bb" } },
		scopes: { "package:npm:first": "enabled" },
	});
	assert.deepEqual(update.packages, ["npm:second", "npm:first"]);
	assert.deepEqual(update.config.packages, {});
});

test("changing between the global and bb scope only edits the tracked config", () => {
	const entries = [pkg("npm:first")];
	for (const [from, to] of [["bb", "global"], ["global", "bb"]] as const) {
		const update = plan({
			entries,
			packages: [],
			config: { packages: { "npm:first": from } },
			scopes: { "package:npm:first": to },
			baseline: { "package:npm:first": from },
		});
		assert.deepEqual(update.packages, []);
		assert.equal(update.packagesChanged, false);
		assert.equal(update.extensionPathsChanged, false);
		assert.deepEqual(update.config.packages, { "npm:first": to });
	}
});

test("a disabled local extension adds exactly one -path line and re-enabling removes it", () => {
	const entries = [local("extensions/usage/index.ts")];
	const disabled = plan({
		entries,
		extensionPaths: ["extensions/extension-manager/loader.ts", "-builtin:mcp", "-extensions/other/index.ts"],
		scopes: { "local:extensions/usage/index.ts": "bb" },
	});
	assert.deepEqual(disabled.extensionPaths, [
		"extensions/extension-manager/loader.ts",
		"-builtin:mcp",
		"-extensions/other/index.ts",
		"-extensions/usage/index.ts",
	]);
	assert.equal(disabled.config.extensions["extensions/usage/index.ts"], "bb");

	const enabled = plan({
		entries,
		extensionPaths: [
			"extensions/extension-manager/loader.ts",
			"-builtin:mcp",
			"-./extensions/usage/index.ts",
			"-/agent/extensions/usage/index.ts",
			"-extensions/usage/index.ts",
			"+extensions/usage/index.ts",
		],
		config: { extensions: { "extensions/usage/index.ts": "global" } },
		scopes: { "local:extensions/usage/index.ts": "enabled" },
	});
	assert.deepEqual(enabled.extensionPaths, ["extensions/extension-manager/loader.ts", "-builtin:mcp"]);
	assert.deepEqual(enabled.config.extensions, {});
});

test("both local scopes write the same -path line; only the config value differs", () => {
	const entries = [local("extensions/usage/index.ts")];
	const lines = (["global", "bb"] as const).map((scope) => plan({
		entries,
		scopes: { "local:extensions/usage/index.ts": scope },
	}));
	assert.deepEqual(lines[0].extensionPaths, ["-extensions/usage/index.ts"]);
	assert.deepEqual(lines[1].extensionPaths, ["-extensions/usage/index.ts"]);
	assert.deepEqual(lines[0].config.extensions, { "extensions/usage/index.ts": "global" });
	assert.deepEqual(lines[1].config.extensions, { "extensions/usage/index.ts": "bb" });
});

test("untouched package entries keep their filters and are never rewritten as objects", () => {
	const filtered = { source: "npm:filtered", extensions: ["-dist/old.ts"] };
	const update = plan({
		entries: [pkg("npm:filtered"), pkg("npm:plain")],
		packages: [filtered, "npm:plain"],
		scopes: { "package:npm:plain": "bb" },
	});
	assert.deepEqual(update.packages, [filtered]);
	assert.equal(update.packagesChanged, true);

	// Disabling the filtered package drops the whole settings entry, filters included.
	const removed = plan({
		entries: [pkg("npm:filtered"), pkg("npm:plain")],
		packages: [filtered, "npm:plain"],
		scopes: { "package:npm:filtered": "global" },
	});
	assert.deepEqual(removed.packages, ["npm:plain"]);
	assert.deepEqual(removed.config.packages, { "npm:filtered": "global" });

	// Re-enabling it appends a plain string: the manager never writes object-form packages.
	const restored = plan({
		entries: [pkg("npm:filtered"), pkg("npm:plain")],
		packages: ["npm:plain"],
		config: { packages: { "npm:filtered": "global" } },
		scopes: { "package:npm:filtered": "enabled" },
	});
	assert.deepEqual(restored.packages, ["npm:plain", "npm:filtered"]);
});

test("a not-installed owned package stays toggleable and keeps its config value", () => {
	const update = plan({
		entries: [pkg("npm:gone", false)],
		packages: [],
		config: { packages: { "npm:gone": "bb", "npm:unknown": "global" } },
		scopes: { "package:npm:gone": "bb" },
		baseline: { "package:npm:gone": "bb" },
	});
	assert.deepEqual(update.config.packages, { "npm:gone": "bb", "npm:unknown": "global" });
	assert.equal(update.packagesChanged, false);
});

test("a package settings lists again loses its tracked scope", () => {
	const config = { packages: { "npm:reinstalled": "bb" as const, "npm:owned": "global" as const }, extensions: {} };
	const reconciled = reconcileOwned(config, ["npm:reinstalled"]);
	assert.deepEqual(reconciled.stale, ["npm:reinstalled"]);
	assert.deepEqual(reconciled.config.packages, { "npm:owned": "global" });
	assert.deepEqual(config.packages, { "npm:reinstalled": "bb", "npm:owned": "global" }, "the input is not mutated");
	assert.equal(baselineScope(pkg("npm:reinstalled"), reconciled.config), "enabled");

	const clean = reconcileOwned(config, []);
	assert.deepEqual(clean.stale, []);
	assert.equal(clean.config, config, "an already consistent config is returned as is");
});

test("baseline scopes come from settings and the tracked config", () => {
	const config = { packages: { "npm:owned": "bb" as const }, extensions: { "extensions/x/index.ts": "global" as const } };
	assert.equal(baselineScope(pkg("npm:plain"), config), "enabled");
	assert.equal(baselineScope(pkg("npm:owned"), config), "bb");
	assert.equal(baselineScope(local("extensions/on/index.ts"), config), "enabled");
	// A hand-written exclusion without a config entry is off everywhere.
	assert.equal(baselineScope(local("extensions/off/index.ts", false), config), "global");
	assert.equal(baselineScope(local("extensions/x/index.ts", false), config), "global");
	assert.equal(
		baselineScope(local("extensions/y/index.ts", false), { packages: {}, extensions: { "extensions/y/index.ts": "bb" } }),
		"bb",
	);
	// Even a stale config entry cannot leave an enabled extension looking disabled.
	assert.equal(baselineScope(local("extensions/on/index.ts"), config), "enabled");
});
