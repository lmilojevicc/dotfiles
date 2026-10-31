import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, TuiAltScreen, visibleWidth, type Component, type Terminal, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { DEFAULT_TASKS_CONFIG } from "../src/config/tasks-config.ts";
import { registerLifecycle } from "../src/lifecycle.ts";
import { STATE_ENTRY } from "../src/state/replay.ts";
import { commitSnapshot, getSnapshot, resetStore, setForeground } from "../src/state/store.ts";
import { TaskWidget } from "../src/ui/widget.ts";
import { plainTheme, snapshot, task } from "./helpers.ts";

test.beforeEach(resetStore);

type WidgetComponent = Component & { dispose?(): void };
type WidgetFactory = (tui: TUI, theme: Theme) => WidgetComponent;

function harness() {
	let component: WidgetComponent | undefined;
	const requests: unknown[] = [];
	const ui = {
		theme: plainTheme,
		notify() {},
		onTerminalInput() { assert.fail("widget must not register raw input listeners"); },
		setWidget(_key: string, factory: WidgetFactory | undefined) {
			component?.dispose?.();
			component = factory?.({ requestRender: (force?: boolean) => { requests.push(force); } } as unknown as TUI, plainTheme);
		},
	} as unknown as ExtensionUIContext;
	return { ui, requests, get component() { assert.ok(component); return component; }, get mounted() { return !!component; } };
}

function mouse(overrides: Partial<TuiMouseEvent> = {}): TuiMouseEvent {
	return { type: "click", button: "left", x: 4, y: 0, screenX: 4, screenY: 0, width: 120, height: 5, shift: false, alt: false, ctrl: false, ...overrides };
}

function mountedWidget() {
	const state = snapshot([task(1, "completed"), task(2), task(3)]);
	commitSnapshot("s", state);
	setForeground("s");
	const h = harness();
	const widget = new TaskWidget({ ...DEFAULT_TASKS_CONFIG, maxVisible: 1 });
	widget.bind(h.ui);
	widget.refresh();
	return { h, widget, state };
}

test("headline click folds the whole list and expands back to the existing view without changing task truth", () => {
	const { h, widget, state } = mountedWidget();
	const expanded = h.component.render(120);
	assert.equal(expanded.at(-2), "└─ … and 2 more");
	assert.deepEqual(h.component.handleMouse?.(mouse()), { handled: true });
	assert.deepEqual(h.component.render(120), ["● 3 tasks (1 done, 2 open)", ""]);
	assert.deepEqual(h.requests, [true]);
	for (const width of [80, 40, 20, 5, 1]) {
		const lines = h.component.render(width);
		assert.equal(lines.length, 2);
		assert.ok(visibleWidth(lines[0]!) <= width);
		assert.equal(lines[1], "");
	}
	assert.deepEqual(h.component.render(0), []);
	assert.deepEqual(h.component.handleMouse?.(mouse()), { handled: true });
	assert.deepEqual(h.component.render(120), expanded);
	assert.deepEqual(getSnapshot("s"), state);
	widget.dispose();
});

test("only unmodified primary headline clicks toggle; press/release, rows, spacer and off-widget clicks pass through", () => {
	const { h, widget } = mountedWidget();
	const root = new Container();
	root.addChild({ render: () => ["unrelated above"], invalidate() {} });
	root.addChild(h.component);
	root.addChild({ render: () => ["unrelated below"], invalidate() {} });
	const expanded = h.component.render(120);
	root.render(120);
	for (const overrides of [
		{ type: "press" }, { type: "release" }, { type: "drag" }, { type: "move" }, { type: "wheel", wheelDelta: 1 },
		{ button: "right" }, { button: "middle" }, { shift: true }, { alt: true }, { ctrl: true },
	] as Partial<TuiMouseEvent>[]) {
		assert.equal(root.handleMouse(mouse({ y: 1, height: 6, ...overrides })), undefined);
	}
	for (const y of [-1, 0, 2, 3, 4, 5, 6]) assert.equal(root.handleMouse(mouse({ y, height: 6 })), undefined);
	assert.deepEqual(h.component.render(120), expanded);
	assert.deepEqual(h.requests, []);
	assert.equal(root.handleMouse(mouse({ y: 1, height: 6 }))?.handled, true);
	assert.deepEqual(h.component.render(120), [expanded[0], ""]);
	root.render(120);
	assert.equal(root.handleMouse(mouse({ y: 2, height: 3 })), undefined);
	assert.deepEqual(h.component.render(120), [expanded[0], ""]);
	widget.dispose();
});

test("collapsed state survives updates and preferences; the toggle shortcut expands it; reset/rebind/dispose restore defaults", () => {
	const { h, widget } = mountedWidget();
	h.component.handleMouse?.(mouse());
	commitSnapshot("s", snapshot([task(1, "completed"), task(2, "completed"), task(3, "in_progress"), task(4)], 1));
	widget.refresh();
	widget.setConfig({ ...DEFAULT_TASKS_CONFIG, collapseCompleted: true, maxVisible: 1 });
	assert.deepEqual(h.component.render(120), ["● 4 tasks (2 done, 1 in progress, 1 open)", ""]);
	widget.toggle();
	assert.equal(h.component.render(120).length, 5, "the collapse shortcut expands a collapsed widget");
	h.component.handleMouse?.(mouse());
	assert.deepEqual(h.component.render(120), ["● 4 tasks (2 done, 1 in progress, 1 open)", ""]);
	const removed = h.component;
	commitSnapshot("s", snapshot());
	widget.refresh();
	assert.equal(h.mounted, false);
	assert.equal(removed.handleMouse?.(mouse()), undefined);
	commitSnapshot("s", snapshot([task(5), task(6)]));
	widget.refresh();
	assert.deepEqual(h.component.render(120), ["● 2 tasks (2 open)", ""]);
	widget.refresh(true);
	assert.equal(h.component.render(120).length, 4);
	h.component.handleMouse?.(mouse());
	const previous = h.component;
	const other = harness();
	widget.bind(other.ui);
	widget.refresh();
	assert.equal(previous.handleMouse?.(mouse()), undefined);
	assert.equal(other.component.render(120).length, 4);
	other.component.handleMouse?.(mouse());
	const disposed = other.component;
	widget.dispose();
	widget.dispose();
	assert.equal(other.mounted, false);
	assert.equal(disposed.handleMouse?.(mouse()), undefined);
	widget.bind(h.ui);
	widget.refresh();
	assert.equal(h.component.render(120).length, 4);
	widget.dispose();
});

test("the toggle shortcut expands a collapsed widget instead of silently inverting show-all", () => {
	const { h, widget } = mountedWidget();
	const limited = h.component.render(120);
	h.component.handleMouse?.(mouse());
	assert.deepEqual(h.component.render(120), [limited[0], ""]);
	widget.toggle();
	assert.deepEqual(h.component.render(120), limited, "expanding restores the configured view, not a show-all view");
	widget.toggle();
	assert.equal(h.component.render(120).at(-2), "└─ ◻ #3 Task 3", "a second press flips show-all as before");
	widget.dispose();
});

test("session compaction preserves collapse while tree/start reset it; background shutdown leaves the foreground widget intact", async () => {
	const h = harness();
	const widget = new TaskWidget();
	const handlers = new Map<string, Function>();
	registerLifecycle({ on: (name: string, handler: Function) => handlers.set(name, handler) } as any, widget);
	const context = (id: string) => ({
		mode: "tui", ui: h.ui,
		sessionManager: { getSessionId: () => id, getBranch: () => [{ type: "custom", customType: STATE_ENTRY, data: snapshot([task(1)]) }] },
	});
	const ctx = context("s");
	await handlers.get("session_start")!({}, ctx);
	h.component.handleMouse?.(mouse());
	await handlers.get("session_compact")!({}, ctx);
	assert.deepEqual(h.component.render(120), ["● 1 tasks (1 open)", ""]);
	await handlers.get("session_shutdown")!({}, context("background"));
	assert.deepEqual(h.component.render(120), ["● 1 tasks (1 open)", ""]);
	await handlers.get("session_tree")!({}, ctx);
	assert.equal(h.component.render(120).length, 3);
	h.component.handleMouse?.(mouse());
	await handlers.get("session_start")!({ reason: "reload" }, ctx);
	assert.equal(h.component.render(120).length, 3);
	h.component.handleMouse?.(mouse());
	await handlers.get("session_shutdown")!({}, ctx);
	assert.equal(h.mounted, false);
	await handlers.get("session_start")!({ reason: "new" }, context("new"));
	assert.equal(h.component.render(120).length, 3);
	await handlers.get("session_shutdown")!({}, context("new"));
});

test("installed fullscreen TUI turns a press/release into one toggle and ignores drags and unrelated clicks", () => {
	commitSnapshot("s", snapshot([task(1), task(2)]));
	setForeground("s");
	let input = (_data: string) => {};
	const writes: string[] = [];
	const terminal: Terminal = {
		columns: 120, rows: 24, kittyProtocolActive: false,
		start: (onInput) => { input = onInput; }, stop() {}, drainInput: async () => {},
		write: (data) => { writes.push(data); }, moveBy() {}, hideCursor() {}, showCursor() {},
		clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {},
	};
	const tui = new TuiAltScreen(terminal, false, undefined, { copyOnSelect: false });
	const root = new Container();
	root.addChild({ render: () => ["unrelated"], invalidate() {} });
	let component: WidgetComponent | undefined;
	const ui = {
		theme: plainTheme,
		onTerminalInput() { assert.fail("widget must not register raw input listeners"); },
		setWidget(_key: string, factory: WidgetFactory | undefined) {
			if (component) { root.removeChild(component); component.dispose?.(); }
			component = factory?.(tui, plainTheme);
			if (component) root.addChild(component);
		},
	} as unknown as ExtensionUIContext;
	const widget = new TaskWidget();
	widget.bind(ui);
	widget.refresh();
	tui.setLayoutRoot(root);
	tui.start();
	try {
		tui.renderNow(true);
		assert.ok(component);
		const expanded = component.render(120);
		input("\x1b[<0;5;2M");
		assert.deepEqual(component.render(120), expanded);
		input("\x1b[<0;5;2m");
		assert.deepEqual(component.render(120), [expanded[0], ""]);
		tui.renderNow();
		input("\x1b[<0;5;1M"); input("\x1b[<0;5;1m");
		assert.deepEqual(component.render(120), [expanded[0], ""]);
		input("\x1b[<0;5;2M"); input("\x1b[<32;6;2M"); input("\x1b[<0;6;2m");
		assert.deepEqual(component.render(120), [expanded[0], ""]);
		input("\x1b[<0;5;2M"); input("\x1b[<0;5;2m");
		assert.deepEqual(component.render(120), expanded);
		widget.dispose();
		tui.renderNow();
		const afterRemoval = writes.length;
		input("\x1b[<0;5;2M"); input("\x1b[<0;5;2m");
		assert.equal(component, undefined);
		assert.equal(writes.slice(afterRemoval).some((write) => /\[\?100[026]/.test(write)), false);
	} finally {
		widget.dispose();
		tui.stop();
	}
	assert.ok(writes.some((write) => write.includes("\x1b[?1006l")), "TUI tears down its own mouse tracking");
});
