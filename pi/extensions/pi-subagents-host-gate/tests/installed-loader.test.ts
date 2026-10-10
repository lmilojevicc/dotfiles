import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const sdkRoot = process.env.PI_GATE_TEST_SDK ?? "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
const nativeRoot = process.env.PI_GATE_TEST_SUBAGENTS ?? join(homedir(), ".pi/agent/npm/node_modules/pi-subagents");
const gateDir = fileURLToPath(new URL("../", import.meta.url));
const sourceSettings = JSON.parse(readFileSync(new URL("../../../settings.json", import.meta.url), "utf8"));
const gatePath = "extensions/pi-subagents-host-gate/loader.ts";
const packageEntry = sourceSettings.packages.find((entry: any) => entry.source === "npm:pi-subagents");

// Import the SDK's declared public root export; no private loader or alias recreation.
const sdkManifest = JSON.parse(readFileSync(join(sdkRoot, "package.json"), "utf8"));
const sdk = await import(pathToFileURL(join(sdkRoot, sdkManifest.exports["."].import)).href);

function fixture(t: any, installed = true) {
	const root = mkdtempSync(join(tmpdir(), "pi-subagents-host-gate-"));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(cwd);
	mkdirSync(join(agentDir, "npm/node_modules"), { recursive: true });
	cpSync(gateDir, join(agentDir, "extensions/pi-subagents-host-gate"), { recursive: true });
	if (installed) symlinkSync(nativeRoot, join(agentDir, "npm/node_modules/pi-subagents"), "dir");
	writeFileSync(join(agentDir, "npm/package.json"), '{"private":true}');
	writeFileSync(join(agentDir, "APPEND_SYSTEM.md"), "Isolated native APPEND fixture.\n");
	writeFileSync(join(agentDir, "extensions/unrelated.ts"), 'export default function(pi) { pi.registerCommand("unrelated", { handler: async () => {} }); pi.on("before_agent_start", () => {}); }');
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: installed ? [packageEntry] : [], extensions: [gatePath] }));
	const keys = ["PI_CODING_AGENT_DIR", "BB_THREAD_ID", "PI_AGENT_POLICY_BB_PROFILE", "PI_AGENT_POLICY_BB_THREAD_ID", "PI_SUBAGENT_CHILD", "HERDR_PI_MODE"];
	const saved = keys.map((key) => process.env[key]);
	for (const key of keys) delete process.env[key];
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; });
		rmSync(root, { recursive: true, force: true });
	});
	const settingsManager = sdk.SettingsManager.create(cwd, agentDir);
	const bus = sdk.createEventBus();
	const subscriptions: string[] = [];
	let activeSubscriptions = 0;
	const eventBus = { ...bus, on(name: string, handler: any) {
		subscriptions.push(name);
		activeSubscriptions++;
		const unsubscribe = bus.on(name, handler);
		return () => { activeSubscriptions--; unsubscribe(); };
	} };
	const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager, eventBus, noThemes: true, noContextFiles: true });
	return { root, cwd, agentDir, settingsManager, loader, subscriptions, activeSubscriptions: () => activeSubscriptions };
}

function registrations(loader: any) {
	const result = loader.getExtensions();
	assert.deepEqual(result.errors, [], JSON.stringify(result.errors));
	assert.equal(result.extensions.filter((ext: any) => ext.path.endsWith("pi-subagents-host-gate/loader.ts")).length, 1);
	assert.equal(result.extensions.some((ext: any) => ext.path.startsWith(nativeRoot)), false);
	const gate = result.extensions.find((ext: any) => ext.path.endsWith("pi-subagents-host-gate/loader.ts"));
	assert.ok(result.extensions.some((ext: any) => ext.commands.has("unrelated")));
	return gate;
}

// Stop at factory registrations, never emit session_start or invoke tools/model requests.
test("real SDK public loader maps managed upstream peers and recreates host routing on reload", async (t) => {
	assert.equal(sdkManifest.version, "1.0.4");
	assert.equal(JSON.parse(readFileSync(join(nativeRoot, "package.json"), "utf8")).version, "0.76.1");
	const { cwd, agentDir, loader, subscriptions, activeSubscriptions } = fixture(t);
	await loader.reload();
	const ordinary = registrations(loader);
	assert.ok(ordinary.tools.has("subagent"));
	assert.ok(ordinary.commands.size > 0);
	assert.ok(ordinary.handlers.size > 0);
	const commands = [...ordinary.commands.keys()];
	assert.ok(subscriptions.length > 0, "native control/event listeners are registered");
	const direct = await sdk.discoverAndLoadExtensions([join(nativeRoot, "index.js")], cwd, agentDir);
	assert.deepEqual(direct.errors, []);
	const upstream = direct.extensions.find((ext: any) => ext.path === join(nativeRoot, "index.js"));
	assert.deepEqual([...ordinary.tools.keys()], [...upstream.tools.keys()]);
	assert.deepEqual(commands, [...upstream.commands.keys()]);
	assert.deepEqual([...ordinary.handlers].map(([name, handlers]: any) => [name, handlers.length]), [...upstream.handlers].map(([name, handlers]: any) => [name, handlers.length]), "same hooks/counts as direct native public entry");
	direct.runtime.invalidate();
	console.log("ordinary native tools:", [...ordinary.tools.keys()], "commands:", commands, "hooks:", [...ordinary.handlers.keys()]);
	assert.ok(loader.getSkills().skills.length > 0, "bundled skills remain enabled");
	assert.ok(loader.getPrompts().prompts.length > 0, "bundled prompts remain enabled");
	for (const profile of [undefined, "workflow-worker:v1", "none:v1"]) {
		process.env.BB_THREAD_ID = "bb-thread";
		if (profile === undefined) delete process.env.PI_AGENT_POLICY_BB_PROFILE; else process.env.PI_AGENT_POLICY_BB_PROFILE = profile;
		// Session/runtime replacement invalidates the old API before loading the next.
		loader.getExtensions().runtime.invalidate();
		subscriptions.length = 0;
		await loader.reload();
		const bb = registrations(loader);
		assert.deepEqual(subscriptions, [], "no native control/event bus listeners");
		assert.equal(activeSubscriptions(), 0, "old listeners are removed, none are added in BB");
		assert.equal(bb.tools.size, 0);
		assert.equal(bb.commands.size, 0);
		assert.equal(bb.handlers.size, 0);
		assert.equal(bb.flags.size, 0);
		assert.equal(bb.shortcuts.size, 0);
		assert.equal(ordinary.tools.has("subagent"), true, "old runtime routing stays stable");
	}
	delete process.env.BB_THREAD_ID; // Policy markers alone must not suppress native.
	loader.getExtensions().runtime.invalidate();
	await loader.reload();
	const restored = registrations(loader);
	assert.ok(restored.tools.has("subagent"));
	assert.deepEqual([...restored.commands.keys()], commands);
	for (const name of commands) {
		assert.equal(loader.getExtensions().extensions.filter((ext: any) => ext.commands.has(name)).length, 1, name);
	}
	loader.getExtensions().runtime.invalidate();
});

test("BB loads without an installed upstream and discovery alone does not discover loader.ts", async (t) => {
	const { cwd, agentDir, loader, subscriptions } = fixture(t, false);
	process.env.BB_THREAD_ID = "bb-side-chat";
	await loader.reload();
	const gate = registrations(loader);
	assert.equal(gate.tools.size + gate.commands.size + gate.handlers.size, 0);
	assert.deepEqual(subscriptions, []);
	const discovered = await sdk.discoverAndLoadExtensions([], cwd, agentDir);
	assert.deepEqual(discovered.errors, []);
	assert.deepEqual(discovered.extensions.map((ext: any) => ext.path), [join(agentDir, "extensions/unrelated.ts")]);
	loader.getExtensions().runtime.invalidate();
	discovered.runtime.invalidate();
	delete process.env.BB_THREAD_ID;
	await loader.reload();
	assert.equal(loader.getExtensions().errors.length, 1, "ordinary missing peer must fail explicitly");
	assert.match(loader.getExtensions().errors[0].error, /cannot resolve pi-subagents public export/);
});

test("real host skips a broken public module in BB and surfaces its error outside BB", async (t) => {
	const { agentDir, loader } = fixture(t, false);
	const peer = join(agentDir, "npm/node_modules/pi-subagents");
	mkdirSync(peer);
	writeFileSync(join(peer, "package.json"), JSON.stringify({ name: "pi-subagents", type: "module", exports: { ".": "./entry.js" } }));
	writeFileSync(join(peer, "entry.js"), 'throw new Error("broken public upstream module"); export default () => {};');
	process.env.BB_THREAD_ID = "bb-workflow";
	await loader.reload();
	assert.equal(registrations(loader).handlers.size, 0);
	delete process.env.BB_THREAD_ID;
	await loader.reload();
	assert.equal(loader.getExtensions().errors.length, 1);
	assert.match(loader.getExtensions().errors[0].error, /broken public upstream module/);
	writeFileSync(join(peer, "entry.js"), "export default 123;");
	await loader.reload();
	assert.equal(loader.getExtensions().errors.length, 1);
	assert.match(loader.getExtensions().errors[0].error, /public default export is not a factory/);
});
