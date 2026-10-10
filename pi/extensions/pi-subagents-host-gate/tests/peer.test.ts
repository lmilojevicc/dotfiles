import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { resolveSubagents } from "../peer.ts";

function fixture(t: any) {
	const root = mkdtempSync(join(tmpdir(), "pi-host-gate-peer-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}
function peer(root: string, manifest: any = { exports: { ".": "./public.js" } }) {
	const dir = join(root, "node_modules/pi-subagents");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "pi-subagents", ...manifest }));
	writeFileSync(join(dir, "public.js"), "export default function() {}\n");
	return realpathSync(join(dir, "public.js"));
}

test("normal peer public export wins over managed npm anchor", (t) => {
	const root = fixture(t);
	const local = peer(join(root, "extension"));
	peer(join(root, "agent/npm"));
	assert.equal(resolveSubagents(pathToFileURL(join(root, "extension/loader.ts")).href, join(root, "agent")), local);
});
test("managed npm anchor is used when local peer is absent", (t) => {
	const root = fixture(t);
	const managed = peer(join(root, "agent/npm"));
	assert.equal(resolveSubagents(pathToFileURL(join(root, "extension/loader.ts")).href, join(root, "agent")), managed);
});
test("missing public peer is explicit with original resolution cause", (t) => {
	const root = fixture(t);
	assert.throws(() => resolveSubagents(pathToFileURL(join(root, "extension/loader.ts")).href, join(root, "agent")), (error: any) => {
		assert.match(error.message, /cannot resolve pi-subagents public export.*no automatic install/);
		assert.equal(error.cause.code, "MODULE_NOT_FOUND");
		return true;
	});
});
for (const [target, manifest] of [
	["export", { exports: { ".": "./missing.js" } }],
	["main", { main: "./missing.js" }],
] as const) {
	test(`missing local ${target} target preserves original error instead of falling back to managed version`, (t) => {
		const root = fixture(t);
		peer(join(root, "extension"), manifest);
		peer(join(root, "agent/npm"));
		const extensionURL = pathToFileURL(join(root, "extension/loader.ts")).href;
		let original: any;
		try { createRequire(extensionURL).resolve("pi-subagents"); } catch (error) { original = error; }
		assert.equal(original?.code, "MODULE_NOT_FOUND", "fixture has a present peer with a broken entry");
		assert.throws(() => resolveSubagents(extensionURL, join(root, "agent")), (error: any) => {
			assert.equal(error.code, original.code);
			assert.equal(error.message, original.message);
			assert.equal(error.path, original.path);
			assert.equal(error.requestPath, original.requestPath);
			assert.equal(error.cause, undefined, "original local error is not wrapped as managed resolution failure");
			return true;
		});
	});
}

test("broken local public exports do not silently fall back to managed version", (t) => {
	const root = fixture(t);
	peer(join(root, "extension"), { exports: { "./private": "./public.js" } });
	peer(join(root, "agent/npm"));
	assert.throws(() => resolveSubagents(pathToFileURL(join(root, "extension/loader.ts")).href, join(root, "agent")), (error: any) => error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED");
});
