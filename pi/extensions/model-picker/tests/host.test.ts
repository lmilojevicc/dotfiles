import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createEventBus, CustomEditor, discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { Container, Text, TuiMainScreen, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { model } from "./fixtures.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const pickerPath = fileURLToPath(new URL("../index.ts", import.meta.url));
const prefixPath = fileURLToPath(new URL("../../prefix-keybinds/index.ts", import.meta.url));
// Test-only host access: run installed methods, never patch their prototypes.
const { InteractiveMode } = await import(new URL("./modes/interactive/interactive-mode.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
const { KeybindingsManager } = await import(new URL("./core/keybindings.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
const themes = await import(new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);

async function hostFixture(t: test.TestContext, prefix = false) {
	const root = mkdtempSync(join(tmpdir(), "picker-host-regression-"));
	const previous = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_PREFIX_KEYBINDS_CONFIG: process.env.PI_PREFIX_KEYBINDS_CONFIG };
	process.env.HOME = root;
	process.env.PI_CODING_AGENT_DIR = root;
	process.env.PI_PREFIX_KEYBINDS_CONFIG = join(root, "prefix.json");
	writeFileSync(join(root, "prefix.json"), '{"prefixKey":"ctrl+q"}');
	mkdirSync(join(root, "project"));
	writeFileSync(join(root, "settings.json"), '{"theme":"dark"}');
	const favoriteBytes = '{"favorites":["provider/model-05","provider/model-17","unavailable/model"],"extra":true}\n';
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
	const entries = Array.from({ length: 30 }, (_, i) => model("provider", `model-${String(i).padStart(2, "0")}`));
	let component: Component | undefined;
	let completion: Promise<unknown> | undefined;
	let factory: any = () => editor;
	const notifications: string[] = [];
	let onNotice: () => void = () => {};
	const notified = new Promise<void>((resolve) => { onNotice = resolve; });
	const context = {
		mode: "tui", hasUI: true, cwd: join(root, "project"), model: entries[17], scopedModels: [],
		isProjectTrusted: () => false,
		modelRegistry: { getAvailable: () => entries },
		ui: {
			theme: themes.theme,
			custom: (make: Function, options: unknown) => {
				assert.equal((options as { overlay: boolean }).overlay, true);
				completion = InteractiveMode.prototype.showExtensionCustom.call(host, (...args: unknown[]) => {
					component = make(...args);
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
		component: () => component!, completion: () => completion, submissions: () => submissions, changes: () => editorChanges };
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
	f.terminal.columns = 25; f.terminal.rows = 4; f.resize(); await f.render();
	assertVisible();
	assert.match(f.screen().at(-1)!, /Enter save Esc close/);
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
