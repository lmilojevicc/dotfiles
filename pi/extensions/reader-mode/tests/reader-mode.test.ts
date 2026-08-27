import assert from "node:assert/strict";
import test from "node:test";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import readerModeExtension, {
	DEFAULT_READER_WIDTH,
	READER_STATE_ENTRY,
	installReaderPatch,
	parseReaderCommand,
} from "../index.ts";

type Handler = (...args: any[]) => any;

type TestEntry = {
	type: "custom";
	customType: string;
	data: unknown;
};

function customEntry(data: unknown, customType = READER_STATE_ENTRY): TestEntry {
	return { type: "custom", customType, data };
}

function createRuntime(
	initialEntries: TestEntry[] = [],
	options: {
		terminalWidth?: number;
		render?: (index: number, width: number) => string[];
	} = {},
) {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, { handler: Handler }>();
	const appended: Array<{ customType: string; data: unknown }> = [];
	const notifications: Array<{ message: string; level: string }> = [];
	let entries = initialEntries;
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		registerCommand: (name: string, options: { handler: Handler }) => commands.set(name, options),
		appendEntry: (customType: string, data: unknown) => appended.push({ customType, data }),
	};
	readerModeExtension(pi as any);

	const children: unknown[] = [];
	const renderer = {
		viewport: true,
		layoutRoot: undefined as unknown,
		renders: 0,
		terminal: { columns: options.terminalWidth },
		addChild: (component: unknown) => children.push(component),
		setLayoutRoot(root: unknown) { this.layoutRoot = root; },
		requestRender() { this.renders += 1; },
	};
	const components = Array.from({ length: 7 }, (_, index) => ({
		render: (width: number) => options.render?.(index, width) ?? [`region-${index}:${width}`],
	}));
	const originalRenders = components.map((component) => component.render);
	const mode = new InteractiveMode() as any;
	mode.fullscreenLayoutRoot = { kind: "fullscreen-root" };
	mode.mountInteractiveTui(renderer, components);

	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: { notify: (message: string, level: string) => notifications.push({ message, level }) },
		sessionManager: { getBranch: () => entries },
	};
	return {
		appended,
		commands,
		components,
		ctx,
		handlers,
		notifications,
		originalRenders,
		renderer,
		mode,
		setEntries(next: TestEntry[]) { entries = next; },
		setTerminalWidth(width: number | undefined) { renderer.terminal.columns = width; },
		start(reason = "startup") { handlers.get("session_start")?.({ reason }, ctx); },
		shutdown(reason = "quit") { handlers.get("session_shutdown")?.({ reason }, ctx); },
		reader(args: string) { commands.get("reader")?.handler(args, ctx); },
	};
}

function createExtensionRuntime(initialEntries: TestEntry[] = []) {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, { handler: Handler }>();
	const appended: Array<{ customType: string; data: unknown }> = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		registerCommand: (name: string, options: { handler: Handler }) => commands.set(name, options),
		appendEntry: (customType: string, data: unknown) => appended.push({ customType, data }),
	};
	readerModeExtension(pi as any);
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: { notify: (message: string, level: string) => notifications.push({ message, level }) },
		sessionManager: { getBranch: () => initialEntries },
	};
	return {
		appended,
		notifications,
		reader(args: string) { commands.get("reader")?.handler(args, ctx); },
		start(reason = "startup") { handlers.get("session_start")?.({ reason }, ctx); },
		shutdown(reason = "quit") { handlers.get("session_shutdown")?.({ reason }, ctx); },
	};
}

function createLateInstallRuntime(confirmResults: boolean[] = []) {
	const mode = new InteractiveMode() as any;
	mode.fullscreenLayoutRoot = { kind: "fullscreen-root" };
	const children: unknown[] = [];
	const renderer = {
		viewport: true,
		layoutRoot: undefined as unknown,
		renders: 0,
		terminal: { columns: 140 },
		addChild: (component: unknown) => children.push(component),
		setLayoutRoot(root: unknown) { this.layoutRoot = root; },
		requestRender() { this.renders += 1; },
	};
	const components = Array.from({ length: 7 }, (_, index) => ({
		render: (width: number) => [`late-region-${index}:${width}`],
	}));
	mode.mountInteractiveTui(renderer, components);
	const originalRenders = components.map((component) => component.render);

	const handlers = new Map<string, Handler>();
	const commands = new Map<string, { handler: Handler }>();
	const appended: Array<{ customType: string; data: unknown }> = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const confirmations: Array<{ title: string; message: string; options: { timeout: number } }> = [];
	readerModeExtension({
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		registerCommand: (name: string, options: { handler: Handler }) => commands.set(name, options),
		appendEntry: (customType: string, data: unknown) => appended.push({ customType, data }),
	} as any);
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			notify: (message: string, level: string) => notifications.push({ message, level }),
			confirm: async (title: string, message: string, options: { timeout: number }) => {
				confirmations.push({ title, message, options });
				return confirmResults.shift() ?? false;
			},
		},
		sessionManager: {
			getBranch: () => [customEntry({ enabled: true, width: 70 })],
		},
	};
	return {
		appended,
		components,
		confirmations,
		ctx,
		handlers,
		mode,
		notifications,
		originalRenders,
		renderer,
		reader(args: string, commandContext: any = ctx) {
			return commands.get("reader")?.handler(args, commandContext);
		},
		start(reason = "startup") { handlers.get("session_start")?.({ reason }, ctx); },
		shutdown(reason = "quit") { handlers.get("session_shutdown")?.({ reason }, ctx); },
	};
}

test("late install confirm, cancel, and timeout acknowledgements are inert until a real remount", async () => {
	const runtime = createLateInstallRuntime([
		true,
		false,
		false, // The host returns false when the acknowledgement times out.
		false,
		false,
	]);
	runtime.start();
	assert.deepEqual(runtime.notifications, [], "late TUI session start does not report a seam failure");

	for (const input of ["on", "on", "on", "", "90"]) await runtime.reader(input);
	assert.deepEqual(runtime.confirmations, Array.from({ length: 5 }, () => ({
		title: "Reader mode needs a TUI remount",
		message: "Automatic remounting is unsafe in Pi 0.84.2. Restart Pi or switch TUI mode in /settings, then rerun the desired /reader command.",
		options: { timeout: 15_000 },
	})));
	assert.deepEqual(runtime.appended, [], "acknowledgements never persist reader state");
	assert.equal(runtime.renderer.renders, 0, "acknowledgements never invalidate the renderer");
	assert.deepEqual(runtime.components.map((component) => component.render), runtime.originalRenders);
	assert.deepEqual(runtime.components[0]!.render(140), ["late-region-0:140"]);

	await runtime.reader("off");
	assert.equal(runtime.confirmations.length, 5, "off is an idempotent no-op before observation");
	assert.deepEqual(runtime.appended, []);
	assert.deepEqual(runtime.notifications, []);

	await runtime.reader("on 90");
	assert.equal(runtime.confirmations.length, 5, "invalid syntax is reported instead of warning");
	assert.deepEqual(runtime.notifications, [{
		message: "Usage: /reader [on|off|<positive integer width>]",
		level: "error",
	}]);

	runtime.mode.mountInteractiveTui(runtime.renderer, runtime.components);
	assert.notDeepEqual(runtime.components.map((component) => component.render), runtime.originalRenders);
	await runtime.reader("on");
	assert.deepEqual(runtime.appended, [{
		customType: READER_STATE_ENTRY,
		data: { enabled: true, width: DEFAULT_READER_WIDTH },
	}]);
	assert.equal(runtime.renderer.renders, 1);
	for (let index = 0; index < runtime.components.length; index++) {
		assert.deepEqual(runtime.components[index]!.render(140), [`               late-region-${index}:110`]);
	}
	runtime.shutdown();
});

test("late install is inert when the command has no TUI UI", async () => {
	const runtime = createLateInstallRuntime();
	const failUi = {
		notify() { assert.fail("late enabling must not notify without a TUI UI"); },
		confirm() { assert.fail("late enabling must not open a confirmation without a TUI UI"); },
	};

	await runtime.reader("on", { ...runtime.ctx, mode: "rpc", ui: failUi });
	await runtime.reader("", { ...runtime.ctx, hasUI: false, ui: failUi });
	await runtime.reader("80", { ...runtime.ctx, hasUI: false, ui: undefined });
	assert.deepEqual(runtime.confirmations, []);
	assert.deepEqual(runtime.appended, []);
	assert.equal(runtime.renderer.renders, 0);
	assert.deepEqual(runtime.components.map((component) => component.render), runtime.originalRenders);
	runtime.shutdown();
});

test("off is byte-for-byte unchanged; on centers all seven root regions", () => {
	const runtime = createRuntime();
	runtime.start();

	for (let index = 0; index < runtime.components.length; index++) {
		assert.deepEqual(runtime.components[index]!.render(140), [`region-${index}:140`]);
	}
	assert.equal(runtime.renderer.layoutRoot.kind, "fullscreen-root", "fullscreen root and overlays remain unwrapped");

	runtime.reader("on");
	for (let index = 0; index < runtime.components.length; index++) {
		assert.deepEqual(runtime.components[index]!.render(140), [`               region-${index}:110`]);
	}
	assert.deepEqual(runtime.appended, [
		{ customType: READER_STATE_ENTRY, data: { enabled: true, width: DEFAULT_READER_WIDTH } },
	]);
	runtime.shutdown();
});

test("registered no-argument /reader toggles, persists, invalidates, and notifies", () => {
	const runtime = createRuntime();
	runtime.start();
	const rendersBeforeCommand = runtime.renderer.renders;

	runtime.reader("");

	assert.deepEqual(runtime.appended, [
		{ customType: READER_STATE_ENTRY, data: { enabled: true, width: DEFAULT_READER_WIDTH } },
	]);
	assert.equal(runtime.renderer.renders, rendersBeforeCommand + 1);
	assert.deepEqual(runtime.notifications.at(-1), {
		message: "Reader mode on (110 columns)",
		level: "info",
	});
	assert.deepEqual(runtime.components[0]!.render(140), ["               region-0:110"]);
	runtime.shutdown();
});

test("OSC 133 prompt markers remain at byte zero for fullscreen prompt navigation", () => {
	const a = "\x1b]133;A\x07";
	const b = "\x1b]133;B\x1b\\";
	const c = "\x1b]133;C\x07";
	const runtime = createRuntime([], {
		render: () => [`${a}prompt`, `${b}${c}command`, "plain", ""],
	});
	runtime.start();
	runtime.reader("on");

	const lines = runtime.components[0]!.render(140);
	assert.equal(lines[0], `${a}${" ".repeat(15)}prompt`);
	assert.equal(lines[1], `${b}${c}${" ".repeat(15)}command`);
	assert.equal(lines[0]!.indexOf(a), 0, "Ctrl+Shift+Up/Down scanner can match A at byte zero");
	assert.equal(lines[1]!.indexOf(b), 0, "Ctrl+Shift+Up/Down scanner can match B at byte zero");
	assert.equal(lines[1]!.indexOf(c), b.length, "consecutive semantic markers stay before margin");
	assert.equal(lines[3], "", "an empty line remains byte-for-byte empty");
	runtime.shutdown();
});

test("multi-row Kitty and iTerm2 image reservation rows remain exact empty strings", () => {
	const kitty = "\x1b_Gf=100,a=T;AAAA\x1b\\";
	const iterm2 = "\x1b]1337;File=inline=1:AAAA\x07";
	const runtime = createRuntime([], {
		render: () => [kitty, "", "", "kitty-caption", iterm2, "", "iterm-caption"],
	});
	runtime.start();
	runtime.reader("on");

	const lines = runtime.components[0]!.render(140);
	assert.equal(lines[0], `${" ".repeat(15)}${kitty}`);
	assert.equal(lines[1], "", "first Kitty reservation row stays empty");
	assert.equal(lines[2], "", "second Kitty reservation row stays empty");
	assert.equal(lines[4], `${" ".repeat(15)}${iterm2}`);
	assert.equal(lines[5], "", "iTerm2 reservation row stays empty");
	assert.equal(lines[6], `${" ".repeat(15)}iterm-caption`);
	runtime.shutdown();
});

test("fullscreen scrollbar width variants share a terminal-centered left edge", () => {
	const runtime = createRuntime([], { terminalWidth: 140 });
	runtime.start();
	runtime.reader("on");

	for (const { terminalWidth, expectedMargin } of [
		{ terminalWidth: 140, expectedMargin: 15 },
		{ terminalWidth: 141, expectedMargin: 15 },
		{ terminalWidth: 142, expectedMargin: 16 },
	]) {
		runtime.setTerminalWidth(terminalWidth);
		const expected = `${" ".repeat(expectedMargin)}region-0:110`;
		assert.deepEqual(runtime.components[0]!.render(terminalWidth), [expected], "auto width");
		assert.deepEqual(runtime.components[0]!.render(terminalWidth - 1), [expected], "always width");
		assert.deepEqual(runtime.components[0]!.render(terminalWidth), [expected], "hidden-like width");
	}
	runtime.shutdown();
});

test("narrow and odd-width terminals use deterministic natural margins", () => {
	const runtime = createRuntime();
	runtime.start();
	runtime.reader("on");
	assert.deepEqual(runtime.components[0]!.render(80), ["region-0:80"], "narrow terminal has no margin");
	assert.deepEqual(runtime.components[0]!.render(120), ["     region-0:110"]);
	assert.deepEqual(runtime.components[0]!.render(121), ["     region-0:110"], "odd extra column goes right");
	runtime.shutdown();
});

test("positive width configures and enables; off retains configured width", () => {
	const runtime = createRuntime();
	runtime.start();
	runtime.reader("90");
	assert.deepEqual(runtime.components[0]!.render(120), ["               region-0:90"]);
	runtime.reader("off");
	assert.deepEqual(runtime.components[0]!.render(120), ["region-0:120"]);
	assert.deepEqual(runtime.appended.map((entry) => entry.data), [
		{ enabled: true, width: 90 },
		{ enabled: false, width: 90 },
	]);
	assert.deepEqual(parseReaderCommand("", { enabled: false, width: 90 }), {
		ok: true,
		state: { enabled: true, width: 90 },
	});
	runtime.shutdown();
});

test("session entries restore latest state and sessions without entries reset to defaults", () => {
	const runtime = createRuntime([
		customEntry({ enabled: false, width: 100 }),
		customEntry({ ignored: true }, "another-extension"),
		customEntry({ enabled: true, width: 72 }),
	]);
	runtime.start("resume");
	assert.deepEqual(runtime.components[0]!.render(100), ["              region-0:72"]);
	assert.equal(runtime.appended.length, 0, "restore does not write another entry");

	runtime.setEntries([]);
	runtime.start("new");
	assert.deepEqual(runtime.components[0]!.render(100), ["region-0:100"]);
	runtime.shutdown();
});

test("invalid commands notify clearly without changing rendering or persistence", () => {
	const runtime = createRuntime();
	runtime.start();
	for (const input of ["0", "-2", "2.5", "on 90", "wat", "999999999999999999999999"]) {
		runtime.reader(input);
	}
	assert.equal(runtime.appended.length, 0);
	assert.deepEqual(runtime.components[0]!.render(140), ["region-0:140"]);
	assert.equal(runtime.notifications.length, 6);
	assert.ok(runtime.notifications.every((notice) => notice.level === "error" && notice.message.startsWith("Usage:")));
	runtime.shutdown();
});

test("reload is idempotent and final shutdown restores identities", () => {
	const originalMount = InteractiveMode.prototype.mountInteractiveTui;
	const first = createRuntime();
	const patchedMount = InteractiveMode.prototype.mountInteractiveTui;
	const patchedRender = first.components[0]!.render;
	assert.notEqual(patchedMount, originalMount);
	assert.notEqual(patchedRender, first.originalRenders[0]);

	first.shutdown("reload");
	assert.equal(InteractiveMode.prototype.mountInteractiveTui, patchedMount);
	assert.deepEqual(first.components[0]!.render(140), ["region-0:140"], "reload leaves an inert patch");

	const secondHandlers = new Map<string, Handler>();
	const secondCommands = new Map<string, { handler: Handler }>();
	const secondAppended: Array<{ customType: string; data: unknown }> = [];
	const secondNotifications: Array<{ message: string; level: string }> = [];
	const secondPi = {
		on: (event: string, handler: Handler) => secondHandlers.set(event, handler),
		registerCommand: (name: string, options: { handler: Handler }) => secondCommands.set(name, options),
		appendEntry: (customType: string, data: unknown) => secondAppended.push({ customType, data }),
	};
	readerModeExtension(secondPi as any);
	assert.equal(InteractiveMode.prototype.mountInteractiveTui, patchedMount, "prototype is not wrapped twice");
	const secondCtx = {
		mode: "tui",
		hasUI: true,
		ui: {
			notify: (message: string, level: string) => secondNotifications.push({ message, level }),
		},
		sessionManager: { getBranch: () => [customEntry({ enabled: true, width: 100 })] },
	};
	secondHandlers.get("session_start")?.({ reason: "resume" }, secondCtx);
	assert.deepEqual(first.components[0]!.render(140), ["                    region-0:100"]);

	secondCommands.get("reader")?.handler("", secondCtx);
	assert.deepEqual(secondAppended, [
		{ customType: READER_STATE_ENTRY, data: { enabled: false, width: 100 } },
	]);
	assert.deepEqual(secondNotifications.at(-1), {
		message: "Reader mode off (100 columns retained)",
		level: "info",
	});
	assert.deepEqual(first.components[0]!.render(140), ["region-0:140"]);

	secondHandlers.get("session_shutdown")?.({ reason: "quit" }, {});
	assert.equal(InteractiveMode.prototype.mountInteractiveTui, originalMount);
	assert.equal(first.components[0]!.render, first.originalRenders[0]);
});

test("repeat mounts for the same InteractiveMode update renderer ownership", () => {
	const runtime = createRuntime([], { terminalWidth: 140 });
	runtime.start();
	runtime.reader("on");
	const switchedRenderer = {
		terminal: { columns: 142 },
		renders: 0,
		addChild() {},
		requestRender() { this.renders += 1; },
	};

	runtime.mode.mountInteractiveTui(switchedRenderer, runtime.components);
	assert.deepEqual(runtime.components[0]!.render(141), ["                region-0:110"]);
	runtime.reader("off");
	assert.equal(switchedRenderer.renders, 1, "mode-switched renderer receives invalidation");
	runtime.shutdown();
});

test("unsupported public Pi version is rejected before prototype mutation", () => {
	const originalMount = InteractiveMode.prototype.mountInteractiveTui;
	const result = installReaderPatch(Symbol("unsupported-version-test"), "0.85.0");
	assert.deepEqual(result, {
		ok: false,
		error: "Reader mode disabled: Pi 0.85.0 is unsupported; expected 0.84.2",
	});
	assert.equal(InteractiveMode.prototype.mountInteractiveTui, originalMount);
});

test("version/shape mismatch fails closed instead of partially centering", () => {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, { handler: Handler }>();
	readerModeExtension({
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		registerCommand: (name: string, options: { handler: Handler }) => commands.set(name, options),
		appendEntry() { assert.fail("failed patch must not persist state"); },
	} as any);
	const component = { render: (width: number) => [`plain:${width}`] };
	const components = Array.from({ length: 7 }, () => component);
	const mode = new InteractiveMode("0.85.0") as any;
	mode.mountInteractiveTui({ addChild() {} }, components);
	const notifications: string[] = [];
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: { notify: (message: string) => notifications.push(message) },
		sessionManager: { getBranch: () => [] },
	};
	handlers.get("session_start")?.({ reason: "startup" }, ctx);
	commands.get("reader")?.handler("on", ctx);
	assert.deepEqual(component.render(140), ["plain:140"]);
	assert.equal(notifications.length, 2, "session start and command both report the mismatch");
	assert.ok(notifications.every((message) => message.startsWith("Reader mode disabled:")));
	handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
});

test("a second InteractiveMode permanently tombstones reader mode without owner bookkeeping", () => {
	const disabledMessage = "Reader mode disabled: only one InteractiveMode instance is supported per process";
	const patchKey = Symbol.for("dotfiles.reader-mode.layout-patch.v1");
	const originalMount = InteractiveMode.prototype.mountInteractiveTui;
	const primary = createRuntime();
	const patchedMount = InteractiveMode.prototype.mountInteractiveTui;
	primary.start();
	primary.reader("90");
	assert.deepEqual(primary.components[0]!.render(140), ["                         region-0:90"]);

	const concurrentRuntime = createExtensionRuntime();
	const secondComponents = Array.from({ length: 7 }, (_, index) => ({
		render: (width: number) => [`second-${index}:${width}`],
	}));
	const secondOriginalRenders = secondComponents.map((component) => component.render);
	const second = new InteractiveMode() as any;
	second.mountInteractiveTui({ addChild() {}, terminal: { columns: 140 } }, secondComponents);

	assert.notEqual(patchedMount, originalMount);
	assert.equal(InteractiveMode.prototype.mountInteractiveTui, originalMount);
	assert.deepEqual(
		primary.components.map((component) => component.render),
		primary.originalRenders,
		"all primary render identities are restored",
	);
	assert.deepEqual(secondComponents.map((component) => component.render), secondOriginalRenders);
	assert.deepEqual(primary.components[0]!.render(140), ["region-0:140"]);
	assert.deepEqual(secondComponents[0]!.render(140), ["second-0:140"]);

	const tombstone = (globalThis as any)[patchKey];
	assert.deepEqual(tombstone, { disabled: true, error: disabledMessage });
	assert.deepEqual(Object.keys(tombstone).sort(), ["disabled", "error"]);
	assert.equal(Object.isFrozen(tombstone), true);
	assert.equal("owner" in tombstone, false);
	assert.equal("blockedOwners" in tombstone, false);
	assert.equal("blockedReloads" in tombstone, false);

	const rendersAtDisable = primary.renderer.renders;
	const primaryEntriesAtDisable = primary.appended.length;
	primary.reader("70");
	primary.start("resume");
	primary.reader("off");
	primary.shutdown("reload");
	concurrentRuntime.start("switch");
	concurrentRuntime.reader("70");
	concurrentRuntime.shutdown("reload");
	assert.equal(primary.appended.length, primaryEntriesAtDisable);
	assert.deepEqual(concurrentRuntime.appended, []);
	assert.equal(primary.renderer.renders, rendersAtDisable);
	assert.deepEqual(primary.notifications, [
		{ message: "Reader mode on (90 columns)", level: "info" },
		{ message: disabledMessage, level: "error" },
	]);
	assert.deepEqual(concurrentRuntime.notifications, [{ message: disabledMessage, level: "error" }]);

	const switchedRenderer = {
		renders: 0,
		addChild() {},
		requestRender() { this.renders += 1; },
		terminal: { columns: 160 },
	};
	primary.mode.mountInteractiveTui(switchedRenderer, primary.components);
	second.mountInteractiveTui(switchedRenderer, secondComponents);
	assert.deepEqual(primary.components.map((component) => component.render), primary.originalRenders);
	assert.deepEqual(secondComponents.map((component) => component.render), secondOriginalRenders);
	assert.equal(switchedRenderer.renders, 0);

	const reloadA = createExtensionRuntime([customEntry({ enabled: true, width: 50 })]);
	const reloadB = createExtensionRuntime([customEntry({ enabled: true, width: 60 })]);
	reloadB.start("reload");
	reloadA.shutdown("reload");
	reloadA.reader("70");
	reloadB.reader("80");
	reloadA.start("reload");
	reloadB.shutdown("quit");
	assert.deepEqual(reloadA.appended, []);
	assert.deepEqual(reloadB.appended, []);
	assert.deepEqual(reloadA.notifications, [{ message: disabledMessage, level: "error" }]);
	assert.deepEqual(reloadB.notifications, [{ message: disabledMessage, level: "error" }]);
	assert.equal(InteractiveMode.prototype.mountInteractiveTui, originalMount);
	assert.equal((globalThis as any)[patchKey], tombstone, "reinstallation cannot replace or grow the tombstone");
	assert.deepEqual(installReaderPatch(Symbol("post-tombstone")), {
		ok: false,
		error: disabledMessage,
		tombstoned: true,
	});
});
