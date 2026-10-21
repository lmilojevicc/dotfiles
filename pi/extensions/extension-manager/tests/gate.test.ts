import type { ResolvedPaths } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
	installExtensionGate,
	isBbHost,
	ownedLocalEntries,
	ownedPackageResolver,
	ownedPackageSources,
	type GateOptions,
} from "../gate.ts";

type Handler = (...args: any[]) => any;

function createApi() {
	const tools: string[] = [];
	const handlers = new Map<string, Handler[]>();
	const api = {
		on(event: string, handler: Handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
		registerTool(options: { name: string }) { tools.push(options.name); },
		registerCommand(name: string) { tools.push(`command:${name}`); },
	};
	return { api, tools, handlers };
}

function write(path: string, body: string): string {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, body);
	return path;
}

function extensionModule(path: string, body: string): string {
	return write(path, `export default function (pi) { ${body} }\n`);
}

function fixture(t: any, config?: unknown, options: { nested?: boolean; settings?: unknown } = {}) {
	const root = mkdtempSync(join(tmpdir(), "extension-manager-gate-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	// The real tracked config lives beside the manager inside the extensions directory.
	const configDir = options.nested
		? join(agentDir, "extensions", "extension-manager")
		: join(root, "extension-manager");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	mkdirSync(configDir, { recursive: true });
	write(join(configDir, "index.ts"), "export default function (pi) { pi.registerCommand(\"extensions-manager\"); }\n");
	write(join(configDir, "loader.ts"), "export default function () {}\n");
	if (config !== undefined) {
		writeFileSync(join(configDir, "extension-manager.json"), typeof config === "string" ? config : JSON.stringify(config));
	}
	if (options.settings !== undefined) {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify(options.settings));
	}
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return { root, agentDir, cwd, configDir };
}

function packageFixture(agentDir: string, name: string, manifest: Record<string, unknown> = {}): string {
	const root = join(agentDir, "npm", "node_modules", name);
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "package.json"), JSON.stringify({
		name,
		version: "1.0.0",
		type: "module",
		...manifest,
	}));
	return root;
}

function emptyPaths(): ResolvedPaths {
	return { extensions: [], skills: [], prompts: [], themes: [] };
}

async function install(options: GateOptions) {
	const api = createApi();
	const result = await installExtensionGate(api.api as never, {
		loadFactory: async (path) => (await import(pathToFileURL(path).href)).default,
		...options,
	});
	return { ...api, result };
}

test("BB origin is any nonblank BB_THREAD_ID", () => {
	for (const threadId of [undefined, "", " ", "\t\r\n"]) {
		assert.equal(isBbHost({ BB_THREAD_ID: threadId }), false, JSON.stringify(threadId));
	}
	for (const threadId of ["bb-thread", " bb-thread ", "0", "thr_abc123!", "\u0000"]) {
		assert.equal(isBbHost({ BB_THREAD_ID: threadId }), true, JSON.stringify(threadId));
	}
	assert.equal(isBbHost({}), false);
});

test("only bb-scoped entries are claimed in non-BB hosts", () => {
	const packages = { "npm:off": "global", "npm:bb": "bb" };
	assert.deepEqual(ownedPackageSources(packages, false), ["npm:bb"]);
	assert.deepEqual(ownedPackageSources(packages, true), []);

	const extensions = { "extensions/off/index.ts": "global", "extensions/bb.ts": "bb", "/elsewhere/x.ts": "bb" };
	assert.deepEqual(ownedLocalEntries(extensions, "/agent", false), [
		{ id: "/elsewhere/x.ts", path: "/elsewhere/x.ts" },
		{ id: "extensions/bb.ts", path: "/agent/extensions/bb.ts" },
	]);
	assert.deepEqual(ownedLocalEntries(extensions, "/agent", true), []);
});

test("owned packages load, with their skills and prompts, only where they are enabled", async (t) => {
	const { agentDir, cwd, configDir } = fixture(t, { packages: { "npm:suite": "bb" }, extensions: {} });
	const packageRoot = packageFixture(agentDir, "suite", {
		pi: { extensions: ["./one.js", "./two.js"], skills: ["./skills"], prompts: ["./prompts"] },
	});
	extensionModule(join(packageRoot, "one.js"), "pi.registerTool({ name: \"one\" });");
	extensionModule(join(packageRoot, "two.js"), "pi.registerTool({ name: \"two\" });");
	write(join(packageRoot, "skills", "review", "SKILL.md"), "---\nname: review\ndescription: Review things\n---\nBody\n");
	write(join(packageRoot, "prompts", "summarize.md"), "Summarize.\n");
	const base = { configDir, cwd, agentDir, resolve: ownedPackageResolver({ cwd, agentDir }) };

	const ordinary = await install({ ...base, bb: false });
	assert.deepEqual(ordinary.tools.sort(), ["one", "two"]);
	assert.deepEqual(ordinary.result.loaded, ["npm:suite/one.js", "npm:suite/two.js"]);
	assert.deepEqual(ordinary.result.warnings, []);
	assert.ok(ordinary.result.resources.skillPaths.some((path) => path.startsWith(join(packageRoot, "skills"))));
	assert.deepEqual(ordinary.result.resources.promptPaths, [join(packageRoot, "prompts", "summarize.md")]);
	const discover = ordinary.handlers.get("resources_discover") ?? [];
	assert.equal(discover.length, 1);
	assert.deepEqual(await discover[0]({ type: "resources_discover" }), ordinary.result.resources);

	const bb = await install({ ...base, bb: true });
	assert.deepEqual(bb.tools, []);
	assert.deepEqual(bb.result.loaded, []);
	assert.ok(bb.result.resources.skillPaths.length === 0 && bb.result.resources.promptPaths.length === 0);
	assert.equal(bb.handlers.size, 0, "nothing is advertised or reported in BB");
});

test("a globally disabled package never loads and is never resolved", async (t) => {
	const { agentDir, cwd, configDir } = fixture(t, { packages: { "npm:suite": "global" } });
	const resolved: string[][] = [];
	for (const bb of [false, true]) {
		const loaded = await install({
			configDir, cwd, agentDir, bb,
			installedPath: () => "/installed/suite",
			async resolve(sources) { resolved.push([...sources]); return emptyPaths(); },
		});
		assert.deepEqual(loaded.result.loaded, []);
		assert.deepEqual(loaded.result.warnings, []);
	}
	assert.deepEqual(resolved, [], "a globally disabled package is never resolved");
});

test("a pinned source warns and is not resolved at all", async (t) => {
	const { agentDir, cwd, configDir } = fixture(t, { packages: { "npm:suite@1.2.3": "bb" } });
	const loaded = await install({
		configDir, cwd, agentDir, bb: false,
		installedPath: () => "/installed/suite",
		async resolve() { throw new Error("must not resolve a pinned source"); },
	});
	assert.deepEqual(loaded.result.loaded, []);
	assert.equal(loaded.result.warnings.length, 1);
	assert.match(loaded.result.warnings[0], /version-pinned/);
});

test("a missing install warns, loads nothing and never installs", async (t) => {
	const { agentDir, cwd, configDir } = fixture(t, { packages: { "npm:gone": "bb" } });
	const before = readdirSync(agentDir).sort();
	const loaded = await install({
		configDir, cwd, agentDir, bb: false,
		async resolve() { throw new Error("must not resolve a missing package"); },
	});
	assert.deepEqual(loaded.result.loaded, []);
	assert.match(loaded.result.warnings[0], /not installed/);
	const probe = await install({ configDir, cwd, agentDir, bb: false });
	assert.match(probe.result.warnings[0], /not installed/);
	assert.deepEqual(readdirSync(agentDir).sort(), before, "the loader must never create or move files");
});

test("broken entrypoints warn but siblings still load", async (t) => {
	const { agentDir, cwd, configDir } = fixture(t, { packages: { "npm:suite": "bb" } });
	const packageRoot = packageFixture(agentDir, "suite");
	const broken = extensionModule(join(packageRoot, "broken.js"), "throw new Error(\"factory exploded\");");
	const noFactory = write(join(packageRoot, "no-factory.js"), "export const value = 1;\n");
	const good = extensionModule(join(packageRoot, "good.js"), "pi.registerTool({ name: \"good\" });");
	const loaded = await install({
		configDir, cwd, agentDir, bb: false,
		installedPath: () => packageRoot,
		async resolve() {
			return {
				...emptyPaths(),
				extensions: [broken, noFactory, good].map((path) => ({
					path,
					enabled: true,
					metadata: { source: "npm:suite", scope: "user" as const, origin: "package" as const, baseDir: packageRoot },
				})),
			};
		},
	});
	assert.deepEqual(loaded.tools, ["good"]);
	assert.equal(loaded.result.warnings.length, 2);
	assert.match(loaded.result.warnings[0], /factory exploded/);
	assert.match(loaded.result.warnings[1], /no default-export factory/);
});

test("a resolution failure fails open with a warning", async (t) => {
	const { agentDir, cwd, configDir } = fixture(t, { packages: { "npm:suite": "bb" } });
	const loaded = await install({
		configDir, cwd, agentDir, bb: false,
		installedPath: () => "/installed/suite",
		async resolve() { throw new Error("manifest exploded"); },
	});
	assert.deepEqual(loaded.result.loaded, []);
	assert.match(loaded.result.warnings[0], /manifest exploded/);
	const notices: string[] = [];
	const ctx = { hasUI: true, ui: { notify(message: string) { notices.push(message); } } };
	for (const handler of loaded.handlers.get("session_start") ?? []) await handler({ type: "session_start" }, ctx);
	assert.deepEqual(notices, loaded.result.warnings);
});

test("local entrypoints skipped by settings load in non-BB hosts only", async (t) => {
	const { agentDir, cwd, configDir } = fixture(t, { extensions: { "extensions/bb.ts": "bb", "extensions/off.ts": "global" } });
	extensionModule(join(agentDir, "extensions", "bb.ts"), "pi.registerTool({ name: \"bb-local\" });");
	extensionModule(join(agentDir, "extensions", "off.ts"), "pi.registerTool({ name: \"off-local\" });");
	const base = { configDir, cwd, agentDir, installedPath: () => undefined };

	const ordinary = await install({ ...base, bb: false });
	assert.deepEqual(ordinary.tools, ["bb-local"]);
	assert.deepEqual(ordinary.result.warnings, []);

	const bb = await install({ ...base, bb: true });
	assert.deepEqual(bb.tools, []);
});

test("the manager cannot be disabled through the tracked config", async (t) => {
	const { agentDir, cwd, configDir } = fixture(t, {
		extensions: {
			"extensions/extension-manager/index.ts": "bb",
			"extensions/extension-manager/loader.ts": "bb",
		},
	}, { nested: true });
	// The tracked config lives beside the manager, so its own entrypoints are refused by path.
	const ordinary = await install({ configDir, cwd, agentDir, bb: false });
	assert.deepEqual(ordinary.tools, []);
	assert.equal(ordinary.result.warnings.filter((warning) => /cannot be disabled/.test(warning)).length, 2);

	const bb = await install({ configDir, cwd, agentDir, bb: true });
	assert.deepEqual(bb.tools, []);
	assert.deepEqual(bb.result.warnings, [], "a BB disable of the manager is inert, not a warning");
});

test("unknown config keys and a malformed config warn while the loader stays fail-open", async (t) => {
	const { agentDir, cwd, configDir } = fixture(t, { packages: { "npm:suite": "bb" }, scope: true });
	const loaded = await install({
		configDir, cwd, agentDir, bb: false,
		installedPath: () => undefined,
	});
	assert.ok(loaded.result.warnings.some((warning) => /unknown top-level key/.test(warning)));
	assert.ok(loaded.result.warnings.some((warning) => /not installed/.test(warning)));

	const broken = fixture(t, "{bad json");
	const failed = await install({ configDir: broken.configDir, cwd: broken.cwd, agentDir: broken.agentDir, bb: false });
	assert.deepEqual(failed.result.loaded, []);
	assert.match(failed.result.warnings[0], /extension-manager\.json/);
	assert.equal((failed.handlers.get("session_start") ?? []).length, 1);
});

test("warnings are reported once per runtime, through the UI or stderr", async (t) => {
	const { agentDir, cwd, configDir } = fixture(t, { packages: { "npm:gone": "bb" } });
	const first = await install({ configDir, cwd, agentDir, bb: false });
	const notices: string[] = [];
	const ctx = { hasUI: true, ui: { notify(message: string) { notices.push(message); } } };
	const handlers = first.handlers.get("before_agent_start") ?? [];
	for (const handler of handlers) await handler({}, ctx);
	for (const handler of handlers) await handler({}, ctx);
	assert.equal(notices.length, first.result.warnings.length);

	const second = await install({ configDir, cwd, agentDir, bb: false });
	const logged: string[] = [];
	t.mock.method(console, "error", (message: string) => logged.push(message));
	for (const handler of second.handlers.get("before_agent_start") ?? []) await handler({}, { hasUI: false });
	assert.equal(logged.length, second.result.warnings.length);
});

test("an owned package settings lists again is skipped with a warning instead of loading twice", async (t) => {
	const { agentDir, cwd, configDir } = fixture(
		t,
		{ packages: { "npm:suite": "bb" } },
		{ settings: { packages: ["npm:suite"], extensions: ["-builtin:mcp"] } },
	);
	const packageRoot = packageFixture(agentDir, "suite");
	extensionModule(join(packageRoot, "one.js"), "pi.registerTool({ name: \"one\" });");
	const base = {
		configDir, cwd, agentDir,
		installedPath: () => packageRoot,
		async resolve() { throw new Error("must not resolve a package settings already loads"); },
	};

	const ordinary = await install({ ...base, bb: false });
	assert.deepEqual(ordinary.tools, []);
	assert.equal(ordinary.result.warnings.length, 1);
	assert.match(ordinary.result.warnings[0], /npm:suite is also listed in settings\.json/);

	// Inside BB the package is loaded natively too, so the same stale scope is reported there.
	const bb = await install({ ...base, bb: true });
	assert.deepEqual(bb.tools, []);
	assert.equal(bb.result.warnings.length, 1);
	assert.match(bb.result.warnings[0], /npm:suite is also listed in settings\.json/);
});

test("a source settings does not list still loads normally next to a stale one", async (t) => {
	const { agentDir, cwd, configDir } = fixture(
		t,
		{ packages: { "npm:loaded": "bb", "npm:stale": "bb" } },
		{ settings: { packages: ["npm:stale"] } },
	);
	const packageRoot = packageFixture(agentDir, "loaded", { pi: { extensions: ["./one.js"] } });
	extensionModule(join(packageRoot, "one.js"), "pi.registerTool({ name: \"one\" });");
	const loaded = await install({
		configDir, cwd, agentDir, bb: false,
		installedPath: (source) => source === "npm:loaded" ? packageRoot : undefined,
		resolve: ownedPackageResolver({ cwd, agentDir }),
	});
	assert.deepEqual(loaded.tools, ["one"]);
	assert.deepEqual(loaded.result.warnings, [
		"extension-manager: extension-manager.json: npm:stale is also listed in settings.json, so Pi loads it natively here and the loader skips it; toggle it in /extensions-manager to take it back.",
	]);
});

test("a runtime that owns nothing registers no hooks", async (t) => {
	const { agentDir, cwd, configDir } = fixture(t, {});
	const loaded = await install({ configDir, cwd, agentDir, bb: true });
	assert.deepEqual(loaded.result.loaded, []);
	assert.deepEqual(loaded.result.warnings, []);
	assert.equal(loaded.handlers.size, 0);
});

test("loading an owned package leaves the agent directory unchanged", async (t) => {
	const { agentDir, cwd, configDir } = fixture(t, { packages: { "npm:suite": "bb" } });
	const packageRoot = packageFixture(agentDir, "suite", { pi: { extensions: ["./one.js"] } });
	extensionModule(join(packageRoot, "one.js"), "pi.registerTool({ name: \"one\" });");
	const listing = (root: string, base = root): string[] => {
		const out: string[] = [];
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			const path = join(root, entry.name);
			out.push(relative(base, path));
			if (entry.isDirectory()) out.push(...listing(path, base));
		}
		return out.sort();
	};
	const before = listing(agentDir);
	const loaded = await install({ configDir, cwd, agentDir, bb: false, resolve: ownedPackageResolver({ cwd, agentDir }) });
	assert.deepEqual(loaded.tools, ["one"]);
	assert.deepEqual(listing(agentDir), before);
});
