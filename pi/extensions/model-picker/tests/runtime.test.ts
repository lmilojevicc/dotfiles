import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";

function isolateAgentDir(t: test.TestContext, root: string): void {
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
}
import { AgentSession, discoverAndLoadExtensions, ModelSelectorComponent } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";
import { extensionFixture, keys, model } from "./fixtures.ts";

const extensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("real Pi runtime registers only /model-picker without patching native selector", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "model-picker-runtime-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	isolateAgentDir(t, root);
	const before = Object.getOwnPropertyDescriptors(ModelSelectorComponent.prototype);
	const loaded = await discoverAndLoadExtensions([dirname(extensionFixture(root))], root, root);
	assert.deepEqual(loaded.errors, []);
	assert.equal(loaded.extensions.length, 1);
	const extension = loaded.extensions[0];
	assert.deepEqual([...extension.commands.keys()], ["model-picker"]);
	assert.deepEqual([...extension.handlers.keys()].sort(), ["session_shutdown", "session_start"]);
	assert.equal(extension.shortcuts.size, 0);
	assert.deepEqual(Object.getOwnPropertyDescriptors(ModelSelectorComponent.prototype), before);
	const source = ["index.ts", "component.ts", "domain.ts", "persistence.ts", "favorites.ts"].map((file) => readFileSync(join(dirname(extensionPath), file), "utf8")).join("\n");
	assert.doesNotMatch(source, /\.prototype|dist\/|setEnabledModels|scopedModels\s*=/);
});

test("command rejects RPC/print/json without catalogue, UI custom, switching or saving", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "model-picker-modes-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	isolateAgentDir(t, root);
	const loaded = await discoverAndLoadExtensions([extensionFixture(root)], root, root);
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
	isolateAgentDir(t, root);
	const legacy = join(root, "model-favorites.json");
	writeFileSync(legacy, "legacy bytes\n");
	const loaded = await discoverAndLoadExtensions([extensionFixture(root)], root, root);
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
		assert.match(component.render(90).join("\n"), /\[session\]/);
		assert.match(component.render(90).join("\n"), /Favorites: Fix JSON/);
		input("\t"); input("\x1b[B"); input("\x1b[B"); input("\t");
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
	isolateAgentDir(t, root);
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const favoriteBytes = '{"favorites":["beta/shared"],"extra":true}\n';
	writeFileSync(join(root, "model-favorites.json"), favoriteBytes);
	const loaded = await discoverAndLoadExtensions([extensionFixture(root)], root, root);
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
	assert.equal(readFileSync(join(root, "model-favorites.json"), "utf8"), favoriteBytes);
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
	assert.equal(readFileSync(join(root, "model-favorites.json"), "utf8"), favoriteBytes);
});

test("real dark/light themes keep highlighted Unicode rows and Input cursor within every width", async () => {
	const { ModelPickerComponent } = await import("../component.ts");
	const { CURSOR_MARKER } = await import("@earendil-works/pi-tui");
	const themes = await import(new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
	const long = model("界😀é".repeat(30), "模型👨‍👩‍👧‍👦".repeat(30), "Wide name");
	for (const name of ["dark", "light"]) for (const height of [1, 2, 3, 4, 5, 12]) for (const favoriteError of [undefined, "Favorites: read-only"]) {
		const theme = themes.getThemeByName(name);
		assert.ok(theme);
		for (const remapped of [false, true]) {
			const keybindings = remapped ? new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.confirm": "ctrl+shift+s", "tui.select.cancel": "ctrl+q" }) : keys();
			const component = new ModelPickerComponent({ models: [long], current: long, scoped: true, theme,
				favorites: [`${long.provider}/${long.id}`], favoriteError, onToggleFavorite: () => [],
				keybindings, getHeight: () => height, onChange() {}, onSelect() {}, onCancel() {},
			});
			component.focused = true;
			for (const width of [1, 2, 7, 12, 20, 21, 22, 23, 24, 25, 63, 64, 80, 120]) {
				const lines = component.render(width);
				assert.ok(lines.length <= height);
				for (const line of lines) assert.ok(visibleWidth(line) <= width, `${name}: ${width}x${height}`);
				if (!lines[0].includes("Resize") && width >= 20) {
					assert.ok(lines.some((line) => line.includes(CURSOR_MARKER)));
					assert.match(lines.join("\n"), /★/);
					if (favoriteError) assert.match(lines.join("\n"), /Favorites/);
				}
			}
			component.handleInput("界😀é".repeat(40));
			component.handleInput("\x1b[D");
			assert.ok(component.render(25).every((line) => visibleWidth(line) <= 25));
		}
	}
});

for (const name of ["dark", "light"]) test(`real ${name} theme aligns separate selection/favorite/current marker cells`, async () => {
	const { ModelPickerComponent } = await import("../component.ts");
	const themes = await import(new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
	const theme = themes.getThemeByName(name);
	assert.ok(theme);
	assert.equal(visibleWidth("›"), 1);
	assert.equal(visibleWidth("★"), 1);
	const target = model("p", "target"), other = model("p", "other");
	for (const vimMode of [false, true]) for (const width of [20, 25, 63, 64, 100]) for (const active of [false, true]) for (const favorite of [false, true]) for (const current of [false, true]) {
		const component = new ModelPickerComponent({ models: [target, other], current: current ? target : undefined,
			favorites: favorite ? ["p/target"] : [], scoped: false, vimMode, theme, keybindings: keys(),
			getHeight: () => 16, onChange() {}, onSelect() {}, onCancel() {},
		});
		component.render(width);
		if ((component.getSelectedModel() === target) !== active) component.handleInput("\x1b[B");
		const lines = component.render(width);
		assert.ok(lines.some((line) => line.includes("\x1b[")), "exercise actual theme styling");
		assert.ok(lines.every((line) => visibleWidth(line) <= width), `${name}, width ${width}`);
		const plain = lines.map(stripVTControlCharacters);
		const bodies = plain.map((line) => width >= 24 ? line.slice(2, -2) : line);
		const rows = bodies.map((line) => width >= 64 ? line.split(" │ ").at(-1)! : line);
		const targetRow = rows.find((line) => line.includes("p/target"))!;
		const otherRow = rows.find((line) => line.includes("p/other"))!;
		const prefix = `${active ? "›" : " "} ${favorite ? "★" : " "}${current ? "*" : " "} `;
		assert.equal(targetRow.slice(0, 5), prefix);
		assert.equal(otherRow.slice(0, 5), `${active ? " " : "›"}    `);
		for (const [row, label] of [[targetRow, "p/target"], [otherRow, "p/other"]]) {
			assert.equal(visibleWidth(row.slice(0, row.indexOf(label))), 5, "fixed model label column");
		}
		assert.doesNotMatch(plain.join("\n"), /›[★*]|❯/, "cursor never fuses with status markers");
		component.handleInput("\t");
		const providerLines = component.render(width);
		assert.ok(providerLines.every((line) => visibleWidth(line) <= width));
		const providers = providerLines.map(stripVTControlCharacters)
			.map((line) => width >= 24 ? line.slice(2, -2) : line)
			.map((line) => width >= 64 ? line.split(" │ ")[0] : line);
		for (const label of ["All", "Favorites", "p"]) {
			const row = providers.find((line) => line.includes(`${label} (`))!;
			assert.equal(row.slice(0, 2), label === "All" ? "› " : "  ");
			assert.equal(visibleWidth(row.slice(0, row.indexOf(label))), 2, "fixed provider label column");
		}
		component.dispose();
	}
});

test("real open restores legacy order inside session catalogue; toggles reread disk and reopen reflects changes", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "picker-legacy-open-"));
	isolateAgentDir(t, root); t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "model-favorites.json");
	const a = model("alpha", "vendor/shared"), b = model("beta", "vendor/shared"), outside = model("outside", "model");
	writeFileSync(path, JSON.stringify({ favorites: ["outside/model", "beta/vendor/shared", "alpha/vendor/shared"], extra: [1] }));
	const loaded = await discoverAndLoadExtensions([extensionFixture(root)], root, root);
	const { plainTheme } = await import("./fixtures.ts");
	let component: any;
	const context = { mode: "tui", hasUI: true, cwd: root, model: outside, scopedModels: [{ model: a }, { model: b }],
		modelRegistry: { getAvailable: () => { throw Error("must not expand catalogue"); } },
		ui: { custom: (make: Function) => new Promise((done) => {
			component = make({ terminal: { columns: 100, rows: 20 }, requestRender() {} }, plainTheme, keys(), done);
			component.render(100);
		}), notify() {} },
	};
	const command = loaded.extensions[0].commands.get("model-picker")!.handler;
	const running = command("", context as never);
	assert.equal(component.getSelectedModel(), b);
	assert.doesNotMatch(component.render(100).join("\n"), /outside/);
	writeFileSync(path, JSON.stringify({ favorites: ["outside/model", "beta/vendor/shared"], extra: [2] }));
	component.handleInput("\x06");
	assert.equal(component.getSelectedModel(), b);
	assert.doesNotMatch(component.render(100).join("\n"), /★/);
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { favorites: ["outside/model"], extra: [2] });
	component.handleInput("\x1b"); await running;
	writeFileSync(path, JSON.stringify({ favorites: ["alpha/vendor/shared", "beta/vendor/shared"] }));
	const reopened = command("", { ...context, model: b } as never);
	assert.equal(component.getSelectedModel(), b, "current favorite wins preselection even when not first");
	assert.match(component.render(100).join("\n"), /› ★\* beta\/vendor\/shared/);
	component.handleInput("\x1b"); await reopened;
});

test("invalid favorite load and toggle do not prevent real default save or change favorite bytes", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "picker-invalid-favorite-save-"));
	isolateAgentDir(t, root); t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "model-favorites.json"), bytes = '{"favorites":[2]}\n';
	writeFileSync(path, bytes);
	const loaded = await discoverAndLoadExtensions([extensionFixture(root)], root, root);
	const { plainTheme } = await import("./fixtures.ts");
	const chosen = model("beta", "shared");
	loaded.runtime.setModel = async () => true;
	const notices: string[] = [];
	await loaded.extensions[0].commands.get("model-picker")!.handler("", {
		mode: "tui", hasUI: true, cwd: root, model: chosen, scopedModels: [], isProjectTrusted: () => false,
		modelRegistry: { getAvailable: () => [chosen] },
		ui: { custom: (make: Function) => new Promise((done) => {
			const component = make({ terminal: { columns: 80, rows: 12 }, requestRender() {} }, plainTheme, keys(), done);
			assert.match(component.render(80).join("\n"), /Favorites:/);
			component.handleInput("\x06");
			assert.doesNotMatch(component.render(80).join("\n"), /★/);
			component.handleInput("\r");
		}), notify: (message: string) => notices.push(message) },
	} as never);
	assert.match(notices.at(-1)!, /saved global default/);
	assert.equal(readFileSync(path, "utf8"), bytes);
	assert.equal(JSON.parse(readFileSync(join(root, "settings.json"), "utf8")).defaultModel, "shared");
});
