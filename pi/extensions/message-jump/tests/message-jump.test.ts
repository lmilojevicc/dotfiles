import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { Container, Text, ScrollView, VStack, KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import extension from "../index.ts";
import { installBridge } from "../bridge.ts";
import { collectMessages, filterMessages } from "../messages.ts";
import { MessagePicker } from "../picker.ts";

const entry = (id: string, content: any = "same") => ({ type: "message", id, message: { role: "user", content, timestamp: 100 } }) as any;
const theme = { fg: (_: string, s: string) => s, bold: (s: string) => s } as any;
function host(mode = "fullscreen") {
	const instance = new InteractiveMode() as any;
	instance.version = "1.0.4";
	instance.chatContainer = new Container();
	instance.documentContainer = new Container();
	instance.documentContainer.addChild(new Text("header\nsecond", 0, 0));
	instance.documentContainer.addChild(instance.chatContainer);
	instance.transcriptScrollView = new ScrollView(instance.documentContainer, { follow: "end", scrollbar: "always" });
	instance.fullscreenLayoutRoot = new VStack([instance.transcriptScrollView, new Container()]);
	instance.renderer = { mode, terminal: { columns: 30, rows: 20 }, layoutRoot: instance.fullscreenLayoutRoot,
		renders: 0, renderNow() {
			const scroll = instance.transcriptScrollView;
			scroll.updateLayout(instance.documentContainer.render(scroll.getContentWidth(this.terminal.columns)).length, 4, () => {});
		}, requestRender() { this.renders++; } };
	instance.mountInteractiveTui(instance.renderer, [instance.documentContainer, ...Array.from({ length: 6 }, () => new Container())]);
	return instance;
}
const item = (e: any) => collectMessages([e])[0];

 test("collectMessages: chronological active-branch IDs, duplicates, multiline Unicode, image/empty previews and safe controls", () => {
	const a = entry("a", "same\n世界 long tail"); const b = entry("b", "same\n世界 long tail");
	const image = entry("i", [{ type: "image", data: "secret", mimeType: "image/png" }]);
	const mixed = entry("mix", [{ type: "text", text: "text" }, { type: "image", data: "abc" }]);
	const result = collectMessages([a, { type: "message", id: "assistant", message: { role: "assistant" } } as any, b, image, entry("empty", null), mixed]);
	assert.deepEqual(result.map(i => i.id), ["a", "b", "i", "empty", "mix"]);
	assert.equal(result[4].preview, "text [1 image]"); assert.equal(result[3].preview, "[Empty prompt]"); assert.equal(result[2].preview, "[1 image]");
	assert.deepEqual(filterMessages(result, "TAIL 世界").map(i => i.id), ["a", "b"]);
	assert.equal(item(entry("ctl", "x\x1b[2J\nnext")).preview.includes("\x1b"), false);
	assert.equal(filterMessages(result, "secret").length, 0);
});

test("bridge: stable object identity, header/spacers/skills, scrollbar width, resize and disabled follow", () => {
	const bridge = installBridge(Symbol());
	try {
		const h = host(); const a = entry("a", "same"); const b = entry("b", "same");
		h.addMessageToChat(a.message, { skill: true });
		h.chatContainer.addChild(new Text("z".repeat(180), 0, 0));
		h.addMessageToChat(b.message);
		h.chatContainer.addChild(new Text("trailing\n".repeat(20), 0, 0));
		assert.equal(h.mountCalls, 1); assert.equal(h.addCalls, 2);
		for (const width of [30, 12, 80]) {
			h.renderer.terminal.columns = width;
			const target = h.chatContainer.children[6];
			const row = h.documentContainer.children[0].render(width - 1).length + h.chatContainer.children.slice(0, 6).reduce((n: number, c: any) => n + c.render(width - 1).length, 0);
			assert.ok(target); assert.equal(bridge.jump(item(b)), undefined);
			assert.equal(h.transcriptScrollView.scrollTop, row);
			assert.equal(h.transcriptScrollView.isFollowingEnd, false);
		}
		assert.equal(bridge.jump(item(a)), undefined); assert.equal(h.transcriptScrollView.scrollTop, 3);
		assert.match(bridge.jump(item(entry("copied", "same")))!, /Not rendered/);
	} finally { bridge.release(true); }
});

test("bridge: near-end clamping succeeds, compaction/removal and image-only fail closed", () => {
	const bridge = installBridge(Symbol());
	try {
		const h = host(); const a = entry("a"); const image = entry("image", [{ type: "image" }]);
		h.addMessageToChat(a.message); h.addMessageToChat(image.message);
		assert.equal(bridge.jump(item(a)), undefined); assert.equal(h.transcriptScrollView.scrollTop, 0);
		assert.equal(h.transcriptScrollView.isFollowingEnd, false);
		assert.match(bridge.unavailable(item(image))!, /Not rendered/);
		h.chatContainer.clear(); assert.match(bridge.jump(item(a))!, /Not rendered/);
	} finally { bridge.release(true); }
});

test("bridge: regular mode, altered-width wrapper, missing layout capability, late loading and version rejection", () => {
	assert.match(installBridge(Symbol(), "2.0").error()!, /Unsupported Pi/);
	const bridge = installBridge(Symbol());
	try {
		assert.match(bridge.error()!, /Restart Pi/);
		const h = host("regular"); assert.match(bridge.error()!, /fullscreen/);
		h.renderer.mode = "fullscreen";
		const original = h.documentContainer.render;
		h.documentContainer.render = function (width: number) { return original.call(this, Math.min(width, 10)); };
		assert.match(bridge.error()!, /Unsupported transcript layout/);
		h.documentContainer.render = original;
		h.fullscreenLayoutRoot.align = "center"; assert.match(bridge.error()!, /Unsupported transcript layout/);
		h.fullscreenLayoutRoot.align = "stretch"; h.transcriptScrollView.getContentWidth = undefined;
		assert.match(bridge.error()!, /Unsupported transcript layout/);
	} finally { bridge.release(true); }
});

test("bridge: ownership, inert reload handoff, old cleanup, quit restoration, conflicts and multiple instances", () => {
	const original = InteractiveMode.prototype.mountInteractiveTui;
	const a = installBridge(Symbol()); const h = host(); const e = entry("e"); h.addMessageToChat(e.message);
	assert.match(installBridge(Symbol()).error()!, /already owns/);
	a.release(false); assert.match(a.error()!, /no longer active/);
	const b = installBridge(Symbol()); assert.equal(b.unavailable(item(e)), undefined);
	a.release(true); assert.notEqual(InteractiveMode.prototype.mountInteractiveTui, original);
	b.release(true); assert.equal(InteractiveMode.prototype.mountInteractiveTui, original);
	const c = installBridge(Symbol());
	const ownWrapper = InteractiveMode.prototype.mountInteractiveTui;
	const conflicting = function (this: any, ...args: any[]) { return ownWrapper.apply(this, args as any); };
	InteractiveMode.prototype.mountInteractiveTui = conflicting;
	assert.match(c.error()!, /replaced/); c.release(true);
	assert.equal(InteractiveMode.prototype.mountInteractiveTui, conflicting);
	InteractiveMode.prototype.mountInteractiveTui = original;
	const d = installBridge(Symbol());
	try { host(); host(); assert.match(d.error()!, /Multiple interactive/); } finally { d.release(true); }
});

test("picker: full-text filter, configurable keys, Escape, focus, Unicode widths, no-result Enter and resize", () => {
	const values = collectMessages([entry("old", "duplicate"), entry("new", "duplicate"), entry("unicode", "世界\nend needle")]);
	const kb = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.down": "ctrl+n", "tui.select.up": "ctrl+p", "tui.select.confirm": "ctrl+o", "tui.select.cancel": "ctrl+x" });
	const tui = { terminal: { rows: 20 }, requestRender() {} } as any;
	const results: any[] = [];
	const picker = new MessagePicker(values, tui, theme, kb, id => results.push(id), "duplicate");
	picker.focused = true; assert.equal(picker.focused, true);
	for (const width of [1, 2, 4, 10, 40, 90]) assert.ok(picker.render(width).every(line => visibleWidth(line) <= width));
	tui.terminal.rows = 8; picker.render(10);
	picker.handleInput("\x0e"); picker.handleInput("\x0f"); assert.deepEqual(results, ["old"]);
	picker.handleInput("\x0f"); assert.equal(results.length, 1);
	const filtered = new MessagePicker(values, tui, theme, kb, id => results.push(id), "needle 世界");
	filtered.handleInput("\x0f"); assert.equal(results[1], "unicode");
	const empty = new MessagePicker(values, tui, theme, kb, id => results.push(id), "absent");
	empty.handleInput("\x0f"); assert.equal(results.length, 2);
	empty.handleInput("\x1b"); assert.equal(results[2], undefined);
	const cancel = new MessagePicker(values, tui, theme, kb, id => results.push(id)); cancel.handleInput("\x18"); assert.equal(results[3], undefined);
	const paging = new MessagePicker(values, tui, theme, kb, id => results.push(id));
	paging.render(80); paging.handleInput("\x1b[5~"); paging.handleInput("\x0f"); assert.equal(results[4], "new");
});

test("picker: native-shaped inline snapshot, chronological metadata, latest defaults, wrapping and live search", () => {
	const values = collectMessages(Array.from({ length: 12 }, (_, i) => entry(`id-${i}`, `prompt ${i + 1}`)));
	const tui = { terminal: { rows: 50 }, requestRender() {} } as any;
	const kb = new KeybindingsManager(TUI_KEYBINDINGS);
	const results: any[] = [];
	const picker = new MessagePicker(values, tui, theme, kb, id => results.push(id));
	const lines = picker.render(80).map(line => line.trimEnd());
	assert.deepEqual(lines.slice(0, 3), ["", " Jump to Message", " Select a user message to scroll to in the current transcript"]);
	assert.ok(lines[3].startsWith(" Search: "));
	assert.deepEqual(lines.slice(4, 7), [" Ctrl+Y copy highlighted message", "─".repeat(80), ""]);
	assert.deepEqual(lines.slice(7, 10), ["  prompt 3", "  Message 3 of 12", ""]);
	assert.deepEqual(lines.slice(-6), ["› prompt 12", "  Message 12 of 12", "", "  (12/12)", "", "─".repeat(80)]);
	picker.handleInput("\x1b[B"); // Newest wraps to oldest.
	assert.ok(picker.render(80).includes("› prompt 1"));
	picker.handleInput("\x1b[A"); // Oldest wraps to newest.
	assert.ok(picker.render(80).includes("› prompt 12"));
	picker.handleInput("\x1b[A"); // Up is older.
	assert.ok(picker.render(80).includes("› prompt 11"));
	picker.handleInput("\x1b[200~PROMPT 1\x1b[201~");
	const filtered = picker.render(80);
	assert.ok(filtered.includes("› prompt 12"), "changed query defaults to latest match");
	assert.ok(filtered.includes("  Message 12 of 12"), "filtered metadata retains branch ordinals");
	picker.handleInput("\r"); assert.deepEqual(results, ["id-11"]);
	const marked = new MessagePicker([{ ...values[11], unavailable: "not rendered" }], tui, theme, kb, () => {});
	assert.ok(marked.render(80).includes("› [unavailable] prompt 12"));
	const styled = { fg: (token: string, text: string) => `<${token}>${text}</${token}>`, bold: (text: string) => `<bold>${text}</bold>` } as any;
	const colored = new MessagePicker(values.slice(0, 1), tui, styled, kb, () => {}).render(200);
	assert.ok(colored.includes("<accent>› </accent><bold>prompt 1</bold>"), "only the caret is accent, only the selected prompt is bold");
	for (const width of [20, 30, 40, 65, 80]) for (const rows of [20, 24, 32, 40, 50]) {
		tui.terminal.rows = rows;
		const resized = new MessagePicker(values, tui, theme, kb, () => {}).render(width);
		assert.ok(resized.length <= rows - 4, "height leaves room for the host footer");
		assert.ok(resized.includes("› prompt 12"), "resize preserves latest selection");
	}
});

test("picker: Ctrl+Y copies full highlighted text, keeps search/selection open, and takes precedence over confirm", async () => {
	const oldText = `duplicate\nneedle 世界\t${"long tail ".repeat(30)}`;
	const values = collectMessages([entry("old", oldText), entry("new", "duplicate\nneedle 世界 new")]);
	const tui = { terminal: { rows: 50 }, requestRender() {} } as any;
	const kb = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.confirm": "ctrl+y" });
	const done: any[] = []; const copied: string[] = [];
	const picker = new MessagePicker(values, tui, theme, kb, id => done.push(id), "needle");
	picker.onCopy = (text) => { copied.push(text); };
	picker.handleInput("\x19"); await Promise.resolve();
	assert.deepEqual(copied, [values[1].text]); assert.deepEqual(done, []);
	assert.ok(picker.render(80).some(line => line.includes("Copied message 2 to clipboard")));
	picker.handleInput("\x1b[A"); picker.handleInput("\x19"); await Promise.resolve();
	assert.equal(copied[1], oldText, "copy original multiline text, never truncated preview or metadata");
	assert.ok(picker.render(80).some(line => line.startsWith("› duplicate needle 世界")));
	assert.ok(stripVTControlCharacters(picker.render(80)[3]).includes("needle"), "Ctrl+Y does not yank into the search field");
	assert.deepEqual(done, []);
	for (const width of [1, 2, 10, 40, 80]) assert.ok(picker.render(width).every(line => visibleWidth(line) <= width));
	picker.handleInput("\x1b"); assert.deepEqual(done, [undefined]);
	picker.handleInput("\x19"); assert.equal(copied.length, 2, "closed picker ignores copy");
});

test("picker: copying unavailable text works; empty/no-result/failure/pending copies are safe", async () => {
	let renders = 0; const tui = { terminal: { rows: 50 }, requestRender() { renders++; } } as any;
	const kb = new KeybindingsManager(TUI_KEYBINDINGS); const copied: string[] = [];
	const values = collectMessages([entry("text", "compacted text"), entry("image", [{ type: "image" }])]);
	const unavailable = new MessagePicker([{ ...values[0], unavailable: "compacted" }], tui, theme, kb, () => {});
	unavailable.onCopy = text => { copied.push(text); };
	unavailable.handleInput("\x19"); await Promise.resolve(); assert.deepEqual(copied, ["compacted text"]);
	const image = new MessagePicker([values[1]], tui, theme, kb, () => {});
	image.onCopy = () => { throw new Error("must not copy image placeholders"); };
	image.handleInput("\x19"); await Promise.resolve();
	assert.ok(image.render(80).some(line => line.includes("no text to copy")));
	const empty = new MessagePicker(values, tui, theme, kb, () => {}, "absent");
	empty.onCopy = () => { throw new Error("must not copy without a match"); };
	empty.handleInput("\x19"); await Promise.resolve();
	assert.ok(empty.render(80).some(line => line.includes("No matching messages")));
	const failure = new MessagePicker([values[0]], tui, theme, kb, () => {});
	failure.onCopy = async () => { throw new Error("clipboard denied\x1b[2J"); };
	failure.handleInput("\x19"); await Promise.resolve();
	const feedback = failure.render(80).find(line => line.includes("Copy failed"))!;
	assert.ok(feedback.includes("clipboard denied")); assert.equal(feedback.includes("\x1b"), false);
	const done: any[] = []; let resolveCopy!: () => void; let calls = 0;
	const pending = new MessagePicker([values[0]], tui, theme, kb, id => done.push(id));
	pending.onCopy = () => { calls++; return new Promise<void>(resolve => { resolveCopy = resolve; }); };
	pending.handleInput("\x19"); pending.handleInput("\x19"); assert.equal(calls, 1);
	pending.handleInput("\x1b"); assert.deepEqual(done, [undefined]);
	const before = renders; resolveCopy(); await Promise.resolve();
	assert.equal(renders, before, "late clipboard completion does not render a closed picker");
});

function runtime() {
	const events = new Map<string, any>(); const commands = new Map<string, any>();
	extension({ on: (n: string, f: any) => events.set(n, f), registerCommand: (n: string, c: any) => commands.set(n, c) } as any);
	return { events, jump: commands.get("jump").handler };
}
test("command: only active branch, inline cancellation preserves draft/scroll/context; commit rechecks stale IDs", async () => {
	const r = runtime(); const h = host(); const a = entry("a"); const b = entry("b");
	h.addMessageToChat(a.message); h.addMessageToChat(b.message);
	let branch = [a, b]; let session = "one"; let draft = "untouched";
	const notifications: string[] = []; let choose: any;
	const forbidden = () => { throw new Error("session/draft mutation forbidden"); };
	const ctx = { mode: "tui", hasUI: true, sessionManager: { getBranch: () => branch, getSessionId: () => session },
		fork: forbidden, navigateTree: forbidden, ui: { notify: (s: string) => notifications.push(s), setEditorText: forbidden,
			custom: async (factory: any, options: any) => { assert.equal(options, undefined); const picker = factory({ terminal: { rows: 20 }, requestRender() {} }, theme, new KeybindingsManager(TUI_KEYBINDINGS), (id: any) => {}); picker.dispose(); return choose?.(); } } } as any;
	try {
		const before = h.transcriptScrollView.scrollTop;
		await r.jump("", ctx); assert.equal(h.transcriptScrollView.scrollTop, before); assert.equal(draft, "untouched"); assert.deepEqual(branch, [a,b]);
		choose = () => { branch = [a]; return "b"; }; await r.jump("", ctx); assert.match(notifications.pop()!, /no longer on/);
		choose = () => { session = "two"; return "a"; }; await r.jump("", ctx); assert.match(notifications.pop()!, /Session changed/);
		choose = () => "a"; await r.jump("", ctx); assert.equal(notifications.length, 0);
		choose = () => { h.chatContainer.clear(); return "a"; }; await r.jump("", ctx); assert.match(notifications.pop()!, /Not rendered/);
		ctx.mode = "rpc"; await r.jump("", ctx); assert.match(notifications.pop()!, /interactive fullscreen/);
	} finally { r.events.get("session_shutdown")({ reason: "quit" }); }
});

test("command: session replacement shutdown closes a live inline picker, lifecycle resources released", async () => {
	const r = runtime(); const h = host(); const a = entry("a"); h.addMessageToChat(a.message);
	let picker: any; let result: any;
	const ctx = { mode: "tui", hasUI: true, sessionManager: { getBranch: () => [a], getSessionId: () => "one" }, ui: {
		notify: () => {}, custom: (factory: any) => new Promise(resolve => { picker = factory({ terminal: { rows: 20 }, requestRender() {} }, theme, new KeybindingsManager(TUI_KEYBINDINGS), resolve); }) } } as any;
	try {
		assert.equal(r.events.has("session_switch"), false);
		result = r.jump("", ctx); assert.ok(picker);
		// Pi emits session_shutdown before replacing the extension runtime during /new.
		r.events.get("session_shutdown")({ reason: "new" });
		await result; assert.equal(h.transcriptScrollView.scrollTop, 0);
	} finally {
		r.events.get("session_shutdown")({ reason: "quit" });
		// Replacement shutdown releases ownership; the next runtime can reclaim and clean up.
		installBridge(Symbol()).release(true);
	}
});
