import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentSession, SettingsManager } from "@earendil-works/pi-coding-agent";
import { switchAndSave } from "../persistence.ts";
import { model } from "./fixtures.ts";

const selected = model("beta", "shared");
function fixture(t: test.TestContext) {
	const root = mkdtempSync(join(tmpdir(), "model-picker-settings-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const agent = join(root, "agent"), cwd = join(root, "project");
	mkdirSync(agent); mkdirSync(join(cwd, ".pi"), { recursive: true });
	const path = join(agent, "settings.json");
	const ctx = { cwd, isProjectTrusted: () => true };
	return { root, agent, cwd, path, ctx };
}

test("success saves paired global default, preserves unrelated settings and legacy bytes", async (t) => {
	const { agent, path, ctx } = fixture(t);
	const initial = { theme: "light", enabledModels: ["alpha/*"], compaction: { enabled: false }, custom: { nested: [1, 2] } };
	writeFileSync(path, JSON.stringify(initial));
	const legacy = join(agent, "model-favorites.json");
	const legacyBytes = Buffer.from("\uFEFF{invalid legacy bytes}\n");
	writeFileSync(legacy, legacyBytes);
	const result = await switchAndSave({ setModel: async (value) => { assert.equal(value, selected); return true; } }, ctx, selected, agent);
	assert.equal(result.status, "saved");
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { ...initial, defaultProvider: "beta", defaultModel: "shared" });
	assert.deepEqual(readFileSync(legacy), legacyBytes);
});

for (const outcome of ["false", "throw"] as const) test(`setModel ${outcome} leaves settings bytes untouched`, async (t) => {
	const { agent, path, ctx } = fixture(t);
	const bytes = '{ "theme": "dark" }\n'; writeFileSync(path, bytes);
	const result = await switchAndSave({ setModel: async () => { if (outcome === "throw") throw Error("switch failed"); return false; } }, ctx, selected, agent);
	assert.equal(result.status, outcome === "throw" ? "switch-failed" : "not-switched");
	assert.equal(readFileSync(path, "utf8"), bytes);
});

for (const bytes of ['{broken', '[]', '[{"theme":"dark"}]', 'null', '"string"', '2', 'true', ' ']) {
	test(`invalid global root ${JSON.stringify(bytes)} is never overwritten or switched`, async (t) => {
		const { agent, path, ctx } = fixture(t);
		writeFileSync(path, bytes); let calls = 0;
		const result = await switchAndSave({ setModel: async () => { calls++; return true; } }, ctx, selected, agent);
		assert.equal(result.status, "not-switched");
		assert.equal(calls, 0);
		assert.equal(readFileSync(path, "utf8"), bytes);
	});
}

for (const bytes of [undefined, "", '\uFEFF{"theme":"dark"}']) test(`native missing/empty/BOM settings semantics: ${JSON.stringify(bytes)}`, async (t) => {
	const { agent, path, ctx } = fixture(t);
	if (bytes !== undefined) writeFileSync(path, bytes);
	assert.equal((await switchAndSave({ setModel: async () => true }, ctx, selected, agent)).status, "saved");
	assert.equal(JSON.parse(readFileSync(path, "utf8")).defaultProvider, "beta");
});

test("fresh manager preserves valid concurrent edits including native manager writes", async (t) => {
	const { agent, path, ctx } = fixture(t);
	writeFileSync(path, '{"theme":"dark"}');
	const result = await switchAndSave({ setModel: async () => {
		const other = SettingsManager.create(ctx.cwd, agent, { projectTrusted: false });
		other.setTheme("light"); await other.flush(); assert.deepEqual(other.drainErrors(), []);
		return true;
	} }, ctx, selected, agent);
	assert.equal(result.status, "saved");
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { theme: "light", defaultProvider: "beta", defaultModel: "shared" });
});

for (const bytes of ['{bad', '[]', 'null']) test(`invalid edit during model switch is preserved: ${bytes}`, async (t) => {
	const { agent, path, ctx } = fixture(t);
	writeFileSync(path, '{}');
	const result = await switchAndSave({ setModel: async () => { writeFileSync(path, bytes); return true; } }, ctx, selected, agent);
	assert.equal(result.status, "switched-not-saved");
	assert.equal(readFileSync(path, "utf8"), bytes);
});

test("native flush records write failures without rejecting; extension drains and exposes them", async (t) => {
	const { agent, path, ctx } = fixture(t);
	writeFileSync(path, '{}');
	const result = await switchAndSave({ setModel: async () => {
		// Read validation succeeds, but native queued write cannot acquire its lock.
		mkdirSync(`${path}.lock`);
		return true;
	} }, ctx, selected, agent);
	assert.equal(result.status, "switched-not-saved");
	assert.match(result.status === "switched-not-saved" ? result.error : "", /lock/i);
	assert.equal(readFileSync(path, "utf8"), '{}');
});

test("load errors from native manager stop switch rather than silently suppressing save", async (t) => {
	const { agent, path, ctx } = fixture(t);
	writeFileSync(path, '{}'); mkdirSync(`${path}.lock`);
	let switched = false;
	const result = await switchAndSave({ setModel: async () => { switched = true; return true; } }, ctx, selected, agent);
	assert.equal(result.status, "not-switched");
	assert.equal(switched, false);
	assert.equal(readFileSync(path, "utf8"), '{}');
});

test("trusted project override remains untouched; untrusted malformed project is ignored", async (t) => {
	const { agent, path, ctx, cwd } = fixture(t);
	const project = join(cwd, ".pi/settings.json");
	const bytes = '{"defaultProvider":"project","defaultModel":"override"}';
	writeFileSync(project, bytes);
	assert.equal((await switchAndSave({ setModel: async () => true }, ctx, selected, agent)).status, "saved");
	assert.equal(readFileSync(project, "utf8"), bytes);
	const manager = SettingsManager.create(cwd, agent);
	assert.equal(manager.getDefaultModel(), "override");
	assert.equal(manager.getGlobalSettings().defaultModel, "shared");
	writeFileSync(project, "{bad");
	assert.equal((await switchAndSave({ setModel: async () => true }, { ...ctx, isProjectTrusted: () => false }, selected, agent)).status, "saved");
	assert.equal(readFileSync(project, "utf8"), "{bad");
	assert.ok(existsSync(path));
});

test("native locked write preserves invalid JSON introduced after preflight validation", async (t) => {
	const { agent, path, ctx } = fixture(t);
	writeFileSync(path, '{}');
	const raced = new Proxy(selected, {
		get(target, property, receiver) {
			if (property === "provider") queueMicrotask(() => writeFileSync(path, '{invalid during queued write'));
			return Reflect.get(target, property, receiver);
		},
	});
	const result = await switchAndSave({ setModel: async () => true }, ctx, raced, agent);
	assert.equal(result.status, "switched-not-saved");
	assert.equal(readFileSync(path, "utf8"), '{invalid during queued write');
});

test("native locked merge preserves valid settings edited after preflight validation", async (t) => {
	const { agent, path, ctx } = fixture(t);
	writeFileSync(path, '{"theme":"dark"}');
	const raced = new Proxy(selected, {
		get(target, property, receiver) {
			if (property === "provider") queueMicrotask(() => writeFileSync(path, '{"theme":"light","other":[1]}'));
			return Reflect.get(target, property, receiver);
		},
	});
	const result = await switchAndSave({ setModel: async () => true }, ctx, raced, agent);
	assert.equal(result.status, "saved");
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { theme: "light", other: [1], defaultProvider: "beta", defaultModel: "shared" });
});

test("actual AgentSession mutation then transcript failure reports uncertain switch and never saves", async (t) => {
	const { agent, path, ctx } = fixture(t);
	const bytes = '{"defaultProvider":"old","defaultModel":"old"}\n';
	writeFileSync(path, bytes);
	const old = model("old", "old");
	const host = {
		model: old, agent: { state: { model: old } },
		_modelRuntime: { checkAuth: async () => true },
		_getThinkingLevelForModelSwitch: () => "off",
		sessionManager: { appendModelChange() { throw Error("transcript write failed"); } },
	};
	const result = await switchAndSave({ setModel: async (value) => {
		await AgentSession.prototype.setModel.call(host as never, value);
		return true;
	} }, ctx, selected, agent);
	assert.equal(host.agent.state.model, selected);
	assert.deepEqual(result, { status: "switch-failed", error: "transcript write failed" });
	assert.equal(readFileSync(path, "utf8"), bytes);
});
