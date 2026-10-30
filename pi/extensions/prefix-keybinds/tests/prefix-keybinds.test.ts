import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import prefixKeybindsExtension, { __testing } from "../index.ts";
import { __testing as focusTesting } from "../../terminal-focus-cursor/editor-focus.ts";

function writeJson(path: string, value: unknown): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value)}\n`);
}

test("merges global, project, and environment config while validating values", () => {
	const root = mkdtempSync(join(tmpdir(), "prefix-keybinds-config-"));
	const home = join(root, "home");
	const cwd = join(root, "project");
	const globalPath = join(home, ".pi", "agent", "prefix-keybinds.json");
	const projectPath = join(cwd, ".pi", "prefix-keybinds.json");
	const envPath = join(root, "override.json");
	const originalHome = process.env.HOME;
	const originalOverride = process.env.PI_PREFIX_KEYBINDS_CONFIG;

	try {
		process.env.HOME = home;
		process.env.PI_PREFIX_KEYBINDS_CONFIG = envPath;
		writeJson(globalPath, {
			prefixKey: "alt+g",
			timeoutMs: 3500,
			bindings: {
				m: null,
				a: "app.clear",
				x: "not.an.action",
			},
		});
		writeJson(projectPath, {
			timeoutMs: 1200,
			showHelp: false,
			cancelKeys: ["escape", 4],
			bindings: {
				" ": "app.exit",
				a: { action: "app.exit", label: "leave" },
				b: "app.suspend",
			},
		});
		writeJson(envPath, {
			prefixKey: "ctrl+q",
			timeoutMs: -1,
			showHelp: "yes",
			bindings: { c: "app.interrupt" },
		});

		const { config, warnings } = __testing.loadConfig(cwd);
		assert.equal(config.prefixKey, "ctrl+q");
		assert.equal(config.timeoutMs, 1200);
		assert.equal(config.showHelp, false);
		assert.deepEqual(config.cancelKeys, ["escape", "ctrl+c"]);
		assert.deepEqual(config.loadedPaths, [globalPath, projectPath, envPath]);
		assert.equal(config.bindings.some((binding) => binding.key === "m"), false);
		assert.deepEqual(
			config.bindings
				.filter((binding) => ["a", "b", "c"].includes(binding.key))
				.map((binding) => `${binding.key} -> ${binding.action} (${binding.label}: ${binding.description})`)
				.sort(),
			[
				"a -> app.exit (leave: Exit when editor is empty)",
				"b -> app.suspend (b: Suspend to background)",
				"c -> app.interrupt (c: Cancel or abort)",
			],
		);
		assert.equal(warnings.length, 2);
		assert.match(warnings[0] ?? "", /ignored x -> not.an.action .* not a supported prefix action/);
		assert.match(warnings[1] ?? "", /ignored an empty binding key/);

		assert.equal(__testing.configWritePath(cwd, config.loadedPaths), envPath);
		delete process.env.PI_PREFIX_KEYBINDS_CONFIG;
		assert.equal(__testing.configWritePath(cwd, config.loadedPaths), projectPath);
		rmSync(projectPath);
		assert.equal(__testing.configWritePath(cwd, [join(root, "custom.json")]), join(root, "custom.json"));
		assert.equal(__testing.configWritePath(cwd, []), globalPath);
		process.env.PI_PREFIX_KEYBINDS_CONFIG = "relative/config.json";
		assert.equal(__testing.configWritePath(cwd, []), resolve(cwd, "relative/config.json"));
	} finally {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalOverride === undefined) delete process.env.PI_PREFIX_KEYBINDS_CONFIG;
		else process.env.PI_PREFIX_KEYBINDS_CONFIG = originalOverride;
		rmSync(root, { recursive: true, force: true });
	}
});

function config(timeoutMs = 2000) {
	return {
		prefixKey: "ctrl+x",
		timeoutMs,
		showHelp: true,
		cancelKeys: ["escape", "ctrl+c"],
		loadedPaths: [],
		bindings: [
			{
				key: "k",
				label: "k",
				description: "Clear editor",
				action: "app.clear",
			},
		],
	};
}

function fakeUi() {
	const notifications: Array<[string, string]> = [];
	const statuses: unknown[][] = [];
	const widgets: unknown[][] = [];
	return {
		notifications,
		statuses,
		widgets,
		theme: { fg: (_color: string, value: string) => value },
		setStatus: (...args: unknown[]) => statuses.push(args),
		setWidget: (...args: unknown[]) => widgets.push(args),
		notify: (message: string, level: string) => notifications.push([message, level]),
	};
}

test("editor wrapper dispatches bindings and forwards ordinary input", () => {
	const forwarded: string[] = [];
	let dispatched = 0;
	const ui = fakeUi();
	const editor = {
		handleInput(data: string) {
			forwarded.push(data);
		},
		actionHandlers: new Map([["app.clear", () => (dispatched += 1)]]),
	};

	const patched = __testing.patchWithPrefix(editor, ui, () => config());
	patched.handleInput("ordinary");
	patched.handleInput("ctrl+x");
	patched.handleInput("k");

	assert.deepEqual(forwarded, ["ordinary"]);
	assert.equal(dispatched, 1);
	assert.equal(ui.notifications.length, 0);
	patched.dispose?.();
});

test("atomic persistence preserves permissions and cleans failed temporary files", () => {
	const root = mkdtempSync(join(tmpdir(), "prefix-keybinds-persist-"));
	try {
		const target = join(root, "prefix.json");
		const existing = { prefixKey: "ctrl+y", timeoutMs: 1500 };
		writeJson(target, existing);
		chmodSync(target, 0o640);
		const next = { ...config(), loadedPaths: [target] };
		const previousUmask = process.umask(0o077);
		try {
			assert.equal(
				__testing.persistConfig(root, { ...next, prefixKey: "ctrl+x" }, { kind: "prefix", prefixKey: "ctrl+x" }),
				target,
			);
		} finally {
			process.umask(previousUmask);
		}
		assert.equal(statSync(target).mode & 0o777, 0o640, "existing mode survives a restrictive umask");
		assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), { ...existing, prefixKey: "ctrl+x" });
		assert.deepEqual(readdirSync(root).filter((name) => name.includes(".tmp")), []);

		const blocked = join(root, "blocked.json");
		mkdirSync(blocked);
		writeFileSync(join(blocked, "old.txt"), "old content");
		assert.throws(() =>
			__testing.persistConfig(root, { ...next, loadedPaths: [blocked] }, { kind: "replace", config: next }),
		);
		assert.equal(readFileSync(join(blocked, "old.txt"), "utf8"), "old content");
		assert.deepEqual(readdirSync(root).filter((name) => name.startsWith("blocked.json.") && name.endsWith(".tmp")), []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("managed editor layers replace stale closures without growing chains in either order", () => {
	for (const order of ["prefix-first", "focus-first"] as const) {
		const calls: string[] = [];
		const base = () => {
			calls.push("base");
			return {};
		};
		let factory = base as never;
		const observedContexts: object[] = [];
		const install = (session: number) => {
			const context = { ui: { session }, cwd: `/session-${session}`, config: { session } };
			const prefixLayer = (next: any) => (...args: any[]) => {
				calls.push(`prefix:${session}`);
				observedContexts.push(context);
				return next?.(...args) ?? {};
			};
			const focusLayer = (next: any) => (...args: any[]) => {
				calls.push(`focus:${session}`);
				observedContexts.push(context);
				return next?.(...args) ?? {};
			};
			if (order === "prefix-first") {
				factory = __testing.installEditorLayer(factory, "prefix-keybinds", prefixLayer) as never;
				factory = focusTesting.installEditorLayer(factory, "terminal-focus-cursor", focusLayer) as never;
			} else {
				factory = focusTesting.installEditorLayer(factory, "terminal-focus-cursor", focusLayer) as never;
				factory = __testing.installEditorLayer(factory, "prefix-keybinds", prefixLayer) as never;
			}
		};

		install(1);
		(factory as any)({}, {}, {});
		calls.length = 0;
		install(2);
		(factory as any)({}, {}, {});
		const expectedOrder = order === "prefix-first"
			? ["focus:2", "prefix:2", "base"]
			: ["prefix:2", "focus:2", "base"];
		assert.deepEqual(calls, expectedOrder, "layer execution order remains stable after replacement");
		assert.equal(calls.some((value) => value.endsWith(":1")), false);
		assert.equal(observedContexts.length, 4);
		assert.equal(observedContexts.slice(-2).every((context: any) => context.cwd === "/session-2"), true);
		const metadata = (factory as any)[Symbol.for("milo.pi.editor-factory-layers.v1")];
		assert.equal(metadata.baseFactory, base);
		assert.deepEqual(
			[...metadata.layers.keys()],
			order === "prefix-first"
				? ["prefix-keybinds", "terminal-focus-cursor"]
				: ["terminal-focus-cursor", "prefix-keybinds"],
		);
	}
});

test("session shutdown cancels deferred prefix installation", () => {
	const handlers = new Map<string, Function>();
	const originalSetTimeout = globalThis.setTimeout;
	const originalClearTimeout = globalThis.clearTimeout;
	let nextId = 0;
	const pending = new Map<number, () => void>();
	(globalThis as any).setTimeout = (callback: () => void) => {
		const id = ++nextId;
		pending.set(id, callback);
		return id;
	};
	(globalThis as any).clearTimeout = (id: number) => pending.delete(id);
	let installations = 0;
	try {
		prefixKeybindsExtension({
			registerCommand() {},
			on(event: string, handler: Function) { handlers.set(event, handler); },
		} as never);
		const ctx = {
			hasUI: true,
			cwd: process.cwd(),
			ui: {
				getEditorComponent: () => undefined,
				setEditorComponent: () => installations++,
				notify() {}, setStatus() {}, setWidget() {},
				theme: { fg: (_color: string, value: string) => value },
			},
		};
		handlers.get("session_start")?.({}, ctx);
		assert.equal(pending.size, 1);
		handlers.get("session_start")?.({}, { ...ctx, hasUI: false });
		assert.equal(pending.size, 0, "a repeated non-UI start cancels the old deferred install");
		handlers.get("session_start")?.({}, ctx);
		assert.equal(pending.size, 1);
		handlers.get("session_shutdown")?.({}, ctx);
		assert.equal(pending.size, 0);
		for (const callback of pending.values()) callback();
		assert.equal(installations, 0);
	} finally {
		globalThis.setTimeout = originalSetTimeout;
		globalThis.clearTimeout = originalClearTimeout;
	}
});

test("editor wrapper cancels, times out, and composes original disposal", async () => {
	const forwarded: string[] = [];
	let dispatched = 0;
	let disposed = 0;
	const ui = fakeUi();
	const editor = {
		handleInput(data: string) {
			forwarded.push(data);
		},
		actionHandlers: new Map([["app.clear", () => (dispatched += 1)]]),
		dispose() {
			disposed += 1;
		},
	};
	const patched = __testing.patchWithPrefix(editor, ui, () => config(20));

	patched.handleInput("ctrl+x");
	patched.handleInput("escape");
	patched.handleInput("k");
	patched.handleInput("ctrl+x");
	await new Promise((resolvePromise) => setTimeout(resolvePromise, 60));
	patched.handleInput("k");
	patched.handleInput("ctrl+x");
	patched.dispose?.();

	assert.deepEqual(forwarded, ["k", "k"]);
	assert.equal(dispatched, 0);
	assert.equal(disposed, 1);
	assert.deepEqual(ui.statuses.at(-1), ["prefix-keybinds", undefined]);
	assert.deepEqual(ui.widgets.at(-1), ["prefix-keybinds.active", undefined]);
});

test("configured custom prefix+m dispatches picker without submit; native action and overrides remain intact", () => {
	const root = mkdtempSync(join(tmpdir(), "prefix-model-picker-"));
	const previousHome = process.env.HOME;
	const previousOverride = process.env.PI_PREFIX_KEYBINDS_CONFIG;
	try {
		process.env.HOME = join(root, "home");
		delete process.env.PI_PREFIX_KEYBINDS_CONFIG;
		const path = join(root, ".pi", "prefix-keybinds.json");
		writeJson(path, { prefixKey: "ctrl+q" });
		let loaded = __testing.loadConfig(root).config;
		assert.equal(loaded.bindings.find((binding) => binding.key === "m")?.action, "pi.model-picker");
		const submitted: string[] = [], forwarded: string[] = [];
		let native = 0, opened = 0;
		const editor = __testing.patchWithPrefix({
			handleInput: (data: string) => forwarded.push(data),
			onSubmit: (value: string) => submitted.push(value),
			actionHandlers: new Map([["app.model.select", () => native++]]),
		}, fakeUi(), () => loaded, () => { opened++; return true; });
		try {
			editor.handleInput("ctrl+x"); // not the configured prefix
			editor.handleInput("ctrl+q"); editor.handleInput("m");
			assert.deepEqual(submitted, []);
			assert.equal(opened, 1);
			assert.deepEqual(forwarded, ["ctrl+x"]);
			assert.equal(native, 0);
			writeJson(path, { prefixKey: "alt+g", bindings: { m: "app.model.select" } });
			loaded = __testing.loadConfig(root).config;
			editor.handleInput("alt+g"); editor.handleInput("m");
			assert.equal(native, 1, "explicit native action override still dispatches native selector");
			assert.deepEqual(submitted, []);
			assert.equal(opened, 1);
			const overridePath = join(root, "override.json");
			writeJson(overridePath, { bindings: { m: null } });
			process.env.PI_PREFIX_KEYBINDS_CONFIG = overridePath;
			assert.equal(__testing.loadConfig(root).config.bindings.some((binding) => binding.key === "m"), false);
		} finally { editor.dispose?.(); }
	} finally {
		if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
		if (previousOverride === undefined) delete process.env.PI_PREFIX_KEYBINDS_CONFIG; else process.env.PI_PREFIX_KEYBINDS_CONFIG = previousOverride;
		rmSync(root, { recursive: true, force: true });
	}
});

test("missing model-picker warns without replacing draft or submitting a command", () => {
	const inserted: string[] = [];
	const ui = { ...fakeUi(), setEditorText: (value: string) => inserted.push(value) };
	const editor = __testing.patchWithPrefix({ handleInput() {} }, ui, () => ({
		...config(), bindings: [{ key: "m", label: "m", description: "Models", action: "pi.model-picker" }],
	}));
	try {
		editor.handleInput("ctrl+x"); editor.handleInput("m");
		assert.deepEqual(inserted, []);
		assert.match(ui.notifications[0]?.[0] ?? "", /unavailable/);
	} finally { editor.dispose?.(); }
});

function registeredExtension() {
	const handlers = new Map<string, Function>();
	const commands = new Map<string, { handler: (args: string, ctx: never) => Promise<void> | void }>();
	prefixKeybindsExtension({
		registerCommand(name: string, definition: never) {
			commands.set(name, definition);
		},
		on(event: string, handler: Function) {
			handlers.set(event, handler);
		},
		events: { emit() {} },
	} as never);
	return { handlers, commands };
}

function fakeCommandUi(cwd: string, answers: { input?: string[]; select?: string[]; confirm?: boolean } = {}) {
	const selects: string[][] = [];
	const ui = {
		...fakeUi(),
		input: async () => answers.input?.shift(),
		select: async (_title: string, options: string[]) => {
			selects.push(options);
			return answers.select?.shift();
		},
		confirm: async () => answers.confirm ?? false,
		custom: async () => undefined,
		setEditorText: () => {},
	};
	return { selects, ui, ctx: { cwd, hasUI: true, mode: "tui", ui } };
}

/** Run a test body with an isolated HOME and no environment config override. */
function withIsolatedHome(body: (root: string) => void | Promise<void>) {
	return async () => {
		const root = mkdtempSync(join(tmpdir(), "prefix-keybinds-home-"));
		const previousHome = process.env.HOME;
		const previousOverride = process.env.PI_PREFIX_KEYBINDS_CONFIG;
		try {
			process.env.HOME = join(root, "home");
			delete process.env.PI_PREFIX_KEYBINDS_CONFIG;
			await body(root);
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			if (previousOverride === undefined) delete process.env.PI_PREFIX_KEYBINDS_CONFIG;
			else process.env.PI_PREFIX_KEYBINDS_CONFIG = previousOverride;
			rmSync(root, { recursive: true, force: true });
		}
	};
}

test(
	"the removed pi.peek action warns instead of submitting /peek to the model",
	withIsolatedHome(async (root) => {
		const loaded = __testing.loadConfig(root).config;
		assert.equal(loaded.bindings.some((binding) => binding.action === "pi.peek"), false);

		const submitted: string[] = [];
		const ui = fakeUi();
		const editor = __testing.patchWithPrefix(
			{ handleInput() {}, onSubmit: (value: string) => submitted.push(value) },
			ui,
			() => loaded,
		);
		try {
			editor.handleInput("ctrl+x");
			editor.handleInput("p");
			assert.deepEqual(submitted, [], "an unbound key never reaches the editor submit handler");
			assert.match(ui.notifications.at(-1)?.[0] ?? "", /Unknown key after prefix/);

			editor.handleInput("ctrl+x");
			editor.handleInput("r");
			assert.deepEqual(submitted, ["/reload"], "a registered slash command still submits");
		} finally {
			editor.dispose?.();
		}
	}),
);

test(
	"Pi 1.4.0 copy and save-thinking actions are reachable through the prefix layer",
	withIsolatedHome(async (root) => {
		const loaded = __testing.loadConfig(root).config;
		assert.equal(
			loaded.bindings.find((binding) => binding.action === "app.message.copy")?.key,
			"c",
			"the prefix layer offers copy because it owns the native ctrl+x shortcut",
		);

		assert.equal(__testing.isPrefixAction("app.message.copy"), true);
		assert.equal(__testing.isPrefixAction("app.thinking.save"), true);

		let copied = 0;
		const editor = __testing.patchWithPrefix(
			{ handleInput() {}, actionHandlers: new Map([["app.message.copy", () => (copied += 1)]]) },
			fakeUi(),
			() => loaded,
		);
		try {
			editor.handleInput("ctrl+x");
			editor.handleInput("c");
			assert.equal(copied, 1);
		} finally {
			editor.dispose?.();
		}
	}),
);

test(
	"unusable keys from config files are reported and ignored",
	withIsolatedHome(async (root) => {
		const cwd = join(root, "project");
		writeJson(join(root, "home", ".pi", "agent", "prefix-keybinds.json"), {
			prefixKey: "ctrl_+x",
			cancelKeys: ["escape", "foo"],
			bindings: { "ctrl_+x": "app.clear", m: "app.model.select" },
		});

		const { config: loaded, warnings } = __testing.loadConfig(cwd);
		assert.equal(loaded.prefixKey, "ctrl+x", "an unusable prefix falls back instead of disarming the layer");
		assert.deepEqual(loaded.cancelKeys, ["escape"]);
		assert.equal(loaded.bindings.some((binding) => binding.action === "app.clear"), false);
		assert.equal(loaded.bindings.find((binding) => binding.key === "m")?.action, "app.model.select");
		assert.deepEqual(
			warnings.map((warning) => warning.replace(`${join(root, "home", ".pi", "agent", "prefix-keybinds.json")}: `, "")),
			[
				'ignored prefixKey because "ctrl_+x" is not a key Pi can report',
				'ignored cancel key because "foo" is not a key Pi can report; use one character (x), a named key (escape, tab), or a modifier combination (ctrl+x)',
				'ignored ctrl_+x because "ctrl_+x" is not a key Pi can report',
			],
		);
	}),
);

test(
	"configuration commands reject unusable keys before writing config",
	withIsolatedHome(async (root) => {
		const cwd = join(root, "project");
		const projectPath = join(cwd, ".pi", "prefix-keybinds.json");
		const globalPath = join(root, "home", ".pi", "agent", "prefix-keybinds.json");
		const { commands } = registeredExtension();
		const handler = commands.get("prefix-keybinds")?.handler;
		assert.ok(handler);
		const { ui, ctx } = fakeCommandUi(cwd);

		await handler("prefix ctrl_+x", ctx as never);
		assert.equal(existsSync(projectPath), false, "an unusable prefix is not persisted");
		assert.match(ui.notifications.at(-1)?.[0] ?? "", /Prefix key not saved: .*not a key Pi can report/);

		await handler("set foo app.clear", ctx as never);
		assert.equal(existsSync(projectPath), false, "an unusable binding key is not persisted");
		assert.match(ui.notifications.at(-1)?.[0] ?? "", /Key not saved: .*not a key Pi can report/);

		await handler("prefix ctrl+q", ctx as never);
		assert.equal(existsSync(projectPath), false);
		assert.equal(JSON.parse(readFileSync(globalPath, "utf8")).prefixKey, "ctrl+q");
	}),
);

test(
	"an explicit but unknown action is reported instead of replaced by a picker",
	withIsolatedHome(async (root) => {
		const cwd = join(root, "project");
		const projectPath = join(cwd, ".pi", "prefix-keybinds.json");
		const globalPath = join(root, "home", ".pi", "agent", "prefix-keybinds.json");
		const { commands } = registeredExtension();
		const handler = commands.get("prefix-keybinds")?.handler;
		assert.ok(handler);
		const { ui, selects, ctx } = fakeCommandUi(cwd, { input: ["m"], select: ["app.clear"] });

		await handler("set m pi.model-pikr", ctx as never);
		assert.deepEqual(selects, [], "no dialog is opened for a mistyped action");
		assert.match(ui.notifications.at(-1)?.[0] ?? "", /Unknown prefix action "pi.model-pikr"/);
		assert.match(ui.notifications.at(-1)?.[0] ?? "", /pi\.model-picker/);
		assert.equal(existsSync(projectPath), false, "nothing is written for an unknown action");

		await handler("set m app.clear", ctx as never);
		assert.equal(existsSync(projectPath), false);
		assert.deepEqual(JSON.parse(readFileSync(globalPath, "utf8")), { bindings: { m: "app.clear" } });
	}),
);

test(
	"saving one binding writes only that change and leaves other config layers authoritative",
	withIsolatedHome(async (root) => {
		const cwd = join(root, "project");
		const globalPath = join(root, "home", ".pi", "agent", "prefix-keybinds.json");
		const projectPath = join(cwd, ".pi", "prefix-keybinds.json");
		writeJson(globalPath, { prefixKey: "alt+g", timeoutMs: 1500, bindings: { a: "app.clear" } });
		writeJson(projectPath, { bindings: { b: "app.suspend" } });

		const loaded = __testing.loadConfig(cwd).config;
		const changed = {
			...loaded,
			bindings: [
				...loaded.bindings.filter((binding) => binding.key !== "z"),
				{ key: "z", label: "z", description: "Exit when editor is empty", action: "app.exit" as const },
			],
		};
		__testing.persistConfig(cwd, changed, { kind: "binding", key: "z", action: "app.exit" });

		assert.deepEqual(
			JSON.parse(readFileSync(projectPath, "utf8")),
			{ bindings: { b: "app.suspend", z: "app.exit" } },
			"the project file receives the change only, without replaceDefaults or merged values",
		);

		writeJson(globalPath, { prefixKey: "ctrl+q", timeoutMs: 1500, bindings: { a: "app.clear" } });
		const reloaded = __testing.loadConfig(cwd).config;
		assert.equal(reloaded.prefixKey, "ctrl+q", "later edits of the global file still apply");
		assert.equal(reloaded.timeoutMs, 1500, "global values are not shadowed by the project file");
		assert.deepEqual(
			reloaded.bindings
				.filter((binding) => ["a", "b", "z"].includes(binding.key))
				.map((binding) => `${binding.key} -> ${binding.action}`)
				.sort(),
			["a -> app.clear", "b -> app.suspend", "z -> app.exit"],
		);

		__testing.persistConfig(cwd, { ...reloaded, bindings: reloaded.bindings.filter((binding) => binding.key !== "z") }, {
			kind: "unbind",
			key: "z",
		});
		assert.equal(JSON.parse(readFileSync(projectPath, "utf8")).bindings.z, false);
		const afterUnbind = __testing.loadConfig(cwd).config;
		assert.equal(afterUnbind.bindings.some((binding) => binding.key === "z"), false);
	}),
);

test(
	"config is parsed once per file change, not on every key press",
	withIsolatedHome(async (root) => {
		const cwd = join(root, "project");
		const globalPath = join(root, "home", ".pi", "agent", "prefix-keybinds.json");
		writeJson(globalPath, { prefixKey: "alt+g" });

		assert.equal(__testing.ensureState(cwd).config.prefixKey, "alt+g");
		const loads = __testing.configLoadCount();
		for (let index = 0; index < 5; index += 1) assert.equal(__testing.ensureState(cwd).config.prefixKey, "alt+g");
		assert.equal(__testing.configLoadCount(), loads, "an unchanged config is not re-read");

		writeJson(globalPath, { prefixKey: "ctrl+q" });
		assert.equal(__testing.ensureState(cwd).config.prefixKey, "ctrl+q");
		assert.equal(__testing.configLoadCount(), loads + 1);

		const sameSize = readFileSync(globalPath, "utf8").replace("ctrl+q", "ctrl+w");
		writeFileSync(globalPath, sameSize);
		const future = new Date(Date.now() + 60_000);
		utimesSync(globalPath, future, future);
		assert.equal(__testing.ensureState(cwd).config.prefixKey, "ctrl+w", "an mtime-only edit is picked up");
	}),
);

test("session shutdown disarms a prefix layer left active", async () => {
	const { handlers } = registeredExtension();
	const ui = fakeUi();
	const editor = __testing.patchWithPrefix({ handleInput() {} }, ui, () => config(20));
	try {
		editor.handleInput("ctrl+x");
		const armed = ui.statuses.length;
		handlers.get("session_shutdown")?.({}, { hasUI: true, cwd: process.cwd(), ui });
		const cleared = ui.statuses.length;
		assert.ok(cleared > armed, "shutdown clears the status of the live editor");

		await new Promise((resolvePromise) => setTimeout(resolvePromise, 60));
		assert.equal(ui.statuses.length, cleared, "the armed timeout no longer fires against a dead editor");
	} finally {
		editor.dispose?.();
	}
});
