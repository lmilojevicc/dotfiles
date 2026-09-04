import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createEventBus, CustomEditor, discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { Container, CURSOR_MARKER, Text, TuiMainScreen, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { model } from "./fixtures.ts";
import type { ModelPickerComponent } from "../component.ts";
import type { PickerModel } from "../domain.ts";
import { favoriteKey } from "../favorites.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const pickerPath = fileURLToPath(new URL("../index.ts", import.meta.url));
const prefixPath = fileURLToPath(new URL("../../prefix-keybinds/index.ts", import.meta.url));
// Test-only host access: run installed methods, never patch their prototypes.
const { InteractiveMode } = await import(new URL("./modes/interactive/interactive-mode.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
const { KeybindingsManager } = await import(new URL("./core/keybindings.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
const themes = await import(new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);

async function hostFixture(t: test.TestContext, prefix = false, options: {
	models?: PickerModel[]; favorites?: string[]; scoped?: boolean; current?: PickerModel;
} = {}) {
	const root = mkdtempSync(join(tmpdir(), "picker-host-regression-"));
	const previous = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_PREFIX_KEYBINDS_CONFIG: process.env.PI_PREFIX_KEYBINDS_CONFIG };
	process.env.HOME = root;
	process.env.PI_CODING_AGENT_DIR = root;
	process.env.PI_PREFIX_KEYBINDS_CONFIG = join(root, "prefix.json");
	writeFileSync(join(root, "prefix.json"), '{"prefixKey":"ctrl+q"}');
	mkdirSync(join(root, "project"));
	writeFileSync(join(root, "settings.json"), '{"theme":"dark"}');
	const favoriteBytes = JSON.stringify({ favorites: options.favorites ?? ["provider/model-05", "provider/model-17", "unavailable/model"], extra: true }) + "\n";
	writeFileSync(join(root, "model-favorites.json"), favoriteBytes);
	const bus = createEventBus();
	const loaded = await discoverAndLoadExtensions(prefix ? [pickerPath, prefixPath] : [pickerPath], join(root, "project"), root, bus);
	assert.deepEqual(loaded.errors, []);
	themes.initTheme("dark", false);
	let input: (data: string) => void = () => {};
	let resize: () => void = () => {};
	const terminal = {
		columns: 80, rows: 24, kittyProtocolActive: false,
		start: (onInput: typeof input, onResize: typeof resize) => { input = onInput; resize = onResize; },
		stop() {}, drainInput: async () => {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {},
		clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
	};
	const tui = new TuiMainScreen(terminal);
	const kb = new KeybindingsManager();
	const editor = new CustomEditor(tui, themes.getEditorTheme(), kb);
	const paste = Array.from({ length: 16 }, (_, i) => `expanded paste content ${i}`).join("\n");
	editor.setText("unsent draft\n");
	editor.handleInput(`\x1b[200~${paste}\x1b[201~`);
	const draft = editor.getExpandedText();
	assert.ok(draft.includes(paste));
	assert.notEqual(editor.getText(), draft, "fixture must exercise the real collapsed paste store");
	const editorContainer = new Container(); editorContainer.addChild(editor);
	// Same regular-mode ordering as InteractiveMode.mountInteractiveTui: transcript, editor, below widgets, footer.
	tui.addChild(new Text(Array.from({ length: 30 }, (_, i) => `transcript ${i}`).join("\n"), 0, 0));
	tui.addChild(editorContainer);
	tui.addChild(new Text(Array.from({ length: 10 }, (_, i) => `below-editor widget ${i}`).join("\n"), 0, 0));
	tui.addChild(new Text("host footer", 0, 0));
	tui.setFocus(editor); tui.start();
	const host = {
		editor, defaultEditor: editor, editorContainer, ui: tui, keybindings: kb,
		session: { isStreaming: false, isCompacting: false, prompt: async () => { throw Error("must not submit commands"); } },
		updatePendingMessagesDisplay() {},
	};
	InteractiveMode.prototype.setupEditorSubmitHandler.call(host);
	let submissions = 0, editorChanges = 0;
	const submit = editor.onSubmit!;
	editor.onSubmit = (text) => { submissions++; return submit(text); };
	editor.onChange = () => { editorChanges++; };
	const entries = options.models ?? Array.from({ length: 30 }, (_, i) => model("provider", `model-${String(i).padStart(2, "0")}`));
	let component: Component | undefined;
	let renderedLines: string[] = [], renderedWidth = 0;
	let completion: Promise<unknown> | undefined;
	let factory: any = () => editor;
	const notifications: string[] = [];
	let onNotice: () => void = () => {};
	const notified = new Promise<void>((resolve) => { onNotice = resolve; });
	const context = {
		mode: "tui", hasUI: true, cwd: join(root, "project"), model: options.current ?? entries[17],
		scopedModels: options.scoped ? entries.map((model) => ({ model })) : [],
		isProjectTrusted: () => false,
		modelRegistry: { getAvailable: () => entries },
		ui: {
			theme: themes.theme,
			custom: (make: Function, options: unknown) => {
				assert.equal((options as { overlay: boolean }).overlay, true);
				completion = InteractiveMode.prototype.showExtensionCustom.call(host, (...args: unknown[]) => {
					component = make(...args);
					const render = component!.render.bind(component);
					component!.render = (width) => { renderedWidth = width; renderedLines = render(width); return renderedLines; };
					return component;
				}, options);
				return completion;
			},
			notify: (message: string) => { notifications.push(message); onNotice(); },
			setStatus() {}, setWidget() {},
			getEditorComponent: () => factory,
			setEditorComponent: (next: any) => { factory = next; factory(tui, themes.getEditorTheme(), kb); },
			setEditorText: (text: string) => editor.setText(text),
		},
	};
	const lifecycle = async (event: "session_start" | "session_shutdown") => {
		for (const extension of loaded.extensions) for (const handler of extension.handlers.get(event) ?? []) await handler({ type: event, reason: event === "session_start" ? "startup" : "quit" } as never, context as never);
	};
	t.after(async () => {
		await lifecycle("session_shutdown");
		(editor as CustomEditor & { dispose?: () => void }).dispose?.();
		tui.stop(); bus.clear();
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	});
	const render = async () => { await tick(); tui.requestRender(true); await tick(); };
	const screen = () => tui.captureRenderState().previousLines.slice(-terminal.rows);
	const activatePrefix = async () => {
		input("\x11"); input("m"); await render();
	};
	return { root, favoriteBytes, bus, loaded, context, host, editor, draft, terminal, tui, notifications, notified, entries, lifecycle, render, screen,
		input: (data: string) => input(data), resize: () => resize(), activatePrefix,
		frameLines: () => renderedLines, renderedWidth: () => renderedWidth,
		component: () => component! as ModelPickerComponent, completion: () => completion, submissions: () => submissions, changes: () => editorChanges };
}

test("actual host overlay composition keeps search, cursor and selected row visible above ten below-editor lines", async (t) => {
	const f = await hostFixture(t);
	const running = f.loaded.extensions[0].commands.get("model-picker")!.handler("", f.context as never);
	await f.render();
	const assertVisible = () => {
		const lines = f.screen();
		assert.match(lines.join("\n"), /Search:/);
		assert.match(lines.join("\n"), /★\* provider\/model-17/);
		assert.ok(lines.every((line) => visibleWidth(line) <= f.terminal.columns));
		const state = f.tui.captureRenderState();
		const cursorRow = state.hardwareCursorRow - state.previousViewportTop;
		assert.ok(cursorRow >= 0 && cursorRow < f.terminal.rows);
		assert.match(lines[cursorRow], /Search:/);
	};
	assertVisible();
	assert.match(f.tui.render(80).join("\n"), /below-editor widget 9/);
	assert.equal(f.renderedWidth(), 76, "95% inset width, not terminal columns");
	const wide = f.screen().map(stripVTControlCharacters);
	assert.ok(wide.find((line) => line.includes("╭"))!.indexOf("╭") > 0);
	assert.ok(f.frameLines().length <= 20, "85% of 24 rows");
	f.terminal.columns = 25; f.terminal.rows = 6; f.resize(); await f.render();
	assertVisible();
	assert.match(f.screen().join("\n"), /Enter save.*Esc close/);
	f.terminal.rows = 4; f.resize(); await f.render();
	assert.match(f.screen().join("\n"), /Resize required/);
	const favoriteBytes = readFileSync(join(f.root, "model-favorites.json"), "utf8");
	f.input("\x06"); f.input("\r"); f.input(down);
	assert.equal(readFileSync(join(f.root, "model-favorites.json"), "utf8"), favoriteBytes);
	assert.equal(f.component().getSelectedModel(), f.entries[17]);
	f.terminal.rows = 1; f.resize(); await f.render();
	assert.match(f.screen().join("\n"), /Resize required/);
	f.input("\x1b[B"); f.input("\r");
	f.terminal.columns = 80; f.terminal.rows = 24; f.resize(); await f.render();
	assertVisible();
	f.input("\x1b"); await running;
	assert.equal(f.editor.getExpandedText(), f.draft);
	assert.equal(f.changes(), 0);
});

for (const state of ["streaming", "compacting"] as const) {
	for (const outcome of ["cancel", "confirm", "switch-error", "open-error", "favorite-toggle"] as const) {
		test(`real prefix event + host overlay preserves expanded draft while ${state}: ${outcome}`, async (t) => {
			const f = await hostFixture(t, true);
			f.host.session.isStreaming = state === "streaming";
			f.host.session.isCompacting = state === "compacting";
			let switches = 0;
			f.loaded.runtime.setModel = async () => { switches++; if (outcome === "switch-error") throw Error("switch failed"); return true; };
			if (outcome === "open-error") f.context.modelRegistry.getAvailable = () => { throw Error("catalogue failed"); };
			await f.lifecycle("session_start");
			await new Promise((resolve) => setTimeout(resolve, 10)); // prefix's documented deferred editor install
			await f.activatePrefix();
			assert.equal(f.editor.getExpandedText(), f.draft);
			if (outcome !== "open-error") {
				if (outcome === "favorite-toggle") {
					f.input("\x06"); await f.render();
					assert.equal(f.editor.getExpandedText(), f.draft);
				}
				f.input(outcome === "cancel" || outcome === "favorite-toggle" ? "\x1b" : "\r");
				await f.completion(); await tick();
			}
			// Wait for persistence/error reporting, not just the modal's close callback.
			if (outcome !== "cancel" && outcome !== "favorite-toggle") await f.notified;
			if (outcome === "favorite-toggle") assert.deepEqual(JSON.parse(readFileSync(join(f.root, "model-favorites.json"), "utf8")).favorites, ["provider/model-05", "unavailable/model"]);
			else assert.equal(readFileSync(join(f.root, "model-favorites.json"), "utf8"), f.favoriteBytes);
			assert.equal(f.submissions(), 0, "the installed host submit/clear branch must never run");
			assert.equal(f.changes(), 0, "neither opening nor closing/restoring may touch the editor");
			assert.equal(f.editor.getExpandedText(), f.draft);
			assert.equal(switches, outcome === "confirm" || outcome === "switch-error" ? 1 : 0);
			if (outcome === "confirm") {
				assert.equal(JSON.parse(readFileSync(join(f.root, "settings.json"), "utf8")).defaultModel, "model-17");
				assert.match(f.notifications.at(-1)!, /saved global default/);
			} else if (outcome === "switch-error") assert.match(f.notifications.at(-1)!, /active model may have changed/);
			else if (outcome === "open-error") assert.match(f.notifications.at(-1)!, /Cannot open model picker: catalogue failed/);
		});
	}
}

test("overlay close never overwrites text changed meanwhile; session shutdown removes event listener", async (t) => {
	const f = await hostFixture(t, true);
	await f.lifecycle("session_start");
	await new Promise((resolve) => setTimeout(resolve, 10));
	await f.activatePrefix();
	f.editor.setText("newer user text");
	f.input("\x1b"); await f.completion(); await tick();
	assert.equal(f.editor.getExpandedText(), "newer user text");
	assert.equal(f.changes(), 1);
	await f.lifecycle("session_shutdown");
	let acknowledged = false;
	f.bus.emit("model-picker:open", () => { acknowledged = true; });
	assert.equal(acknowledged, false, "picker subscription must be removed, not just the prefix disabled");
	await f.activatePrefix();
	assert.match(f.notifications.at(-1)!, /unavailable/);
	assert.equal(f.submissions(), 0);
	assert.equal(f.editor.getText(), "newer user text");
});

test("repeated session start keeps one listener and shutdown cancels an open picker without mutation", async (t) => {
	const f = await hostFixture(t);
	let switches = 0;
	f.loaded.runtime.setModel = async () => { switches++; return true; };
	await f.lifecycle("session_start"); await f.lifecycle("session_start");
	let acknowledged = 0;
	f.bus.emit("model-picker:open", () => { acknowledged++; });
	await f.render();
	assert.equal(acknowledged, 1);
	await f.lifecycle("session_shutdown");
	await f.completion(); await tick();
	f.component().handleInput?.("\r");
	assert.equal(switches, 0);
	assert.equal(f.editor.getExpandedText(), f.draft);
	assert.equal(f.changes(), 0);
});

test("real event bus without picker listener warns without touching draft", async (t) => {
	const f = await hostFixture(t, true);
	await f.lifecycle("session_start");
	await new Promise((resolve) => setTimeout(resolve, 10));
	f.bus.clear();
	await f.activatePrefix();
	assert.match(f.notifications.at(-1)!, /unavailable/);
	assert.equal(f.submissions(), 0);
	assert.equal(f.changes(), 0);
	assert.equal(f.editor.getExpandedText(), f.draft);
});

const down = "\x1b[B", up = "\x1b[A";
async function enterFavorites(f: Awaited<ReturnType<typeof hostFixture>>) {
	f.input("\t"); f.input(down); f.input("\t"); await f.render();
	assert.deepEqual(f.component().getScope(), { kind: "favorites" });
}
const frame = (f: Awaited<ReturnType<typeof hostFixture>>) =>
	f.frameLines().map((line) => stripVTControlCharacters(line.replaceAll(CURSOR_MARKER, ""))).join("\n");

test("Favorites sidebar order/counts, query and session intersection survive provider-name collisions", async (t) => {
	const a = model("alpha", "vendor/shared"), b = model("opencode", "vendor/shared");
	const collision = model("favorites", "vendor/shared"), all = model("All", "other");
	const f = await hostFixture(t, false, {
		models: [a, b, collision, all], scoped: true, current: a,
		favorites: ["outside/model", favoriteKey(b), favoriteKey(a)],
	});
	f.context.modelRegistry.getAvailable = () => { throw Error("must not expand session catalogue"); };
	const running = f.loaded.extensions[0].commands.get("model-picker")!.handler("", f.context as never);
	await f.render();
	const sidebar = () => frame(f).split("\n").filter((line) => line.includes(" │ ")).map((line) => line.split(" │ ")[0].replace(/^│ /, "").trim());
	assert.deepEqual(sidebar(), ["› All (4)", "Favorites (2)", "All (1)", "alpha (1)", "favorites (1)", "opencode (1)"]);
	f.input("shared"); await f.render();
	assert.deepEqual(sidebar(), ["› All (3)", "Favorites (2)", "All (0)", "alpha (1)", "favorites (1)", "opencode (1)"]);
	await enterFavorites(f);
	assert.equal(f.component().getQuery(), "shared");
	assert.equal(f.component().getSelectedModel(), a, "preserve matching current identity when entering Favorites");
	let rendered = frame(f);
	assert.ok(rendered.indexOf("opencode/vendor/shared") < rendered.indexOf("alpha/vendor/shared"), "stored order, not current order");
	assert.doesNotMatch(rendered, /outside|favorites\/vendor\/shared/);
	assert.ok(rendered.split("\n").every((line) => visibleWidth(line) <= 80));
	assert.ok(rendered.split("\n").length <= 24);
	t.diagnostic(`Favorites wide 80x24:\n${rendered}`);
	f.terminal.columns = 40; f.terminal.rows = 8; f.resize(); await f.render();
	rendered = frame(f);
	assert.equal((rendered.match(/Favorites/g) ?? []).length, 1);
	assert.match(rendered, /^Favorites \[session\]/);
	assert.match(rendered, /opencode\/vendor\/shared/);
	assert.match(rendered, /alpha\/vendor\/shared/);
	assert.ok(rendered.split("\n").every((line) => visibleWidth(line) <= 40));
	assert.ok(rendered.split("\n").length <= 8);
	t.diagnostic(`Favorites narrow 40x8:\n${rendered}`);
	f.input("\t"); f.input(down); // actual provider named All
	assert.deepEqual(f.component().getScope(), { kind: "provider", provider: "All" });
	assert.equal(f.component().getSelectedModel(), undefined);
	f.input(down); f.input(down); f.input("\t"); await f.render();
	assert.deepEqual(f.component().getScope(), { kind: "provider", provider: "favorites" });
	assert.equal(f.component().getSelectedModel(), collision);
	assert.match(frame(f), /vendor\/shared/);
	assert.doesNotMatch(frame(f), /favorites\/vendor\/shared|★/);
	f.input("\t"); for (let i = 0; i < 4; i++) f.input(up);
	f.input("\t"); await f.render();
	assert.deepEqual(f.component().getScope(), { kind: "all" });
	assert.equal(f.component().getSelectedModel(), b, "empty intermediate scope resets to first favorite, then All retains it");
	assert.equal(f.component().getQuery(), "shared");
	assert.match(frame(f), /favorites\/vendor\/shared/);
	f.input("\x1b"); f.input("\x1b"); await running;
	assert.equal(readFileSync(join(f.root, "model-favorites.json"), "utf8"), f.favoriteBytes);
});

test("Favorites keeps search tiers primary and stored order within a tier", async (t) => {
	const weak = model("alpha", "s-h-a-r-e-d-long"), exact = model("beta", "shared"), other = model("opencode", "vendor/shared");
	const f = await hostFixture(t, false, { models: [weak, exact, other], favorites: [weak, other, exact].map(favoriteKey) });
	const running = f.loaded.extensions[0].commands.get("model-picker")!.handler("", f.context as never);
	await f.render(); await enterFavorites(f);
	assert.equal(f.component().getSelectedModel(), weak);
	f.input("shared"); await f.render();
	assert.equal(f.component().getSelectedModel(), exact);
	const rendered = frame(f);
	assert.ok(rendered.indexOf("beta/shared") < rendered.indexOf("alpha/s-h-a-r-e-d-long"));
	assert.ok(rendered.indexOf("alpha/s-h-a-r-e-d-long") < rendered.indexOf("opencode/vendor/shared"));
	assert.match(rendered, /Favorites \(3\)/);
	f.input("\x1b"); f.input("\x1b"); await running;
});

test("Favorites removal chooses next then previous, stays empty, and guards unpainted toggles/confirmation", async (t) => {
	const a = model("alpha", "vendor/shared"), b = model("beta", "vendor/shared"), c = model("opencode", "vendor/shared");
	const f = await hostFixture(t, false, { models: [a, b, c], favorites: [a, b, c].map(favoriteKey), current: b });
	let switches = 0;
	f.loaded.runtime.setModel = async () => { switches++; return true; };
	const running = f.loaded.extensions[0].commands.get("model-picker")!.handler("", f.context as never);
	await f.render(); await enterFavorites(f);
	f.input("shared"); await f.render();
	for (const [removed, next, count] of [[b, c, 2], [c, a, 1], [a, undefined, 0]] as const) {
		assert.equal(f.component().getSelectedModel(), removed);
		f.input("\x06");
		assert.equal(f.component().getSelectedModel(), next);
		const saved = readFileSync(join(f.root, "model-favorites.json"), "utf8");
		f.input("\x06"); f.input("\r"); // no new paint: neither action may use the old identity
		assert.equal(switches, 0);
		assert.equal(readFileSync(join(f.root, "model-favorites.json"), "utf8"), saved);
		await f.render();
		assert.deepEqual(f.component().getScope(), { kind: "favorites" });
		assert.equal(f.component().getQuery(), "shared");
		assert.match(frame(f), new RegExp(`Favorites \\(${count}\\)`));
		assert.doesNotMatch(frame(f), new RegExp(`${removed.provider}/vendor/shared`));
	}
	assert.match(frame(f), /No favorites yet/);
	f.input("\x06"); f.input("\r"); await f.render();
	assert.equal(switches, 0);
	assert.deepEqual(JSON.parse(readFileSync(join(f.root, "model-favorites.json"), "utf8")).favorites, []);
	f.input("\x1b"); f.input("\x1b"); await running;
	assert.equal(f.editor.getExpandedText(), f.draft);
});

test("Favorites adjacent selection confirms only after paint and persists the paired global default", async (t) => {
	const a = model("alpha", "shared"), b = model("beta", "shared");
	const f = await hostFixture(t, false, { models: [a, b], favorites: [a, b].map(favoriteKey) });
	const switched: PickerModel[] = [];
	f.loaded.runtime.setModel = async (chosen) => { switched.push(chosen); return true; };
	const running = f.loaded.extensions[0].commands.get("model-picker")!.handler("", f.context as never);
	await f.render(); await enterFavorites(f);
	f.input("\x06"); f.input("\r");
	assert.deepEqual(switched, []);
	await f.render(); f.input("\r"); await running;
	assert.deepEqual(switched, [b]);
	const settings = JSON.parse(readFileSync(join(f.root, "settings.json"), "utf8"));
	assert.equal(settings.defaultProvider, "beta"); assert.equal(settings.defaultModel, "shared");
	assert.equal(settings.theme, "dark");
});

test("Favorites write failure preserves star, row, query, scope and count", async (t) => {
	const a = model("alpha", "shared");
	const f = await hostFixture(t, false, { models: [a], favorites: [favoriteKey(a)] });
	const running = f.loaded.extensions[0].commands.get("model-picker")!.handler("", f.context as never);
	await f.render(); await enterFavorites(f);
	f.input("shared"); await f.render();
	const path = join(f.root, "model-favorites.json");
	chmodSync(path, 0o400);
	f.input("\x06"); await f.render();
	assert.equal(readFileSync(path, "utf8"), f.favoriteBytes);
	assert.equal(f.component().getSelectedModel(), a);
	assert.equal(f.component().getQuery(), "shared");
	assert.deepEqual(f.component().getScope(), { kind: "favorites" });
	assert.match(frame(f), /Favorites \(1\)/);
	assert.match(frame(f), /›★  alpha\/shared/);
	assert.match(frame(f), /Favorites:.*read-only/);
	chmodSync(path, 0o600);
	f.input("\x06"); await f.render();
	assert.match(frame(f), /No favorites yet/);
	assert.doesNotMatch(frame(f), /read-only|★/);
	f.input("\x1b"); f.input("\x1b"); await running;
});

for (const favorites of [[], ["unavailable/model"], ["alpha/shared"]]) test(`Favorites empty versus query-no-match: ${JSON.stringify(favorites)}`, async (t) => {
	const f = await hostFixture(t, false, { models: [model("alpha", "shared"), model("beta", "other")], favorites });
	const running = f.loaded.extensions[0].commands.get("model-picker")!.handler("", f.context as never);
	await f.render(); await enterFavorites(f);
	if (!favorites.includes("alpha/shared")) assert.match(frame(f), /No favorites yet/);
	f.input("other"); await f.render();
	assert.equal(f.component().getSelectedModel(), undefined);
	assert.match(frame(f), /All \(1\)/); assert.match(frame(f), /Favorites \(0\)/);
	assert.match(frame(f), favorites.includes("alpha/shared") ? /No matching models/ : /No favorites yet/);
	f.input("\x06"); f.input("\r");
	assert.deepEqual(f.component().getScope(), { kind: "favorites" });
	f.input("\x1b"); f.input("\x1b"); await running;
	assert.equal(readFileSync(join(f.root, "model-favorites.json"), "utf8"), f.favoriteBytes);
});

test("actual inset host guards raw resize before repaint, then reveals selection with correct page stride", async (t) => {
	const f = await hostFixture(t);
	let switches = 0;
	f.loaded.runtime.setModel = async () => { switches++; return true; };
	const running = f.loaded.extensions[0].commands.get("model-picker")!.handler("", f.context as never);
	await f.render();
	const selected = f.component().getSelectedModel();
	const bytes = readFileSync(join(f.root, "model-favorites.json"), "utf8");
	// Both heights produce a 22-row component cap: raw rows must still guard stale input.
	f.terminal.rows = 40; f.resize(); await f.render();
	f.terminal.rows = 41;
	for (const key of [down, "\x06", "\r", "query", "\t"]) f.input(key);
	assert.equal(f.component().getSelectedModel(), selected);
	assert.equal(f.component().getQuery(), "");
	assert.equal(f.component().getPane(), "models");
	assert.equal(switches, 0);
	assert.equal(readFileSync(join(f.root, "model-favorites.json"), "utf8"), bytes);
	f.resize(); await f.render();
	// Width is also raw columns, not the 95% rendered width.
	f.terminal.columns = 40;
	f.input(down); f.input("\x06"); f.input("\r");
	assert.equal(f.component().getSelectedModel(), selected);
	assert.equal(switches, 0);
	f.terminal.rows = 16; f.resize(); await f.render();
	assert.equal(f.renderedWidth(), 38);
	assert.ok(f.frameLines().length <= 13);
	assert.match(f.screen().join("\n"), /model-17/);
	assert.match(f.screen().join("\n"), /Enter save.*Esc close/);
	const pageRows = f.frameLines().filter((line) => /model-\d+/.test(line)).length;
	f.input("\x1b[6~"); await f.render();
	// Favorites model-05/model-17 precede model-00,01,02,... in this fixture.
	assert.equal(f.component().getSelectedModel(), f.entries[pageRows - 1]);
	const state = f.tui.captureRenderState();
	assert.match(f.screen()[state.hardwareCursorRow - state.previousViewportTop], /Search:/);
	f.input("\x1b"); await running;
	f.component().handleInput?.("\x06"); f.component().handleInput?.("\r");
	assert.equal(switches, 0);
	assert.equal(f.editor.getExpandedText(), f.draft);
	assert.equal(readFileSync(join(f.root, "model-favorites.json"), "utf8"), bytes);
});

test("actual centered overlay does not shift on scrolled favorite toggles or emptying Favorites", async (t) => {
	const f = await hostFixture(t);
	const running = f.loaded.extensions[0].commands.get("model-picker")!.handler("", f.context as never);
	await f.render();
	f.input("\x1b[6~"); f.input("\x1b[6~"); await f.render();
	const modelRows = () => f.screen().map((line, row) => ({ line: stripVTControlCharacters(line), row }))
		.filter(({ line }) => /provider\/model-\d+/.test(line))
		.map(({ line, row }) => ({ line: line.split(" │ ").at(-1)!.replaceAll("★", " "), row }));
	const before = modelRows();
	for (let i = 0; i < 3; i++) {
		f.input("\x06"); await f.render();
		assert.deepEqual(modelRows(), before, "host-composited row positions and sequence stay fixed");
	}
	await enterFavorites(f);
	const top = () => f.screen().findIndex((line) => line.includes("╭"));
	const bottom = () => f.screen().findIndex((line) => line.includes("╰"));
	const bounds = [top(), bottom()];
	while (f.component().getSelectedModel()) {
		f.input("\x06"); await f.render();
		assert.deepEqual([top(), bottom()], bounds, "empty membership must not move the centered overlay");
	}
	assert.match(f.screen().join("\n"), /No favorites yet/);
	assert.deepEqual(f.component().getScope(), { kind: "favorites" });
	f.input(down); f.input("\r"); f.input("\x06");
	assert.deepEqual(f.component().getScope(), { kind: "favorites" });
	f.input("\x1b"); await running;
	assert.equal(f.editor.getExpandedText(), f.draft);
});
