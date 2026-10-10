import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const gatePath = "extensions/pi-subagents-host-gate/loader.ts";
const settings = JSON.parse(readFileSync(new URL("../../../settings.json", import.meta.url), "utf8"));
// Assert the gate's resource contract, not unrelated user-editable model/preferences.
// The integration transaction separately compares all other settings with its before snapshot.
test("configured settings select the sole gate loader and filter only native extension loading", () => {
	assert.equal(settings.extensions.filter((path: string) => path === gatePath).length, 1);
	const native = settings.packages.filter((entry: any) => entry === "npm:pi-subagents" || entry.source === "npm:pi-subagents");
	assert.deepEqual(native, [{ source: "npm:pi-subagents", extensions: [] }], "skills/prompts filters stay omitted");
});

test("gate cannot be ambiently discovered before explicit atomic settings update", () => {
	for (const file of ["index.ts", "index.js", "package.json"]) {
		assert.equal(existsSync(new URL(`../${file}`, import.meta.url)), false, file);
	}
	assert.equal(existsSync(new URL("../loader.ts", import.meta.url)), true);
});

test("installed public upstream entry retains its own HERDR/child guards and version check", () => {
	// Observation only, not a production import or a replacement for upstream logic.
	const entry = readFileSync(join(process.env.PI_GATE_TEST_SUBAGENTS ?? join(homedir(), ".pi/agent/npm/node_modules/pi-subagents"), "index.js"), "utf8");
	assert.match(entry, /process\.env\[HERDR_PI_MODE_ENV\] === "1"/);
	assert.match(entry, /process\.env\.PI_SUBAGENT_CHILD === "1"\s*\? undefined/);
	assert.match(entry, /installedVersion !== loadedPackageVersion/);
	assert.match(entry, /registerExtension\?\.\(pi\)/);
	const loader = readFileSync(new URL("../loader.ts", import.meta.url), "utf8");
	assert.doesNotMatch(loader, /PI_SUBAGENT_CHILD|HERDR_PI_MODE|\/src\/|\/dist\//);
});
