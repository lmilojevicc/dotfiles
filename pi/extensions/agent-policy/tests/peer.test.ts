import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { loadRequiredChildAPI, resolveRequiredChildAPI } from "../peer.ts";

function fixture(t: any) {
	const root = mkdtempSync(join(tmpdir(), "agent-policy-peer-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const url = pathToFileURL(join(root, "extension", "index.ts")).href;
	const agentDir = join(root, "agent");
	function pkg(anchor: string, source = "export function registerRequiredChildExtensions() { return { dispose() {} }; }") {
		const directory = join(anchor, "node_modules", "pi-subagents");
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "pi-subagents", type: "module", exports: { "./required-child-extensions": "./api.js" } }));
		writeFileSync(join(directory, "api.js"), source);
		return join(directory, "api.js");
	}
	return { root, url, agentDir, pkg };
}

test("resolves standard peer before the Pi-managed npm anchor", (t) => {
	const f = fixture(t);
	const managed = f.pkg(join(f.agentDir, "npm"));
	assert.equal(resolveRequiredChildAPI(f.url, f.agentDir), realpathSync(managed));
	const local = f.pkg(join(f.root, "extension"));
	assert.equal(resolveRequiredChildAPI(f.url, f.agentDir), realpathSync(local));
});

test("loads only the exported public function, not a private registry", async (t) => {
	const f = fixture(t);
	f.pkg(join(f.agentDir, "npm"));
	const register = await loadRequiredChildAPI(f.url, f.agentDir);
	assert.equal(typeof register, "function");
	assert.equal(typeof register({ sessionId: "test", extensions: [] }).dispose, "function");
});

test("missing peer or malformed public API fails honestly without installing", async (t) => {
	const f = fixture(t);
	assert.throws(() => resolveRequiredChildAPI(f.url, f.agentDir), /provision a compatible peer/);
	f.pkg(join(f.agentDir, "npm"), "export const unrelated = true;");
	await assert.rejects(loadRequiredChildAPI(f.url, f.agentDir), /lacks registerRequiredChildExtensions/);
});

test("an incompatible local export is not silently replaced by a managed peer", (t) => {
	const f = fixture(t);
	f.pkg(join(f.agentDir, "npm"));
	f.pkg(join(f.root, "extension"));
	writeFileSync(join(f.root, "extension", "node_modules", "pi-subagents", "package.json"), JSON.stringify({ type: "module", exports: {} }));
	assert.throws(() => resolveRequiredChildAPI(f.url, f.agentDir), /not defined by "exports"/);
});
