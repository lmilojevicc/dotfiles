import assert from "node:assert/strict";
import test from "node:test";
import { CURSOR_MARKER, Input, KeybindingsManager, StdinBuffer, TUI_KEYBINDINGS, getKeybindings, setKeybindings, visibleWidth, type Keybinding } from "@earendil-works/pi-tui";
import { ModelPickerComponent } from "../component.ts";
import { keys, model, plainTheme } from "./fixtures.ts";

const down = "\x1b[B", up = "\x1b[A", esc = "\x1b", enter = "\r";
const models = Array.from({ length: 30 }, (_, i) => model(i < 15 ? "alpha" : "beta", `model-${String(i).padStart(2, "0")}`));
function setup(options: Partial<ConstructorParameters<typeof ModelPickerComponent>[0]> = {}) {
	const selected: unknown[] = []; let cancelled = 0, toggles = 0, changed = 0;
	const component = new ModelPickerComponent({ models, current: models[0], scoped: false, vimMode: true,
		theme: plainTheme, keybindings: keys(), getHeight: () => 16,
		onChange: () => changed++, onSelect: (item) => selected.push(item), onCancel: () => cancelled++,
		onToggleFavorite: () => { toggles++; return []; }, ...options });
	component.focused = true; component.render(100);
	return { component, selected, cancelled: () => cancelled, toggles: () => toggles, changed: () => changed };
}
const cursor = (component: ModelPickerComponent) => component.render(100).some((line) => line.includes(CURSOR_MARKER));

test("Vim NORMAL j/k mirror arrows; h/l focus without wrapping, filtering or selecting", () => {
	const f = setup(), native = setup({ vimMode: false }).component;
	assert.equal(f.component.getPane(), "models"); assert.equal(cursor(f.component), false);
	for (const [vim, arrow] of [["j", down], ["k", up], ["k", up], ["j", down]]) {
		f.component.handleInput(vim); native.handleInput(arrow);
		assert.equal(f.component.getSelectedModel(), native.getSelectedModel());
	}
	for (const key of ["h", "h"]) f.component.handleInput(key);
	assert.equal(f.component.getPane(), "providers"); assert.deepEqual(f.component.getScope(), { kind: "all" });
	f.component.handleInput("j"); f.component.handleInput("j");
	assert.deepEqual(f.component.getScope(), { kind: "provider", provider: "alpha" });
	f.component.handleInput(enter); assert.equal(f.component.getPane(), "models");
	assert.deepEqual(f.selected, []);
	f.component.handleInput("l"); f.component.handleInput("l"); f.component.handleInput("ignored text");
	assert.equal(f.component.getPane(), "models"); assert.equal(f.component.getQuery(), "");
	f.component.render(100); f.component.handleInput(enter); assert.deepEqual(f.selected, [models[0]]);
});

for (const exit of [enter, esc]) test(`Vim SEARCH ${JSON.stringify(exit)} retains query/pane/cursor and never saves`, () => {
	const f = setup(); f.component.handleInput("h"); f.component.handleInput("/");
	assert.equal(f.component.getQuery(), ""); assert.equal(cursor(f.component), true);
	for (const key of ["j", "k", "h", "l", "/"]) f.component.handleInput(key);
	assert.equal(f.component.getQuery(), "jkhl/"); assert.equal(f.component.getPane(), "providers");
	f.component.handleInput("\x1b[D"); f.component.handleInput(exit);
	assert.equal(cursor(f.component), false); assert.equal(f.component.getQuery(), "jkhl/");
	assert.equal(f.component.getPane(), "providers"); assert.deepEqual(f.selected, []); assert.equal(f.toggles(), 0);
	f.component.handleInput("/"); f.component.handleInput("x");
	assert.equal(f.component.getQuery(), "jkhlx/", "mode entry must preserve Input cursor");
	f.component.handleInput(esc); f.component.handleInput(esc);
	assert.equal(f.component.getQuery(), ""); assert.equal(f.cancelled(), 0);
	f.component.handleInput(esc); assert.equal(f.cancelled(), 1);
});

test("SEARCH Enter with a visible result returns to navigation before a later explicit save", () => {
	const f = setup(); f.component.handleInput("/"); f.component.handleInput("model"); f.component.render(100);
	f.component.handleInput(enter); assert.deepEqual(f.selected, []); assert.equal(f.toggles(), 0);
	assert.equal(f.component.getQuery(), "model");
	f.component.handleInput(enter); assert.deepEqual(f.selected, [models[0]]);
});

test("Vim search keeps Tab/arrows/page fallback navigation and left/right editing", () => {
	const f = setup(); f.component.handleInput("/"); f.component.handleInput("moel");
	f.component.handleInput("\x1b[D"); f.component.handleInput("\x1b[D"); f.component.handleInput("d");
	assert.equal(f.component.getQuery(), "model");
	f.component.handleInput(down); assert.equal(f.component.getSelectedModel(), models[1]);
	f.component.handleInput("\x1b[6~"); assert.notEqual(f.component.getSelectedModel(), models[1]);
	f.component.handleInput("\t"); assert.equal(f.component.getPane(), "providers");
	f.component.handleInput("\x1b[Z"); assert.equal(f.component.getPane(), "models"); assert.equal(cursor(f.component), true);
});

test("Vim explicit keys beat printable native remaps; search text beats global cancel remaps, including Kitty", () => {
	const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
		"tui.select.confirm": "j", "tui.select.cancel": "k", "tui.select.up": "h", "tui.select.down": "l", "tui.select.pageDown": "/",
	});
	const f = setup({ keybindings });
	const original = getKeybindings();
	setKeybindings(keybindings);
	try {
		f.component.handleInput("\x1b[106u"); assert.equal(f.component.getSelectedModel(), models[1]);
		f.component.handleInput("\x1b[107u"); assert.equal(f.component.getSelectedModel(), models[0]);
		f.component.handleInput("h"); assert.equal(f.component.getPane(), "providers");
		f.component.handleInput("l"); assert.equal(f.component.getPane(), "models");
		f.component.handleInput("\x1b[47u"); assert.equal(cursor(f.component), true);
		for (const code of [106, 107, 104, 108, 47]) f.component.handleInput(`\x1b[${code}u`);
		assert.equal(f.component.getQuery(), "jkhl/"); assert.deepEqual(f.selected, []); assert.equal(f.cancelled(), 0);
		f.component.handleInput(enter); assert.equal(cursor(f.component), false);
	} finally { setKeybindings(original); }
});

for (const searching of [false, true]) for (const action of ["up", "down", "pageUp", "pageDown", "confirm", "cancel"] as const) {
	test(`Vim ${searching ? "SEARCH" : "NORMAL"} native ${action} remapped Ctrl+F wins favorite`, () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, { [`tui.select.${action}`]: "ctrl+f" });
		const f = setup({ keybindings }); if (searching) f.component.handleInput("/");
		assert.doesNotMatch(f.component.render(100).join("\n"), /Ctrl\+F favorite/);
		f.component.handleInput("\x06"); assert.equal(f.toggles(), 0);
		if (searching && ["confirm", "cancel"].includes(action)) {
			assert.equal(cursor(f.component), false); assert.deepEqual(f.selected, []); assert.equal(f.cancelled(), 0);
		} else if (!searching && action === "confirm") assert.deepEqual(f.selected, [models[0]]);
		else if (!searching && action === "cancel") assert.equal(f.cancelled(), 1);
	});
}

test("Vim nonprintable native remaps remain available and Ctrl+F toggles in both modes", () => {
	const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.down": "ctrl+n", "tui.select.confirm": "ctrl+s", "tui.select.cancel": "ctrl+q" });
	const f = setup({ keybindings }); f.component.handleInput("\x0e"); assert.equal(f.component.getSelectedModel(), models[1]);
	f.component.render(100); f.component.handleInput("\x06"); assert.equal(f.toggles(), 1);
	f.component.handleInput("/"); f.component.render(100); f.component.handleInput("\x06"); assert.equal(f.toggles(), 2);
	f.component.handleInput("\x13"); assert.equal(cursor(f.component), false); assert.deepEqual(f.selected, []);
	f.component.handleInput("/"); f.component.handleInput("\x11"); assert.equal(cursor(f.component), false); assert.equal(f.cancelled(), 0);
});

for (const searching of [false, true]) test(`Vim ${searching ? "SEARCH" : "NORMAL"} paste bypasses all command routing, even split end markers`, () => {
	const chunks = ["\x1b[200~", "j", "k", "h", "l", "/", enter, esc, "\x06", "\t", "\x1b[20", "1~"];
	for (const fragmented of [false, true]) {
		const f = setup(), input = new Input(); if (searching) f.component.handleInput("/");
		for (const chunk of fragmented ? chunks : [chunks.join("")]) { f.component.handleInput(chunk); input.handleInput(chunk); }
		assert.equal(f.component.getQuery(), searching ? input.getValue() : "");
		assert.equal(f.component.getPane(), "models"); assert.deepEqual(f.selected, []); assert.equal(f.cancelled(), 0); assert.equal(f.toggles(), 0);
		if (!searching) assert.equal(f.component.getSelectedModel(), models[0]);
		f.component.handleInput(searching ? "z" : "j");
		if (searching) assert.equal(f.component.getQuery(), input.getValue() + "z");
		else assert.equal(f.component.getSelectedModel(), models[1]);
	}
});

test("installed StdinBuffer safely reassembles byte-fragmented paste start before Vim sees it", () => {
	const f = setup(), buffer = new StdinBuffer();
	buffer.on("data", (data) => f.component.handleInput(data));
	buffer.on("paste", (data) => f.component.handleInput(`\x1b[200~${data}\x1b[201~`));
	try {
		for (const byte of "\x1b[200~jkhl/\r\x1b\x06\x1b[201~") buffer.process(byte);
		assert.equal(f.component.getQuery(), ""); assert.equal(f.component.getSelectedModel(), models[0]);
		assert.deepEqual(f.selected, []); assert.equal(f.cancelled(), 0); assert.equal(f.toggles(), 0);
	} finally { buffer.destroy(); }
});

test("Vim focus follows host focus AND search; mode changes request render but do not jump viewport or rerank favorites", () => {
	const f = setup({ favorites: ["beta/model-20"], onToggleFavorite: () => [] });
	f.component.handleInput("\x06"); f.component.render(100);
	assert.equal(f.component.getSelectedModel(), models[20], "removing the first favorite defers re-ranking");
	f.component.handleInput("\x1b[6~"); f.component.render(100);
	const rows = () => f.component.render(100).filter((line) => /alpha\/model-|beta\/model-/.test(line));
	const before = rows(), height = f.component.render(100).length;
	for (const key of ["/", esc, "/", enter]) {
		const changes = f.changed(); f.component.handleInput(key); assert.ok(f.changed() > changes);
		assert.deepEqual(rows(), before); assert.equal(f.component.render(100).length, height);
	}
	f.component.focused = false; f.component.handleInput("/"); assert.equal(cursor(f.component), false);
	f.component.focused = true; assert.equal(cursor(f.component), true);
	f.component.handleInput(esc); assert.equal(cursor(f.component), false);
});

test("Vim tiny/raw-resize/disposed/invisible guards prevent commit and favorite writes, including in-flight paste", () => {
	let width = 100, height = 16, terminalHeight = 30;
	const f = setup({ getWidth: () => width, getHeight: () => height, getTerminalHeight: () => terminalHeight });
	f.component.handleInput("j"); f.component.handleInput(enter); f.component.handleInput("\x06");
	assert.deepEqual(f.selected, []); assert.equal(f.toggles(), 0);
	f.component.render(100); terminalHeight++;
	for (const key of ["j", "h", "/", enter, "\x06"]) f.component.handleInput(key);
	assert.equal(f.component.getSelectedModel(), models[1]); assert.equal(f.component.getPane(), "models");
	f.component.render(100); f.component.handleInput("/"); f.component.handleInput("\x1b[200~model");
	width = 20; f.component.handleInput("\x1b[201~"); assert.equal(f.component.getQuery(), "");
	height = 1; f.component.render(20); f.component.handleInput("\x06"); f.component.handleInput(enter);
	assert.deepEqual(f.selected, []); assert.equal(f.toggles(), 0);
	f.component.handleInput(esc); assert.equal(f.cancelled(), 1);
	f.component.handleInput("/"); f.component.handleInput(enter); f.component.handleInput("\x06");
	assert.deepEqual(f.selected, []); assert.equal(f.toggles(), 0);
});

for (const width of [20, 25, 35, 64, 100]) test(`Vim compact mode hints retain stable rows at width ${width}`, () => {
	const f = setup(); const normal = f.component.render(width);
	assert.match(normal.join("\n"), /\/ search/); assert.match(normal.join("\n"), /Enter save.*Esc close/);
	if (width >= 64) assert.match(normal.join("\n"), /j\/k move.*h\/l pane/);
	f.component.handleInput("/"); const search = f.component.render(width);
	assert.match(search.join("\n"), /Enter\/Esc navigate/); assert.equal(search.length, normal.length);
	assert.ok([...normal, ...search].every((line) => visibleWidth(line) <= width));
});

test("SEARCH left/right edit even when remapped as native selection actions", () => {
	const f = setup({ keybindings: new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.confirm": "left", "tui.select.down": "right" }) });
	f.component.handleInput("/"); f.component.handleInput("ac"); f.component.handleInput("\x1b[D");
	f.component.handleInput("b"); f.component.handleInput("\x1b[C"); f.component.handleInput("d");
	assert.equal(f.component.getQuery(), "abcd"); assert.equal(cursor(f.component), true);
	assert.deepEqual(f.selected, []);
});

for (const searching of [false, true]) test(`Vim ${searching ? "SEARCH" : "NORMAL"} tiny paste cannot close, navigate, toggle or save`, () => {
	let height = 16;
	const f = setup({ getHeight: () => height });
	if (searching) f.component.handleInput("/");
	height = 1; f.component.render(20);
	for (const chunk of ["\x1b[200~", esc, enter, "j", "h", "/", "\x06", "\x1b[201~"]) f.component.handleInput(chunk);
	assert.equal(f.component.getQuery(), ""); assert.equal(f.component.getSelectedModel(), models[0]);
	assert.equal(f.component.getPane(), "models"); assert.equal(f.cancelled(), 0); assert.equal(f.toggles(), 0); assert.deepEqual(f.selected, []);
});

for (const suffix of ["u", ";1u", ";1:1u", ";1:2u", ";65:1u", ";129:1u"]) {
	test(`SEARCH Kitty Backspace ${suffix} edits natively instead of inserting DEL`, () => {
		const original = getKeybindings(); setKeybindings(keys());
		try {
			const f = setup(), native = new Input();
			f.component.handleInput("/"); f.component.handleInput("abc"); native.handleInput("abc");
			const event = `\x1b[127${suffix}`;
			f.component.handleInput(event); native.handleInput(event);
			assert.equal(f.component.getQuery(), "ab"); assert.equal(f.component.getQuery(), native.getValue());
			assert.equal(cursor(f.component), true); assert.deepEqual(f.selected, []); assert.equal(f.cancelled(), 0);
		} finally { setKeybindings(original); }
	});

	test(`SEARCH Kitty keypad Enter ${suffix} retains query and exits without saving`, () => {
		const original = getKeybindings(); setKeybindings(keys());
		try {
			const f = setup(), native = new Input(); let submitted = 0;
			native.onSubmit = () => submitted++;
			f.component.handleInput("/"); f.component.handleInput("model"); f.component.render(100);
			const event = `\x1b[57414${suffix}`;
			native.handleInput(event); f.component.handleInput(event);
			assert.equal(submitted, 1, "installed Input recognizes this as Enter");
			assert.equal(f.component.getQuery(), "model"); assert.equal(cursor(f.component), false);
			assert.deepEqual(f.selected, []); assert.equal(f.cancelled(), 0); assert.equal(f.toggles(), 0);
		} finally { setKeybindings(original); }
	});
}

test("SEARCH printable Kitty, international and literal private-use text beat real global remaps", () => {
	const original = getKeybindings();
	const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
		"tui.select.cancel": ["j", "k"], "tui.select.confirm": "shift+a", "tui.editor.deleteCharBackward": "k",
	});
	setKeybindings(keybindings);
	try {
		const f = setup({ keybindings }); f.component.handleInput("/");
		const events = [
			["\x1b[106;1:1u", "j"], ["\x1b[107::106u", "k"], ["\x1b[97:65;2:1u", "A"],
			["\x1b[1080::106u", "и"], ["\x1b[233u", "é"], ["\x1b[20013u", "中"], ["\x1b[128512u", "😀"],
			["\x1b[57399u", "0"], ["Привет日本語e\u0301👩‍💻\ue046\ue100", "Привет日本語e\u0301👩‍💻\ue046\ue100"],
			["\x1b[20013::13u", "中"],
		];
		let query = "";
		for (const [event, value] of events) {
			f.component.handleInput(event); query += value;
			assert.equal(f.component.getQuery(), query); assert.equal(cursor(f.component), true);
			assert.equal(getKeybindings(), keybindings);
		}
		assert.deepEqual(f.selected, []); assert.equal(f.cancelled(), 0); assert.equal(f.toggles(), 0);
	} finally { setKeybindings(original); }
});

for (const cancel of ["left", "right"] as const) {
	for (const [label, left, right] of [
		["legacy", "\x1b[D", "\x1b[C"],
		["Kitty press", "\x1b[1;1:1D", "\x1b[1;1:1C"],
		["Kitty keypad", "\x1b[57417;1:1u", "\x1b[57418;1:1u"],
	]) test(`SEARCH ${label} cursors bypass real global cancel=${cancel} and confirm remaps without leakage`, () => {
		const original = getKeybindings();
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.select.cancel": [cancel, "ctrl+b", "ctrl+f"],
			"tui.select.confirm": cancel === "left" ? "right" : "left",
		});
		const bindings = keybindings.getResolvedBindings(), userBindings = keybindings.getUserBindings();
		setKeybindings(keybindings);
		try {
			const f = setup({ keybindings, onChange: () => assert.equal(getKeybindings(), keybindings) });
			f.component.handleInput("/"); f.component.handleInput("ac");
			for (const event of [left, "b", right, "d"]) {
				f.component.handleInput(event);
				assert.equal(getKeybindings(), keybindings);
				assert.deepEqual(keybindings.getResolvedBindings(), bindings);
				assert.deepEqual(keybindings.getUserBindings(), userBindings);
				if (event === "b") assert.equal(f.component.getQuery(), "abc");
			}
			assert.equal(f.component.getQuery(), "abcd"); assert.equal(cursor(f.component), true);
			assert.deepEqual(f.selected, []); assert.equal(f.cancelled(), 0); assert.equal(f.toggles(), 0);
			f.component.handleInput("\x06"); assert.equal(cursor(f.component), false, "non-arrow cancel remap still exits SEARCH");
			assert.equal(f.toggles(), 0); assert.equal(f.cancelled(), 0);
			f.component.handleInput(cancel === "left" ? left : right);
			assert.equal(f.component.getQuery(), "", "NORMAL still honors the arrow cancel remap");
		} finally { setKeybindings(original); }
	});

	test(`SEARCH cursor ${cancel} restores the global manager when native Input throws`, () => {
		const original = getKeybindings(), failure = new Error("native cursor binding failed");
		let attempted = false;
		const keybindings = new class extends KeybindingsManager {
			override matches(data: string, action: Keybinding): boolean {
				if (action === "tui.editor.cursorLeft") {
					attempted = true;
					assert.notEqual(getKeybindings(), this, "failure occurs inside the scoped Input call");
					assert.equal(getKeybindings().matches(data, "tui.select.cancel"), false);
					throw failure;
				}
				return super.matches(data, action);
			}
		}(TUI_KEYBINDINGS, { "tui.select.cancel": cancel });
		const bindings = keybindings.getResolvedBindings(), userBindings = keybindings.getUserBindings();
		setKeybindings(keybindings);
		try {
			const f = setup({ keybindings }); f.component.handleInput("/"); f.component.handleInput("ac");
			assert.throws(() => f.component.handleInput(cancel === "left" ? "\x1b[D" : "\x1b[C"), (error) => error === failure);
			assert.equal(attempted, true); assert.equal(getKeybindings(), keybindings);
			assert.deepEqual(keybindings.getResolvedBindings(), bindings);
			assert.deepEqual(keybindings.getUserBindings(), userBindings);
			assert.equal(f.component.getQuery(), "ac"); assert.equal(cursor(f.component), true);
			assert.deepEqual(f.selected, []); assert.equal(f.cancelled(), 0);
		} finally { setKeybindings(original); }
	});
}

test("SEARCH native nonprintable remaps still precede editing outside the physical cursor exception", () => {
	const original = getKeybindings();
	const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
		"tui.select.cancel": "backspace", "tui.select.confirm": ["ctrl+s", "shift+enter"],
		"tui.editor.deleteCharBackward": "ctrl+x",
	});
	setKeybindings(keybindings);
	try {
		const f = setup({ keybindings }); f.component.handleInput("/"); f.component.handleInput("model");
		f.component.handleInput("\x18"); assert.equal(f.component.getQuery(), "mode");
		for (const exit of ["\x1b[127;1:1u", "\x1b[115;5:1u", "\x1b[57414;2:1u", esc]) {
			f.component.handleInput(exit);
			assert.equal(cursor(f.component), false); assert.equal(f.component.getQuery(), "mode");
			assert.equal(getKeybindings(), keybindings); assert.deepEqual(f.selected, []); assert.equal(f.cancelled(), 0);
			f.component.handleInput("/");
		}
	} finally { setKeybindings(original); }
});
