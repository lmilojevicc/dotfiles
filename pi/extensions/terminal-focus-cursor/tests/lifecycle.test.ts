import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { piPackageRoot } from "../../_test-support/pi-package.mjs";

async function loadIndex() {
	// The extension imports Pi by specifier; load it with the same Pi the shared test loader resolved.
	const packageRoot = piPackageRoot();
	const require = createRequire(join(packageRoot, "package.json"));
	const { createJiti } = await import(pathToFileURL(require.resolve("jiti")).href);
	const jiti = createJiti(import.meta.url, {
		alias: {
			"@earendil-works/pi-coding-agent": join(packageRoot, "dist/index.js"),
			"@earendil-works/pi-tui": fileURLToPath(import.meta.resolve("@earendil-works/pi-tui")),
		},
		moduleCache: false,
	});
	return jiti.import(fileURLToPath(new URL("../index.ts", import.meta.url)));
}

function harness(module: Awaited<ReturnType<typeof loadIndex>>, env: Record<string, string | undefined>) {
	const handlers = new Map<string, (...args: any[]) => void>();
	const pi = { on: (event: string, handler: (...args: any[]) => void) => handlers.set(event, handler) };
	const stdin = new EventEmitter();
	const writes: string[] = [];
	let nextTimer = 0;
	const timers = new Map<number, () => void>();
	const dependencies = {
		env,
		stdin,
		output: { write: (data: string) => writes.push(data) },
		scheduler: {
			setTimeout(callback: () => void) {
				const id = ++nextTimer;
				timers.set(id, callback);
				return id;
			},
			clearTimeout(id: number) {
				timers.delete(id);
			},
		},
		createDefaultEditor: () => ({ render: () => [], handleInput: () => {} }),
	};
	module.createTerminalFocusCursor(pi, dependencies);

	let inputListener: ((data: string) => unknown) | undefined;
	let inputUnsubscribes = 0;
	let editorFactory: unknown;
	const ui = {
		onTerminalInput(listener: (data: string) => unknown) {
			inputListener = listener;
			return () => {
				inputUnsubscribes += 1;
				if (inputListener === listener) inputListener = undefined;
			};
		},
		getEditorComponent: () => editorFactory,
		setEditorComponent: (factory: unknown) => {
			editorFactory = factory;
		},
	};
	return {
		start: (ctx: object) => handlers.get("session_start")?.({}, { ui, ...ctx }),
		shutdown: () => handlers.get("session_shutdown")?.(),
		stdin,
		writes,
		timers,
		inputUnsubscribes: () => inputUnsubscribes,
	};
}

test("platform selection gives Herdr precedence and requires TUI mode", async () => {
	const { selectPlatform } = await loadIndex();
	assert.equal(selectPlatform({ mode: "tui", hasUI: true }, { HERDR_ENV: "1", TMUX: "yes" }), "herdr");
	assert.equal(selectPlatform({ mode: "rpc", hasUI: true }, { HERDR_ENV: "1", TMUX: "yes" }), undefined);
	assert.equal(selectPlatform({ mode: "tui", hasUI: true }, { TMUX: "yes" }), "tmux");
	assert.equal(selectPlatform({ mode: "rpc", hasUI: true }, { TMUX: "yes" }), undefined);
	assert.equal(selectPlatform({ mode: "tui", hasUI: false }, { TMUX: "yes" }), undefined);
	assert.equal(selectPlatform({ mode: "tui", hasUI: true }, {}), undefined);
});

test("injected lifecycle switches authority, cancels timers, and never writes to real stdout", async () => {
	const module = await loadIndex();
	const env: Record<string, string | undefined> = { TMUX: "yes" };
	const runtime = harness(module, env);

	runtime.start({ mode: "rpc", hasUI: true });
	assert.deepEqual(runtime.writes, [], "RPC startup writes no terminal sequences");
	assert.equal(runtime.stdin.listenerCount("data"), 0);
	assert.equal(runtime.timers.size, 0);

	runtime.start({ mode: "tui", hasUI: true });
	runtime.start({ mode: "tui", hasUI: true });
	assert.deepEqual(runtime.writes, ["\x1b[?1004h"]);
	assert.equal(runtime.timers.size, 1, "repeat start replaces the deferred editor timer");

	env.HERDR_ENV = "1";
	runtime.start({ mode: "tui", hasUI: true });
	assert.deepEqual(runtime.writes, ["\x1b[?1004h", "\x1b[?1004l"]);
	assert.equal(runtime.stdin.listenerCount("data"), 1);
	assert.equal(runtime.timers.size, 1);

	runtime.shutdown();
	assert.equal(runtime.stdin.listenerCount("data"), 0);
	assert.equal(runtime.timers.size, 0);
	assert.equal(runtime.inputUnsubscribes(), 3);
	assert.deepEqual(runtime.writes, ["\x1b[?1004h", "\x1b[?1004l"]);
});

test("the fallback editor keeps Pi's default editor options", async () => {
	const { createPiDefaultEditor } = await loadIndex();
	const editor = createPiDefaultEditor({ requestRender() {} } as never, { borderColor: (text: string) => text } as never, {} as never);
	assert.equal(editor.embedWorkingStatus, true, "the Working indicator stays inside the editor's top border");
	assert.equal(typeof editor.setWorkingStatusIndicator, "function");
});
