import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { __testing } from "../index.ts";

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
				bad: "not.an.action",
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
			config.bindings.filter((binding) => ["a", "b", "c"].includes(binding.key)),
			[
				{ key: "a", label: "leave", description: "Exit when editor is empty", action: "app.exit" },
				{ key: "b", label: "b", description: "Suspend to background", action: "app.suspend" },
				{ key: "c", label: "c", description: "Cancel or abort", action: "app.interrupt" },
			],
		);
		assert.equal(warnings.length, 2);
		assert.match(warnings[0] ?? "", /ignored bad .* not a supported prefix action/);
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
