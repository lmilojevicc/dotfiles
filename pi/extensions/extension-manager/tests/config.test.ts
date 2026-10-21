import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configPath, readManagerConfig, writeManagerConfig } from "../config.ts";

function fixture(t: any) {
	const root = mkdtempSync(join(tmpdir(), "extension-manager-config-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return {
		root,
		path: configPath(root),
		write(value: unknown | string) {
			writeFileSync(this.path, typeof value === "string" ? value : JSON.stringify(value));
		},
	};
}

test("a missing config disables nothing", (t) => {
	const f = fixture(t);
	const snapshot = readManagerConfig(f.root);
	assert.deepEqual(snapshot.packages, {});
	assert.deepEqual(snapshot.extensions, {});
	assert.deepEqual(snapshot.warnings, []);
	assert.equal(snapshot.path, f.path);
});

test("package and local scopes are read as id-to-scope maps", (t) => {
	const f = fixture(t);
	f.write({
		packages: { "npm:b": "bb", "npm:a": "global" },
		extensions: { "extensions/x/index.ts": "bb" },
	});
	assert.deepEqual(readManagerConfig(f.root), {
		packages: { "npm:a": "global", "npm:b": "bb" },
		extensions: { "extensions/x/index.ts": "bb" },
		path: f.path,
		warnings: [],
	});
});

test("a BOM-prefixed config follows settings-style tolerance", (t) => {
	const f = fixture(t);
	f.write("\uFEFF{\"packages\":{\"npm:a\":\"bb\"}}");
	assert.deepEqual(readManagerConfig(f.root).packages, { "npm:a": "bb" });
});

test("missing keys and an empty object are valid", (t) => {
	const f = fixture(t);
	for (const value of [{}, { packages: {} }, { extensions: {} }]) {
		f.write(value);
		const snapshot = readManagerConfig(f.root);
		assert.deepEqual([snapshot.packages, snapshot.extensions, snapshot.warnings], [{}, {}, []]);
	}
});

test("malformed and non-object configs warn and disable nothing", (t) => {
	const f = fixture(t);
	for (const value of ["{bad json", "[]", '"text"', "null", "1"]) {
		f.write(value);
		const snapshot = readManagerConfig(f.root);
		assert.deepEqual([snapshot.packages, snapshot.extensions], [{}, {}]);
		assert.equal(snapshot.warnings.length, 1, value);
		assert.match(snapshot.warnings[0], /extension-manager\.json/);
	}
});

test("unknown keys, bad scopes and blank ids warn while valid siblings still apply", (t) => {
	const f = fixture(t);
	f.write({
		third: {},
		packages: { "npm:good": "bb", " ": "bb", "npm:bad": "bbs", "npm:b": 3 } as never,
		extensions: ["extensions/x/index.ts"],
	});
	const snapshot = readManagerConfig(f.root);
	assert.deepEqual(snapshot.packages, { "npm:good": "bb" });
	assert.deepEqual(snapshot.extensions, {});
	const text = snapshot.warnings.join("\n");
	assert.match(text, /unknown top-level key/);
	assert.match(text, /nonblank ids/);
	assert.match(text, /expected "global" or "bb"/);
	assert.match(text, /mapping ids to global or bb/);
});

test("writes a readable, sorted file atomically and round-trips", (t) => {
	const f = fixture(t);
	writeManagerConfig(f.root, {
		packages: { "npm:z": "bb", "git:github.com/a/b": "global" },
		extensions: { "extensions/x/index.ts": "global" },
	});
	assert.equal(readFileSync(f.path, "utf8"), `${JSON.stringify({
		packages: { "git:github.com/a/b": "global", "npm:z": "bb" },
		extensions: { "extensions/x/index.ts": "global" },
	}, null, 2)}\n`);
	assert.equal(existsSync(`${f.path}.tmp`), false);
	assert.deepEqual(readManagerConfig(f.root).packages, {
		"git:github.com/a/b": "global",
		"npm:z": "bb",
	});
});
