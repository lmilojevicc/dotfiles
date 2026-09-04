import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { AgentSession, discoverAndLoadExtensions, ModelSelectorComponent } from "@earendil-works/pi-coding-agent";
import { TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";
import { keys, model } from "./fixtures.ts";

const extensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("real Pi runtime registers only /model-picker without patching native selector", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "model-picker-runtime-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const before = Object.getOwnPropertyDescriptors(ModelSelectorComponent.prototype);
	const loaded = await discoverAndLoadExtensions([dirname(extensionPath)], root, root);
	assert.deepEqual(loaded.errors, []);
	assert.equal(loaded.extensions.length, 1);
	const extension = loaded.extensions[0];
	assert.deepEqual([...extension.commands.keys()], ["model-picker"]);
	assert.deepEqual([...extension.handlers.keys()].sort(), ["session_shutdown", "session_start"]);
	assert.equal(extension.shortcuts.size, 0);
	assert.deepEqual(Object.getOwnPropertyDescriptors(ModelSelectorComponent.prototype), before);
	const source = ["index.ts", "component.ts", "domain.ts", "persistence.ts"].map((file) => readFileSync(join(dirname(extensionPath), file), "utf8")).join("\n");
	assert.doesNotMatch(source, /\.prototype|dist\/|model-favorites\.json|setEnabledModels|scopedModels\s*=/);
});

test("command rejects RPC/print/json without catalogue, UI custom, switching or saving", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "model-picker-modes-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const loaded = await discoverAndLoadExtensions([extensionPath], root, root);
	const command = loaded.extensions[0].commands.get("model-picker")!;
	let warnings = 0;
	await command.handler("", { mode: "rpc", hasUI: true, ui: { notify: (message: string) => { assert.match(message, /terminal/); warnings++; } } } as never);
	for (const mode of ["print", "json"]) await assert.rejects(command.handler("", { mode, hasUI: false } as never), /terminal/);
	assert.equal(warnings, 1);
	assert.equal(existsSync(join(root, "settings.json")), false);
});

test("real installed TUI renders, navigates, resizes and cancels cached scoped picker without mutation", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "model-picker-tui-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const legacy = join(root, "model-favorites.json");
	writeFileSync(legacy, "legacy bytes\n");
	const loaded = await discoverAndLoadExtensions([extensionPath], root, root);
	assert.deepEqual(loaded.errors, []);
	const command = loaded.extensions[0].commands.get("model-picker")!;
	const themeModule = await import(new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
	const theme = themeModule.getThemeByName("dark");
	let input: (data: string) => void = () => {};
	let resize: () => void = () => {};
	let output = "";
	const terminal = {
		columns: 90, rows: 24, kittyProtocolActive: false,
		start: (onInput: typeof input, onResize: typeof resize) => { input = onInput; resize = onResize; },
		stop() {}, drainInput: async () => {}, write: (data: string) => { output += data; },
		moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
	};
	const tui = new TuiMainScreen(terminal);
	const a = model("alpha", "shared"), b = model("beta", "shared");
	let component: any;
	let modelCalls = 0;
	loaded.runtime.setModel = async () => { modelCalls++; return true; };
	const running = command.handler("", {
		mode: "tui", hasUI: true, cwd: root, model: b, scopedModels: [{ model: a }, { model: b }],
		modelRegistry: { getAvailable: () => { throw Error("scope must not broaden"); }, refresh: () => { throw Error("opening must be cached"); } },
		ui: {
			custom: (factory: Function) => new Promise((resolve) => {
				component = factory(tui, theme, keys(), resolve);
				tui.addChild(component); tui.setFocus(component); tui.start();
			}),
			notify: () => { throw Error("cancel should not notify"); },
		},
	} as never);
	try {
		await tick();
		assert.ok(output.length > 0);
		assert.equal(component.getSelectedModel().provider, "beta");
		assert.match(component.render(90).join("\n"), /session scope/);
		input("\t"); input("\x1b[B"); input("\t");
		assert.equal(component.getSelectedModel().provider, "alpha");
		terminal.columns = 25; terminal.rows = 12; resize(); await tick();
		assert.ok(component.render(25).every((line: string) => visibleWidth(line) <= 25));
		input("shared"); input("\x1b");
		assert.equal(component.getQuery(), "");
		input("\x1b"); await running;
		assert.equal(modelCalls, 0);
		assert.equal(existsSync(join(root, "settings.json")), false);
		assert.equal(readFileSync(legacy, "utf8"), "legacy bytes\n");
	} finally { tui.stop(); component?.dispose(); }
});

test("real loaded command switches and saves to isolated global settings with honest notifications", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "model-picker-command-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	});
	const loaded = await discoverAndLoadExtensions([extensionPath], root, root);
	assert.deepEqual(loaded.errors, []);
	const chosen = model("beta", "shared");
	let switched = 0;
	loaded.runtime.setModel = async (value) => { assert.equal(value, chosen); switched++; return true; };
	const notifications: string[] = [];
	const context = {
		mode: "tui", hasUI: true, cwd: root, isProjectTrusted: () => false, scopedModels: [],
		modelRegistry: { getAvailable: () => [chosen] },
		ui: { custom: async () => chosen, notify: (message: string) => notifications.push(message) },
	};
	const handler = loaded.extensions[0].commands.get("model-picker")!.handler;
	await handler("", context as never);
	assert.equal(switched, 1);
	assert.deepEqual(JSON.parse(readFileSync(join(root, "settings.json"), "utf8")), { defaultProvider: "beta", defaultModel: "shared" });
	assert.match(notifications.at(-1)!, /saved global default/);
	const saved = readFileSync(join(root, "settings.json"), "utf8");
	const host = {
		model: model("old", "old"), agent: { state: { model: model("old", "old") } },
		_modelRuntime: { checkAuth: async () => true }, _getThinkingLevelForModelSwitch: () => "off",
		sessionManager: { appendModelChange() { throw Error("transcript write failed"); } },
	};
	loaded.runtime.setModel = async (value) => { await AgentSession.prototype.setModel.call(host as never, value); return true; };
	await handler("", context as never);
	assert.equal(host.agent.state.model, chosen);
	assert.match(notifications.at(-1)!, /active model may have changed.*Global default was NOT saved.*transcript write failed/);
	assert.doesNotMatch(notifications.at(-1)!, /Model not changed/);
	assert.equal(readFileSync(join(root, "settings.json"), "utf8"), saved);
	loaded.runtime.setModel = async () => { writeFileSync(join(root, "settings.json"), "[]"); return true; };
	await handler("", context as never);
	assert.match(notifications.at(-1)!, /but global default was NOT saved/);
	assert.equal(readFileSync(join(root, "settings.json"), "utf8"), "[]");
});

test("real dark/light themes keep highlighted Unicode rows and Input cursor within every width", async () => {
	const { ModelPickerComponent } = await import("../component.ts");
	const { CURSOR_MARKER } = await import("@earendil-works/pi-tui");
	const themes = await import(new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
	const long = model("界😀é".repeat(30), "模型👨‍👩‍👧‍👦".repeat(30), "Wide name");
	for (const name of ["dark", "light"]) {
		const theme = themes.getThemeByName(name);
		assert.ok(theme);
		const component = new ModelPickerComponent({ models: [long], current: long, scoped: false, theme,
			keybindings: keys(), getHeight: () => 12, onChange() {}, onSelect() {}, onCancel() {},
		});
		component.focused = true;
		for (const width of [1, 2, 7, 12, 25, 63, 64, 80, 120]) {
			for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width, `${name}: ${width}`);
		}
		component.handleInput("界😀é".repeat(40));
		component.handleInput("\x1b[D");
		const lines = component.render(25);
		assert.ok(lines.some((line) => line.includes(CURSOR_MARKER)));
		assert.ok(lines.every((line) => visibleWidth(line) <= 25));
	}
});
