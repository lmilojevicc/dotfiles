import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

// Test-host fixtures only; production resolves Pi's public exports through the real loader.
const sdkRoot = process.env.PI_GATE_TEST_SDK ?? "/nix/store/fylxrmnhiffb7f18lmwmwr013r9a1nqy-pi-1.1.0/lib/pi/node_modules/@earendil-works/pi-coding-agent";
const packages = {
	"npm:pi-subagents": process.env.PI_GATE_TEST_SUBAGENTS ?? join(homedir(), ".pi/agent/npm/node_modules/pi-subagents"),
	"npm:pi-interactive-shell": process.env.PI_GATE_TEST_INTERACTIVE_SHELL ?? join(homedir(), ".pi/agent/npm/node_modules/pi-interactive-shell"),
};
const available = Object.values(packages).every((root) => readdirSync(root).length > 0) && readdirSync(sdkRoot).length > 0;
const gateDir = fileURLToPath(new URL("../", import.meta.url));
const gatePath = "extensions/host-gate/loader.ts";
const sdk = await import(pathToFileURL(join(sdkRoot, "dist/index.js")).href);

function listing(root: string, base = root): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		out.push(relative(base, path));
		if (entry.isDirectory()) out.push(...listing(path, base));
	}
	return out.sort();
}

function fixture(t: any) {
	const root = mkdtempSync(join(tmpdir(), "host-gate-"));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(cwd);
	mkdirSync(join(agentDir, "npm/node_modules"), { recursive: true });
	cpSync(gateDir, join(agentDir, "extensions/host-gate"), { recursive: true });
	for (const [source, target] of Object.entries(packages)) symlinkSync(target, join(agentDir, "npm/node_modules", source.replace(/^npm:/, "")), "dir");
	writeFileSync(join(agentDir, "npm/package.json"), '{"private":true}');
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
		packages: Object.keys(packages).map((source) => ({ source, extensions: [] })),
		extensions: [gatePath],
	}));
	const keys = ["PI_CODING_AGENT_DIR", "BB_THREAD_ID", "PI_AGENT_POLICY_BB_PROFILE", "PI_AGENT_POLICY_BB_THREAD_ID"];
	const saved = keys.map((key) => process.env[key]);
	for (const key of keys) delete process.env[key];
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; });
		rmSync(root, { recursive: true, force: true });
	});
	const settingsManager = sdk.SettingsManager.create(cwd, agentDir);
	const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager, noThemes: true, noContextFiles: true });
	return { root, cwd, agentDir, loader, settingsManager };
}

/** Reload with the given host env; the gate captures facts at factory time. */
async function loadAs(loader: any, env: { bb?: boolean; tty?: boolean }) {
	const original = { isTTY: Object.getOwnPropertyDescriptor(process.stdout, "isTTY") };
	if (env.bb) process.env.BB_THREAD_ID = "bb-thread"; else delete process.env.BB_THREAD_ID;
	if (env.tty !== undefined) Object.defineProperty(process.stdout, "isTTY", { value: env.tty, configurable: true });
	const previous = loader.getExtensions?.();
	try {
		if (previous !== undefined) previous.runtime.invalidate();
		await loader.reload();
		return loader.getExtensions();
	} finally {
		if (original.isTTY) Object.defineProperty(process.stdout, "isTTY", original.isTTY); else delete (process.stdout as any).isTTY;
	}
}

const interactiveShellTools = ["interactive_shell"];

test("real SDK loader: the gate loads gated entrypoints only in ordinary Pi, including a TypeScript entrypoint", { skip: !available }, async (t) => {
	const { agentDir, cwd, loader } = fixture(t);
	const before = listing(agentDir);

	const ordinary = await loadAs(loader, { tty: true });
	assert.deepEqual(ordinary.errors, [], JSON.stringify(ordinary.errors));
	const extensions = ordinary.extensions.map((extension: any) => extension.path);
	assert.equal(extensions.filter((path: string) => path.endsWith("host-gate/loader.ts")).length, 1);
	for (const target of Object.values(packages)) {
		assert.equal(extensions.some((path: string) => path.startsWith(target)), false, `settings filter must keep ${target} out of the ambient load`);
	}
	assert.ok(ordinary.extensions.some((extension: any) => extension.tools.has("subagent")), "ordinary Pi gets the native subagent tool");
	for (const tool of interactiveShellTools) assert.ok(ordinary.extensions.some((extension: any) => extension.tools.has(tool)), `ordinary Pi gets ${tool}`);
	assert.ok(ordinary.extensions.some((extension: any) => extension.commands.has("spawn")), "TypeScript entrypoint registered its commands");

	// The gate must not install, reconcile or otherwise write into the agent directory.
	assert.deepEqual(listing(agentDir), before, "loading the gate must not create or move files");

	const bb = await loadAs(loader, { bb: true, tty: false });
	assert.deepEqual(bb.errors, [], JSON.stringify(bb.errors));
	for (const extension of bb.extensions) {
		assert.equal(extension.tools.has("subagent"), false, "BB must not get the subagent tool");
		for (const tool of interactiveShellTools) assert.equal(extension.tools.has(tool), false, `BB must not get ${tool}`);
	}
	assert.equal(bb.extensions.some((extension: any) => extension.commands.has("spawn")), false);

	const neutral = await loadAs(loader, { tty: true });
	assert.ok(neutral.extensions.some((extension: any) => extension.tools.has("subagent")), "a later ordinary runtime loads again");
});

test("real SDK loader: gated entrypoints match direct discovery tool, command and hook surfaces", { skip: !available }, async (t) => {
	const { agentDir, cwd, loader } = fixture(t);
	const gated = await loadAs(loader, { tty: true });
	const direct = await sdk.discoverAndLoadExtensions([
		join(packages["npm:pi-subagents"], "index.js"),
		join(packages["npm:pi-interactive-shell"], "index.ts"),
	], cwd, agentDir);
	try {
		assert.deepEqual(direct.errors, [], JSON.stringify(direct.errors));
		const surface = (result: any) => ({
			tools: [...new Set(result.extensions.flatMap((extension: any) => [...extension.tools.keys()]))].sort(),
			commands: [...new Set(result.extensions.flatMap((extension: any) => [...extension.commands.keys()]))].sort(),
			hooks: [...new Set(result.extensions.flatMap((extension: any) => [...extension.handlers.keys()]))].sort(),
		});
		const gatedSurface = surface(gated);
		const directSurface = surface(direct);
		assert.deepEqual(gatedSurface.tools, directSurface.tools);
		assert.deepEqual(gatedSurface.commands, directSurface.commands);
		assert.deepEqual(gatedSurface.hooks, directSurface.hooks);
		assert.ok(gatedSurface.tools.includes("subagent"));
		assert.ok(gatedSurface.tools.includes("interactive_shell"));
	} finally {
		direct.runtime.invalidate();
	}
});

test("real SDK loader: a missing gated package warns through the UI and still loads the rest", { skip: !available }, async (t) => {
	const { agentDir, cwd, loader, settingsManager } = fixture(t);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
		packages: [{ source: "npm:pi-interactive-shell", extensions: [] }],
		extensions: [gatePath],
	}));
	// A gate entry that settings does not configure is never installed by Pi either: the gate
	// only warns, so this proves the gate itself attempts no install.
	writeFileSync(join(agentDir, "extensions/host-gate/host-gate.json"), JSON.stringify({ packages: { "npm:pi-interactive-shell": { require: ["pi"] }, "npm:not-installed-package": { require: ["pi"] } } }));
	const notifications: string[] = [];
	const loaded = await loadAs(loader, { tty: true });
	assert.deepEqual(loaded.errors, [], JSON.stringify(loaded.errors));
	assert.ok(loaded.extensions.some((extension: any) => extension.tools.has("interactive_shell")), "installed sibling still loads");
	const gate = loaded.extensions.find((extension: any) => extension.path.endsWith("host-gate/loader.ts"));
	const ctx = { hasUI: true, ui: { notify(message: string) { notifications.push(message); }, setWidget() {}, setStatus() {}, setTitle() {} } };
	// Gated packages share the host API, so their handlers are attributed to the gate record too;
	// only this gate's warnings are asserted here.
	for (const handler of gate.handlers.get("session_start") ?? []) {
		try { await handler({ type: "session_start", reason: "startup" }, ctx); } catch {}
	}
	assert.equal(notifications.filter((message) => /not-installed-package/.test(message)).length, 1, JSON.stringify(notifications));
	assert.match(notifications.join("\n"), /never installs/);
});
