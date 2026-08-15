import assert from "node:assert/strict";
import test from "node:test";

import { createEditorFocus, FOCUS_OUT, type Scheduler } from "../editor-focus.ts";

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
	assert.deepEqual(latest.renderFocused, [false]);
	assert.equal(editor.focused, true, "temporary focused override is restored");

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
