import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const gatePath = "extensions/host-gate/loader.ts";
const settings = JSON.parse(readFileSync(new URL("../../../settings.json", import.meta.url), "utf8"));
const config = JSON.parse(readFileSync(new URL("../host-gate.json", import.meta.url), "utf8"));

test("configured settings select exactly one gate loader", () => {
	assert.equal(settings.extensions.filter((path: string) => path === gatePath).length, 1);
	assert.equal(settings.extensions.some((path: string) => path.includes("pi-subagents-host-gate")), false, "the superseded gate is no longer wired");
});

test("gated packages keep skills and prompts while their extension resource is filtered", () => {
	for (const source of ["npm:pi-subagents", "npm:pi-interactive-shell"]) {
		const entries = settings.packages.filter((entry: any) => entry === source || entry.source === source);
		assert.deepEqual(entries, [{ source, extensions: [] }], source);
	}
});

test("the gate config lists exactly the packages the settings filter, unpinned and Pi-only", () => {
	assert.deepEqual(config, { packages: { "npm:pi-subagents": { require: ["pi"] }, "npm:pi-interactive-shell": { require: ["pi"] } } });
	for (const source of Object.keys(config.packages)) {
		assert.equal(source.includes("@"), false, `${source} must stay unpinned`);
		assert.deepEqual(settings.packages.filter((entry: any) => entry === source || entry.source === source).length, 1, source);
	}
});

test("gate cannot be ambiently discovered before explicit atomic settings update", () => {
	for (const file of ["index.ts", "index.js", "package.json"]) {
		assert.equal(existsSync(new URL(`../${file}`, import.meta.url)), false, file);
	}
	assert.equal(existsSync(new URL("../loader.ts", import.meta.url)), true);
});
