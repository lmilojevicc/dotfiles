import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { Provider } from "@earendil-works/pi-ai/compat";
import modelBlacklist from "../index.ts";
import { unwrapProvider } from "../provider-wrap.ts";
import { fakeProvider, fakeRuntime, ids, runtimeWithoutStore } from "./helpers.ts";

const HOOK_STATE_KEY = Symbol.for("pi.model-blacklist.hook-state");

type Mode = "tui" | "rpc" | "json" | "print";

function createHarness(options: { providers?: Provider[]; mode?: Mode } = {}) {
	const runtime = fakeRuntime(options.providers ?? []);
	const mode = options.mode ?? "tui";
	const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
	const commands = new Map<string, { description: string; handler: (args: string, ctx: unknown) => unknown }>();
	const notices: { message: string; type: string }[] = [];
	const ctx = {
		modelRegistry: { runtime },
		mode,
		hasUI: mode === "tui" || mode === "rpc",
		ui: {
			notify: (message: string, type: string) => {
				notices.push({ message, type });
			},
		},
	};
	modelBlacklist({
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand: (name: string, command: { description: string; handler: (args: string, ctx: unknown) => unknown }) => {
			commands.set(name, command);
		},
	} as never);
	const emit = (event: string, reason: string) => {
		for (const handler of handlers.get(event) ?? []) handler({ type: event, reason }, ctx);
	};
	return {
		runtime,
		notices,
		start: (reason = "startup") => emit("session_start", reason),
		shutdown: (reason = "reload") => emit("session_shutdown", reason),
		command: async () => {
			await commands.get("model-blacklist")!.handler("", ctx);
		},
	};
}

function writeConfig(contents: unknown): void {
	mkdirSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true });
	writeFileSync(join(process.env.PI_CODING_AGENT_DIR!, "model-blacklist.json"), typeof contents === "string" ? contents : JSON.stringify(contents));
}

/** Lines this run wrote through `console.error`. */
async function stderrOf(run: () => unknown): Promise<string[]> {
	const lines: string[] = [];
	const original = console.error;
	console.error = (...args: unknown[]) => {
		lines.push(args.map((value) => String(value)).join(" "));
	};
	try {
		await run();
	} finally {
		console.error = original;
	}
	return lines;
}

test.beforeEach(() => {
	delete (globalThis as unknown as Record<symbol, unknown>)[HOOK_STATE_KEY];
	rmSync(join(process.env.PI_CODING_AGENT_DIR!, "model-blacklist.json"), { force: true });
});

test("session_start filters configured providers silently", () => {
	writeConfig({ providers: { alpha: ["drop"] } });
	const alpha = fakeProvider("alpha", ["keep", "drop"]);
	const { runtime, notices, start } = createHarness({ providers: [alpha] });

	start();

	assert.deepEqual(notices, []);
	assert.equal(runtime.providers.get("alpha")!.getModels().length, 1);
	assert.deepEqual(ids(runtime.providers.get("alpha")!.getModels()), ["keep"]);
	assert.equal(runtime.snapshotUpdates, 1);
});

test("session_start warns about a malformed config and hides nothing", () => {
	writeConfig("{bad");
	const alpha = fakeProvider("alpha", ["keep", "drop"]);
	const { runtime, notices, start } = createHarness({ providers: [alpha] });

	start();

	assert.equal(notices.length, 1);
	assert.equal(notices[0]!.type, "warning");
	assert.match(notices[0]!.message, /no models are hidden/);
	// The store hook still wraps the provider, but the empty rule set hides nothing.
	assert.equal(unwrapProvider(runtime.providers.get("alpha")!), alpha);
	assert.deepEqual(ids(runtime.providers.get("alpha")!.getModels()), ["keep", "drop"]);
});

test("the command applies rules and reports patterns", async () => {
	writeConfig({ providers: { alpha: ["drop"] }, global: ["*-preview"] });
	const alpha = fakeProvider("alpha", ["keep", "drop", "hy4-preview"]);
	const beta = fakeProvider("beta", ["hy4-preview"]);
	const { runtime, notices, command } = createHarness({ providers: [alpha, beta] });

	await command();

	assert.deepEqual(ids(runtime.providers.get("alpha")!.getModels()), ["keep"]);
	assert.deepEqual(ids(runtime.providers.get("beta")!.getModels()), []);
	const message = notices.at(-1)!.message;
	assert.equal(notices.at(-1)!.type, "info");
	assert.match(message, /2 pattern/);
	assert.match(message, /alpha: drop, \*-preview/);
	assert.match(message, /all other providers: \*-preview/);
});

test("the command reports unknown providers and an empty configuration", async () => {
	writeConfig({ providers: { ghost: ["x"] } });
	const harness = createHarness();

	await harness.command();
	assert.match(harness.notices.at(-1)!.message, /Unknown providers \(ignored\): ghost/);

	writeConfig({ providers: {}, global: [] });
	await harness.command();
	assert.match(harness.notices.at(-1)!.message, /No providers configured; no models are hidden/);
});

test("a provider composed after session_start stays filtered", () => {
	writeConfig({ providers: { commandcode: ["claude-*"] } });
	const { runtime, start } = createHarness();

	start();
	runtime.models!.setProvider!(fakeProvider("commandcode", ["claude-opus-5-5", "deepseek-v4.1-flash"]));
	assert.deepEqual(ids(runtime.providers.get("commandcode")!.getModels()), ["deepseek-v4.1-flash"]);

	// A background catalogue refresh composes a fresh provider that re-adds the model.
	runtime.models!.setProvider!(fakeProvider("commandcode", ["claude-opus-5-5", "claude-fable-5-1", "deepseek-v4.1-flash"]));
	assert.deepEqual(ids(runtime.providers.get("commandcode")!.getModels()), ["deepseek-v4.1-flash"]);

	// Removing the rule unhides the same wrapper, without another layer.
	const stored = runtime.providers.get("commandcode")!;
	writeConfig({ providers: {} });
	start("reload");
	assert.deepEqual(ids(runtime.providers.get("commandcode")!.getModels()), [
		"claude-opus-5-5",
		"claude-fable-5-1",
		"deepseek-v4.1-flash",
	]);
	assert.equal(runtime.providers.get("commandcode"), stored);
	assert.equal(unwrapProvider(stored).getModels().length, 3);
	assert.equal(unwrapProvider(unwrapProvider(stored)), unwrapProvider(stored));
});

test("removing a rule with the command unhides immediately", async () => {
	writeConfig({ providers: { alpha: ["drop"] }, global: [] });
	const alpha = fakeProvider("alpha", ["keep", "drop"]);
	const { runtime, command } = createHarness({ providers: [alpha] });

	await command();
	assert.deepEqual(ids(runtime.providers.get("alpha")!.getModels()), ["keep"]);

	writeConfig({ providers: { beta: ["hy4-preview"] }, global: [] });
	await command();
	assert.deepEqual(ids(runtime.providers.get("alpha")!.getModels()), ["keep", "drop"]);
	assert.equal(unwrapProvider(runtime.providers.get("alpha")!), alpha);
});

test("session_shutdown unhides and refreshes the snapshot", () => {
	writeConfig({ providers: { alpha: ["drop"] }, global: [] });
	const alpha = fakeProvider("alpha", ["keep", "drop"]);
	const { runtime, start, shutdown } = createHarness({ providers: [alpha] });

	start();
	assert.deepEqual(ids(runtime.providers.get("alpha")!.getModels()), ["keep"]);

	shutdown();
	assert.deepEqual(ids(runtime.providers.get("alpha")!.getModels()), ["keep", "drop"]);
	assert.equal(runtime.snapshotUpdates, 2);
});

test("a negated rule hides everything it does not match end to end", async () => {
	writeConfig({ providers: { alpha: ["!gpt-6*"] } });
	const alpha = fakeProvider("alpha", ["gpt-5.6-luna", "gpt-6-astra", "gpt-6.1-sol"]);
	const beta = fakeProvider("beta", ["gpt-5.5"]);
	const { runtime, notices, start, command } = createHarness({ providers: [alpha, beta] });

	start();
	assert.deepEqual(ids(runtime.providers.get("alpha")!.getModels()), ["gpt-6-astra", "gpt-6.1-sol"]);
	assert.deepEqual(ids(runtime.providers.get("beta")!.getModels()), ["gpt-5.5"]);

	await command();
	assert.match(notices.at(-1)!.message, /alpha: !gpt-6\*/);
});

test("a threshold rule gates the provider end to end", () => {
	writeConfig({ providers: { antigravity: ["!gemini-3.8+", "!claude-opus-5+"] } });
	const antigravity = fakeProvider("antigravity", ["gemini-3.7-flash", "gemini-3.8-flash", "gemini-3.10-pro", "claude-opus-4-6", "claude-opus-5-5"]);
	const { runtime, start } = createHarness({ providers: [antigravity] });

	start();
	assert.deepEqual(ids(runtime.providers.get("antigravity")!.getModels()), ["gemini-3.8-flash", "gemini-3.10-pro", "claude-opus-5-5"]);
});

test("non-TUI hosts get diagnostics on stderr as well as a notification", async () => {
	writeConfig("{bad");
	const rpc = createHarness({ providers: [fakeProvider("alpha", ["keep"])], mode: "rpc" });
	const rpcStderr = await stderrOf(() => {
		rpc.start();
		return rpc.command();
	});
	assert.equal(rpc.notices.length >= 1, true);
	assert.match(rpcStderr.join("\n"), /no models are hidden/);
	assert.match(rpcStderr.join("\n"), /Model blacklist: 0 pattern\(s\)/);

	const tui = createHarness({ providers: [fakeProvider("alpha", ["keep"])], mode: "tui" });
	const tuiStderr = await stderrOf(() => {
		tui.start();
		return tui.command();
	});
	assert.deepEqual(tuiStderr, []);
	assert.equal(tui.notices.length >= 1, true);
});

test("an unreadable runtime shape is reported instead of hiding nothing quietly", async () => {
	writeConfig({ providers: { alpha: ["drop"] } });
	const runtime = runtimeWithoutStore();
	const notices: string[] = [];
	const handlers: ((event: unknown, ctx: unknown) => unknown)[] = [];
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => unknown }>();
	modelBlacklist({
		on: (_event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.push(handler),
		registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => unknown }) => commands.set(name, command),
	} as never);
	const ctx = {
		modelRegistry: { runtime },
		mode: "rpc" as const,
		hasUI: true,
		ui: { notify: (message: string) => notices.push(message) },
	};

	const stderr = await stderrOf(async () => {
		for (const handler of handlers) handler({ type: "session_start", reason: "startup" }, ctx);
		await commands.get("model-blacklist")!.handler("", ctx);
	});

	assert.match(notices[0]!, /cannot filter Pi's model store/);
	assert.match(stderr.join("\n"), /no models are hidden/);
});
