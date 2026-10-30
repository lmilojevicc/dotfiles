import assert from "node:assert/strict";
import test from "node:test";
import {
	CURSOR_MARKER,
	Editor,
	type EditorTheme,
	type Terminal,
	TuiMainScreen,
	visibleWidth,
} from "@earendil-works/pi-tui";

import { createEditorFocus, type EditorFactory, FOCUS_IN, FOCUS_OUT, type Scheduler } from "../editor-focus.ts";

function manualScheduler() {
	let nextId = 0;
	const pending = new Map<number, () => void>();
	const scheduler: Scheduler = {
		setTimeout(callback) {
			const id = ++nextId;
			pending.set(id, callback);
			return id;
		},
		clearTimeout(handle) {
			pending.delete(handle as number);
		},
	};
	return {
		scheduler,
		runAll() {
			for (const [id, callback] of [...pending]) {
				pending.delete(id);
				callback();
			}
		},
		pending,
	};
}

function fakeEditor(lines: string[]) {
	const inputs: string[] = [];
	const renderFocused: boolean[] = [];
	let invalidations = 0;
	let disposed = 0;
	const editor = {
		focused: true,
		render() {
			renderFocused.push(editor.focused);
			return lines;
		},
		handleInput(data: string) {
			inputs.push(data);
		},
		invalidate() {
			invalidations += 1;
		},
		dispose() {
			disposed += 1;
		},
	};
	return { editor, inputs, renderFocused, invalidations: () => invalidations, disposed: () => disposed };
}

test("deferred install composes the editor factory present when the timer fires", () => {
	const clock = manualScheduler();
	const fallback = fakeEditor(["fallback"]);
	const focus = createEditorFocus({
		createDefaultEditor: () => fallback.editor as never,
		scheduler: clock.scheduler,
	});
	const first = fakeEditor(["first"]);
	const latest = fakeEditor(["\x1b[7mcursor\x1b[0m and \x1b[7mother\x1b[27m"]);
	let currentFactory: (() => unknown) | undefined = () => first.editor;
	let installedFactory: ((...args: never[]) => unknown) | undefined;
	const ui = {
		getEditorComponent: () => currentFactory as never,
		setEditorComponent(factory: (...args: never[]) => unknown) {
			installedFactory = factory;
			currentFactory = factory;
		},
	};

	focus.install(ui);
	currentFactory = () => latest.editor;
	assert.equal(installedFactory, undefined, "installation is deferred");
	clock.runAll();
	assert.ok(installedFactory);

	let renders = 0;
	const tui = { requestRender: () => renders++ };
	const editor = installedFactory(tui as never, {} as never, {} as never) as typeof latest.editor;
	assert.deepEqual(focus.handleTerminalInput(FOCUS_OUT), { consume: true });
	assert.equal(latest.invalidations(), 1);
	assert.equal(renders, 1);
	assert.deepEqual(editor.render(), ["cursor and other"]);
	assert.deepEqual(latest.renderFocused, [true]);
	assert.equal(editor.focused, true, "host blur does not change keyboard ownership");

	editor.handleInput("text");
	editor.handleInput(FOCUS_OUT);
	assert.deepEqual(latest.inputs, ["text"], "focus reports are consumed by the editor wrapper");
	editor.dispose();
	assert.equal(latest.disposed(), 1);
});

test("reinstall and cleanup cancel pending editor timers", () => {
	const clock = manualScheduler();
	const focus = createEditorFocus({
		createDefaultEditor: () => fakeEditor([]).editor as never,
		scheduler: clock.scheduler,
	});
	let installations = 0;
	const ui = {
		getEditorComponent: () => undefined,
		setEditorComponent: () => installations++,
	};

	focus.install(ui);
	focus.install(ui);
	assert.equal(clock.pending.size, 1, "only the latest install remains scheduled");
	focus.cleanup();
	assert.equal(clock.pending.size, 0);
	clock.runAll();
	assert.equal(installations, 0);
});

function installObservedEditor(render: (width: number) => string[], initiallyFocused = true) {
	const clock = manualScheduler();
	let focused = initiallyFocused;
	const writes: boolean[] = [];
	const editor = {
		get focused() { return focused; },
		set focused(value: boolean) { writes.push(value); focused = value; },
		render,
		handleInput(_data: string) {},
		invalidate() {},
	};
	let factory = () => editor;
	const focus = createEditorFocus({
		createDefaultEditor: () => { throw new Error("must use predecessor"); },
		scheduler: clock.scheduler,
	});
	focus.install({
		getEditorComponent: () => factory as never,
		setEditorComponent: (next) => { factory = next as never; },
	});
	clock.runAll();
	const installed = (factory as (...args: unknown[]) => typeof editor)({ requestRender() {} }, {}, {});
	assert.equal(installed, editor, "cursor decoration retains editor identity");
	return { editor, focus, writes };
}

test("host blur/refocus hides native markers and inverse cursor without any focus writes", () => {
	const source = [`draft 界 ${CURSOR_MARKER}\x1b[7m \x1b[27m`, `other ${CURSOR_MARKER}`];
	const widths: number[] = [];
	const h = installObservedEditor((width) => { widths.push(width); return source; });
	assert.equal(h.editor.render(40), source, "focused render passes through unchanged");
	h.focus.handleTerminalInput(FOCUS_OUT);
	const unfocused = h.editor.render(40);
	assert.deepEqual(unfocused, ["draft 界  ", "other "]);
	assert.deepEqual(unfocused.map(visibleWidth), source.map(visibleWidth));
	assert.ok(source[0].includes(CURSOR_MARKER), "never mutate predecessor's cached rows");
	assert.equal(h.editor.focused, true);
	h.focus.handleTerminalInput(FOCUS_IN);
	assert.equal(h.editor.render(40), source);
	assert.deepEqual(widths, [40, 40, 40]);
	assert.deepEqual(h.writes, [], "presentation-only host events must not call focused setter");
	h.focus.cleanup();
});

test("throwing render keeps exception identity and makes no host focus writes", () => {
	const failure = new Error("render failed");
	const h = installObservedEditor(() => { throw failure; });
	for (const event of [FOCUS_OUT, FOCUS_IN]) {
		h.focus.handleTerminalInput(event);
		assert.throws(() => h.editor.render(40), (error) => error === failure);
		assert.equal(h.editor.focused, true);
	}
	assert.deepEqual(h.writes, []);
	h.focus.cleanup();
});

test("real keyboard blur and ownership changes inside render are not overwritten", () => {
	const h = installObservedEditor(() => ["native unfocused"], false);
	h.focus.handleTerminalInput(FOCUS_OUT);
	assert.deepEqual(h.editor.render(40), ["native unfocused"]);
	h.focus.handleTerminalInput(FOCUS_IN);
	h.editor.render(40);
	assert.equal(h.editor.focused, false);
	assert.deepEqual(h.writes, []);
	h.focus.cleanup();

	const changed = installObservedEditor(() => {
		changed.editor.focused = false;
		return ["ownership transferred"];
	});
	changed.focus.handleTerminalInput(FOCUS_OUT);
	changed.editor.render(40);
	assert.equal(changed.editor.focused, false, "render's genuine transfer survives decoration");
	assert.deepEqual(changed.writes, [false], "only predecessor can write ownership");
	changed.focus.cleanup();
});

test("throwing predecessor's genuine ownership transfer is not restored", () => {
	const failure = new Error("transfer then fail");
	const h = installObservedEditor(() => {
		h.editor.focused = false;
		throw failure;
	});
	h.focus.handleTerminalInput(FOCUS_OUT);
	assert.throws(() => h.editor.render(40), (error) => error === failure);
	assert.equal(h.editor.focused, false);
	assert.deepEqual(h.writes, [false]);
	h.focus.cleanup();
});

const editorTheme = {
	borderColor: (text: string) => text,
	selectList: {
		selectedText: (text: string) => text,
		description: (text: string) => text,
		scrollInfo: (text: string) => text,
		noMatch: (text: string) => text,
	},
} as unknown as EditorTheme;

/** Real pi-tui editor plus the real renderer, whose terminal only records what Pi would write. */
function renderedEditor(showHardwareCursor: boolean) {
	const clock = manualScheduler();
	const writes: string[] = [];
	const terminal = {
		columns: 40,
		rows: 12,
		write: (data: string) => writes.push(data),
		hideCursor: () => writes.push("<hide>"),
		showCursor: () => writes.push("<show>"),
	} as unknown as Terminal;
	const tui = new TuiMainScreen(terminal, showHardwareCursor);
	let factory: EditorFactory | undefined;
	const focus = createEditorFocus({
		createDefaultEditor: (nextTui, theme) => new Editor(nextTui, theme),
		scheduler: clock.scheduler,
	});
	focus.install({
		getEditorComponent: () => factory,
		setEditorComponent: (next) => {
			factory = next;
		},
	});
	clock.runAll();
	assert.ok(factory, "the focus layer installed an editor factory");
	const editor = factory(tui, editorTheme, {} as never);
	tui.addChild(editor);
	editor.setText("draft 界 ok");
	// Pi's setCustomEditorComponent focuses the editor it just created.
	(editor as Editor).focused = true;
	const render = () => {
		writes.length = 0;
		tui.renderNow();
		return { lines: tui.captureRenderState().previousLines, writes: [...writes] };
	};
	return { focus, editor: editor as Editor, render };
}

test("blur removes the real editor's inverse-video cursor and refocus restores it", () => {
	const h = renderedEditor(false);
	const focused = h.render();
	assert.ok(
		focused.lines.some((line) => line.includes("\x1b[7m")),
		"pi-tui resolves the editor's fake-cursor markers to inverse video",
	);

	h.focus.handleTerminalInput(FOCUS_OUT);
	const blurred = h.render();
	assert.deepEqual(
		blurred.lines.filter((line) => line.includes("\x1b[7m")),
		[],
		"the blurred editor draws no inverse-video cursor",
	);
	assert.equal(blurred.lines.join("").includes("\x1b_pi:"), false, "no cursor marker row survives the blur");
	assert.deepEqual(
		blurred.lines.map(visibleWidth),
		focused.lines.map(visibleWidth),
		"hiding the cursor keeps line widths",
	);
	assert.equal(h.editor.getText(), "draft 界 ok");

	h.focus.handleTerminalInput(FOCUS_IN);
	assert.deepEqual(h.render().lines, focused.lines, "refocus restores the cursor");
	h.focus.cleanup();
});

test("blur hides the hardware cursor of a real editor", () => {
	const h = renderedEditor(true);
	assert.ok(h.render().writes.includes("<show>"), "the focused editor positions the hardware cursor");
	h.focus.handleTerminalInput(FOCUS_OUT);
	const blurred = h.render();
	assert.equal(blurred.lines.some((line) => line.includes("\x1b[7m")), false);
	assert.equal(blurred.writes.includes("<show>"), false, "a blurred editor shows no hardware cursor");
	assert.ok(blurred.writes.includes("<hide>"));
	h.focus.cleanup();
});

test("reinstall through Pi's editor reset reuses the fallback editor and its in-memory state", () => {
	const clock = manualScheduler();
	const clearedStatus: unknown[] = [];
	let created = 0;
	const createFallback = () => ({
		history: ["first prompt"],
		setWorkingStatusIndicator(indicator: unknown) {
			clearedStatus.push(indicator);
		},
		render: () => [],
		handleInput() {},
	});
	const focus = createEditorFocus({
		createDefaultEditor: () => {
			created += 1;
			return createFallback() as never;
		},
		scheduler: clock.scheduler,
	});
	let factory: unknown;
	const ui = {
		getEditorComponent: () => factory as never,
		setEditorComponent: (next: unknown) => {
			factory = next;
		},
	};
	const tui = { requestRender() {} };
	focus.install(ui);
	clock.runAll();
	const first = (factory as (...args: unknown[]) => unknown)(tui, editorTheme, {});

	// /new, /resume, /fork and /clone run Pi's resetExtensionUI(), which drops the factory and
	// restores Pi's cached default editor before this extension installs again.
	factory = undefined;
	focus.install(ui);
	clock.runAll();
	const second = (factory as (...args: unknown[]) => unknown)(tui, editorTheme, {});

	assert.equal(second, first, "the same editor instance comes back after the reset");
	assert.equal(created, 1, "the fallback editor is created once per TUI");
	assert.deepEqual(
		(second as ReturnType<typeof createFallback>).history,
		["first prompt"],
		"prompt history survives the reinstall",
	);
	assert.deepEqual(clearedStatus, [undefined], "reuse drops the previous session's working-status indicator");

	const other = (factory as (...args: unknown[]) => unknown)({ requestRender() {} }, editorTheme, {});
	assert.notEqual(other, first, "another TUI still gets its own editor");
	assert.equal(created, 2);
	focus.cleanup();
});
