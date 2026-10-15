import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pinnedSource, readGateConfig } from "../config.ts";

function fixture(t: any) {
	const root = mkdtempSync(join(tmpdir(), "host-gate-config-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return { root, write(value: unknown | string) { writeFileSync(join(root, "host-gate.json"), typeof value === "string" ? value : JSON.stringify(value)); } };
}

test("config snapshot keeps order, accepts optional require, and warns once per bad input", (t) => {
	const f = fixture(t);
	f.write({ packages: {} });
	assert.deepEqual(readGateConfig(f.root), { entries: [], warnings: [] });
	f.write({ packages: { "npm:a": {}, "npm:b": { require: ["pi"] }, "npm:c": { require: ["tui", "headless"] } } });
	const snapshot = readGateConfig(f.root);
	assert.deepEqual(snapshot.entries, [
		{ source: "npm:a" },
		{ source: "npm:b", require: ["pi"] },
		{ source: "npm:c", require: ["tui", "headless"] },
	]);
	assert.deepEqual(snapshot.warnings, []);
});

test("missing, malformed and non-object config warn and produce an empty snapshot", (t) => {
	const f = fixture(t);
	for (const value of ["{bad json", "[]", '"text"', "null", "1"]) {
		f.write(value);
		const snapshot = readGateConfig(f.root);
		assert.deepEqual(snapshot.entries, []);
		assert.equal(snapshot.warnings.length, 1, value);
		assert.match(snapshot.warnings[0], /host-gate\.json/);
	}
	rmSync(join(f.root, "host-gate.json"));
	const snapshot = readGateConfig(f.root);
	assert.deepEqual(snapshot.entries, []);
	assert.match(snapshot.warnings[0], /ENOENT/);
});

test("invalid entries and unknown keys warn while valid siblings load", (t) => {
	const f = fixture(t);
	f.write({
		typo: true,
		packages: {
			"": {},
			"bad\u0000source": {},
			"npm:not-object": [],
			"npm:bad-require": { require: "pi" },
			"npm:blank-condition": { require: [" "] },
			"npm:unknown-condition": { require: ["pi", "Pi"] },
			"npm:pinned": {},
			"npm:extra": { require: ["pi"], announce: true },
			"npm:good": { require: ["bb"] },
		},
	});
	const snapshot = readGateConfig(f.root);
	// Fail-open: a warning about one key does not discard the entry's valid parts.
	assert.deepEqual(snapshot.entries, [
		{ source: "npm:pinned" },
		{ source: "npm:extra", require: ["pi"] },
		{ source: "npm:good", require: ["bb"] },
	]);
	const text = snapshot.warnings.join("\n");
	assert.match(text, /unknown top-level key/);
	assert.match(text, /nonblank package source/);
	assert.match(text, /expected an object with an optional require array/);
	assert.match(text, /expected an array of nonblank conditions/);
	assert.match(text, /unknown host condition "Pi"/);
	assert.match(text, /unknown key/);
	assert.equal(snapshot.warnings.length, 8, text);
});

test("pinned sources are refused because resolution could install or reconcile", (t) => {
	const f = fixture(t);
	assert.equal(pinnedSource("npm:pi-subagents"), false);
	assert.equal(pinnedSource("npm:pi-subagents@0.77.0"), true);
	assert.equal(pinnedSource("npm:@scope/pkg@1"), true);
	assert.equal(pinnedSource("git:github.com/a/b"), false);
	assert.equal(pinnedSource("git:github.com/a/b#v1"), true);
	assert.equal(pinnedSource("./local"), false);
	f.write({ packages: { "npm:pinned@1.2.3": { require: ["pi"] }, "git:github.com/a/b#v1": { require: ["pi"] }, "npm:ok": { require: ["pi"] } } });
	const snapshot = readGateConfig(f.root);
	assert.deepEqual(snapshot.entries, [{ source: "npm:ok", require: ["pi"] }]);
	assert.equal(snapshot.warnings.filter((w) => /version-pinned/.test(w)).length, 2);
});
