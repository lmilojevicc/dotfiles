import assert from "node:assert/strict";
import test from "node:test";
import { resolveSources, type PackageLister } from "../manifest.ts";

function lister(installed: Record<string, readonly string[] | undefined>): PackageLister {
	return {
		installedPath: (source) => (installed[source] === undefined ? undefined : `/root/${source}`),
		async extensionPaths(source) {
			const paths = installed[source];
			if (paths === undefined) throw new Error("must not resolve an uninstalled source");
			return paths;
		},
	};
}

test("resolves every declared entry in config order and dedupes paths", async () => {
	const multiple = lister({ "npm:a": ["/pkg/a/one.ts", "/pkg/a/two.ts"], "npm:b": ["/pkg/b/index.js"], "npm:c": ["/pkg/a/one.ts"] });
	assert.deepEqual(await resolveSources(["npm:a", "npm:b", "npm:c"], multiple), {
		entries: [
			{ source: "npm:a", path: "/pkg/a/one.ts" },
			{ source: "npm:a", path: "/pkg/a/two.ts" },
			{ source: "npm:b", path: "/pkg/b/index.js" },
		],
		warnings: [],
	});
});

test("an uninstalled source is never resolved, so the gate cannot install one", async () => {
	const entries = await resolveSources(["npm:missing"], lister({ "npm:missing": undefined }));
	assert.deepEqual(entries.entries, []);
	assert.match(entries.warnings[0], /npm:missing: not installed/);
	assert.match(entries.warnings[0], /never installs/);
});

test("per-source failures and empty manifests warn without losing siblings", async () => {
	const failing: PackageLister = {
		installedPath: () => "/pkg/x",
		async extensionPaths(source) {
			if (source === "npm:throws") throw new Error("boom");
			return [];
		},
	};
	const result = await resolveSources(["npm:throws", "npm:empty", "npm:fine"], {
		installedPath: failing.installedPath,
		async extensionPaths(source) {
			if (source === "npm:fine") return ["/pkg/fine/index.ts"];
			return failing.extensionPaths(source);
		},
	});
	assert.deepEqual(result.entries, [{ source: "npm:fine", path: "/pkg/fine/index.ts" }]);
	assert.equal(result.warnings.length, 2);
	assert.match(result.warnings[0], /npm:throws: boom/);
	assert.match(result.warnings[1], /npm:empty: no extension entrypoint resolved/);
});

test("no sources means no work", async () => {
	assert.deepEqual(await resolveSources([], lister({})), { entries: [], warnings: [] });
});
