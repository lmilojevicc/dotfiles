import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installHostGate } from "../gate.ts";

type Handler = (...args: any[]) => any;

function harness(t: any, options: { config?: unknown; env?: Record<string, string | undefined>; isTTY?: boolean; entries?: Record<string, readonly string[]>; installed?: readonly string[] } = {}) {
	const configDir = mkdtempSync(join(tmpdir(), "host-gate-"));
	t.after(() => rmSync(configDir, { recursive: true, force: true }));
	if (options.config !== undefined) writeFileSync(join(configDir, "host-gate.json"), JSON.stringify(options.config));
	const handlers = new Map<string, Handler[]>();
	const notices: string[] = [];
	const logged: string[] = [];
	const calls: string[] = [];
	const resolved: string[][] = [];
	const api = {
		on(event: string, handler: Handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
		registerTool(options: { name: string }) { calls.push(`tool:${options.name}`); },
	};
	t.mock.method(console, "error", (message: string) => logged.push(message));
	const ui = { hasUI: true, ui: { notify(message: string, type: string) { notices.push(`${type}:${message}`); } } };
	function emit(event: string, input: any = {}, ctx: any = ui) {
		const results: any[] = [];
		for (const fn of handlers.get(event) ?? []) results.push(fn(input, ctx));
		return results;
	}
	const installed = options.installed === undefined ? undefined : new Set(options.installed);
	return {
		configDir, api, notices, logged, calls, resolved, emit,
		async install(overrides: Partial<Parameters<typeof installHostGate>[1]> = {}) {
			return await installHostGate(api as any, {
				configDir,
				env: options.env ?? {},
				isTTY: options.isTTY ?? true,
				async resolve(sources) {
					resolved.push([...sources]);
					const entries: { source: string; path: string }[] = [];
					const warnings: string[] = [];
					for (const source of sources) {
						if (installed !== undefined && !installed.has(source)) {
							warnings.push(`host-gate: ${source}: not installed; not loading (this gate never installs or updates packages).`);
							continue;
						}
						for (const path of options.entries?.[source] ?? [`/${source}/index.js`]) entries.push({ source, path });
					}
					return { entries, warnings };
				},
				async loadFactory(path) {
					calls.push(`load:${path}`);
					if (path.includes("broken")) throw new Error("factory exploded");
					return (loadedApi: any) => {
						assert.equal(loadedApi, api, "gated factory receives the exact host API");
						calls.push(`call:${path}`);
						if (path.includes("registers")) api.registerTool({ name: "gated-tool" });
					};
				},
				...overrides,
			});
		},
	};
}

test("BB origin loads nothing and never resolves a package", async (t) => {
	const h = harness(t, { config: { packages: { "npm:pi-subagents": { require: ["pi"] } } }, env: { BB_THREAD_ID: "thr_1" }, isTTY: false });
	const warnings = await h.install();
	assert.deepEqual(warnings, []);
	assert.deepEqual(h.resolved, []);
	assert.deepEqual(h.calls, []);
});

test("ordinary hosts load declared entries through the supplied API", async (t) => {
	const h = harness(t, {
		config: { packages: { "npm:pi-subagents": { require: ["pi"] }, "npm:pi-interactive-shell": { require: ["pi"] } } },
		entries: { "npm:pi-subagents": ["/pkg/sub/index.js"], "npm:pi-interactive-shell": ["/pkg/shell/index.ts"] },
	});
	const warnings = await h.install();
	assert.deepEqual(warnings, []);
	assert.deepEqual(h.resolved, [["npm:pi-subagents", "npm:pi-interactive-shell"]]);
	assert.deepEqual(h.calls, ["load:/pkg/sub/index.js", "call:/pkg/sub/index.js", "load:/pkg/shell/index.ts", "call:/pkg/shell/index.ts"]);
});

test("conditions are ANDed and unlisted packages always load", async (t) => {
	const config = { packages: { "npm:always": {}, "npm:pi-only": { require: ["pi"] }, "npm:tui-only": { require: ["tui"] }, "npm:both": { require: ["pi", "tui"] }, "npm:headless": { require: ["headless"] } } };
	const tty = harness(t, { config, isTTY: true });
	assert.deepEqual(await tty.install(), []);
	assert.deepEqual(tty.resolved[0], ["npm:always", "npm:pi-only", "npm:tui-only", "npm:both"]);
	const headless = harness(t, { config, isTTY: false });
	await headless.install();
	assert.deepEqual(headless.resolved[0], ["npm:always", "npm:pi-only", "npm:headless"]);
	const bb = harness(t, { config, env: { BB_THREAD_ID: "t" }, isTTY: false });
	await bb.install();
	assert.deepEqual(bb.resolved[0], ["npm:always", "npm:headless"]);
});

test("a broken entrypoint warns and leaves sibling packages registered", async (t) => {
	const h = harness(t, {
		config: { packages: { "npm:broken": { require: ["pi"] }, "npm:registers": { require: ["pi"] } } },
		entries: { "npm:broken": ["/pkg/broken/index.ts"], "npm:registers": ["/pkg/registers/index.ts"] },
	});
	const warnings = await h.install();
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /npm:broken \/pkg\/broken\/index\.ts: factory exploded/);
	assert.ok(h.calls.includes("call:/pkg/registers/index.ts"), "sibling still loads and registers");
	assert.ok(h.calls.includes("tool:gated-tool"));
});

test("missing and empty packages warn through the resolver without failing the gate", async (t) => {
	const h = harness(t, {
		config: { packages: { "npm:missing": { require: ["pi"] }, "npm:pi-subagents": { require: ["pi"] } } },
		installed: ["npm:pi-subagents"],
	});
	const warnings = await h.install();
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /npm:missing: not installed/);
	assert.deepEqual(h.calls, ["load:/npm:pi-subagents/index.js", "call:/npm:pi-subagents/index.js"]);
});

test("a throwing resolver becomes one warning instead of a load failure", async (t) => {
	const h = harness(t, { config: { packages: { "npm:a": {} } } });
	const warnings = await h.install({ async resolve() { throw new Error("resolver down"); } });
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /resolution failed: resolver down/);
	assert.deepEqual(h.calls, []);
});

test("warnings report once per runtime, at session start or the first prompt, UI or stderr", async (t) => {
	const config = { packages: { "npm:missing": { require: ["pi"] } } };
	const ui = harness(t, { config, installed: [] });
	await ui.install();
	ui.emit("session_start", { reason: "startup" });
	ui.emit("session_start", { reason: "resume" });
	ui.emit("before_agent_start", { systemPrompt: "root" });
	assert.equal(ui.notices.length, 1, JSON.stringify(ui.notices));
	assert.match(ui.notices[0], /^warning:host-gate: npm:missing: not installed/);
	const headless = harness(t, { config, installed: [] });
	await headless.install();
	const ctx = { hasUI: false, ui: { notify() { assert.fail("headless must log instead of notify"); } } };
	headless.emit("before_agent_start", { systemPrompt: "root" }, ctx);
	headless.emit("session_start", { reason: "startup" }, ctx);
	assert.equal(headless.logged.length, 1);
	assert.match(headless.logged[0], /not installed/);
});

test("the gate never mutates the prompt and host facts are captured at install time", async (t) => {
	const env: Record<string, string | undefined> = { BB_THREAD_ID: "thr_1" };
	const h = harness(t, { config: { packages: { "npm:pi-subagents": { require: ["pi"] } } }, env, isTTY: false });
	await h.install();
	env.BB_THREAD_ID = undefined;
	h.isTTY = true;
	const results = h.emit("before_agent_start", { systemPrompt: "root" });
	assert.deepEqual(results, [undefined], "hook must not return a system prompt");
	assert.deepEqual(h.calls, [], "no retroactive loading after env changes");
});
