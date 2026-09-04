import assert from "node:assert/strict";
import test from "node:test";
import { CURSOR_MARKER, KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { ModelPickerComponent } from "../component.ts";
import { model, keys, plainTheme } from "./fixtures.ts";

const up = "\x1b[A", down = "\x1b[B", tab = "\t", escape = "\x1b";
const entries = [model("alpha", "shared", "First"), model("beta", "shared", "Second"), model("beta", "other")];
function setup(options: Partial<ConstructorParameters<typeof ModelPickerComponent>[0]> = {}) {
	const selected: unknown[] = [];
	let cancelled = 0, changed = 0;
	const component = new ModelPickerComponent({
		models: entries, current: entries[1], scoped: false, theme: plainTheme,
		keybindings: keys(), getHeight: () => 16,
		onChange: () => changed++, onSelect: (model) => selected.push(model), onCancel: () => cancelled++,
		...options,
	});
	component.focused = true;
	component.render(100);
	return { component, selected, cancelled: () => cancelled, changed: () => changed };
}

test("initial provider-qualified current preselection and marker differ from highlight", () => {
	const { component } = setup();
	assert.equal(component.getSelectedModel(), entries[1]);
	component.handleInput(down);
	const render = component.render(100).join("\n");
	assert.match(render, / \* beta\/shared/);
	assert.match(render, />  beta\/other/);
	assert.equal(component.getSelectedModel(), entries[2]);
});

test("scope changes preserve query and identity; zero-match scope stays explicit", () => {
	const { component } = setup();
	component.handleInput("shared");
	component.handleInput(tab);
	component.handleInput(down); // alpha
	assert.equal(component.getScope(), "alpha");
	assert.equal(component.getSelectedModel(), entries[0]);
	component.handleInput(down); // beta
	assert.equal(component.getScope(), "beta");
	assert.equal(component.getSelectedModel(), entries[1]);
	assert.equal(component.getQuery(), "shared");
	component.handleInput(escape);
	component.handleInput("First");
	assert.equal(component.getSelectedModel(), undefined);
	const render = component.render(100).join("\n");
	assert.match(render, /beta \(0\)/);
	assert.match(render, /alpha \(1\)/);
	assert.match(render, /All \(1\)/);
	assert.match(render, /No matching models/);
});

test("query refinement preserves a sensible identity but promotes stronger tier", () => {
	const { component } = setup();
	component.handleInput("shared");
	assert.equal(component.getSelectedModel(), entries[1]);
	component.handleInput(escape);
	component.handleInput("First");
	assert.equal(component.getSelectedModel(), entries[0]);
});

test("Tab and Shift+Tab focus panes; provider confirm only returns to models", () => {
	const { component, selected } = setup();
	component.handleInput(tab);
	assert.equal(component.getPane(), "providers");
	component.handleInput(down);
	component.handleInput("\r");
	assert.equal(component.getPane(), "models");
	assert.equal(selected.length, 0);
	component.handleInput("\x1b[Z");
	assert.equal(component.getPane(), "providers");
	component.handleInput("\x1b[Z");
	component.render(100);
	component.handleInput("\r");
	assert.deepEqual(selected, [entries[0]]);
	component.handleInput("\r");
	assert.equal(selected.length, 1, "closed UI cannot select twice");
});

test("arrows and page keys scroll focused provider/results windows", () => {
	const many = Array.from({ length: 30 }, (_, i) => model(`p${String(i).padStart(2, "0")}`, `model-${i}`));
	const { component } = setup({ models: many, current: many[0], getHeight: () => 10 });
	component.render(80);
	component.handleInput("\x1b[6~");
	assert.equal(component.getSelectedModel(), many[4]);
	for (let i = 0; i < 23; i++) component.handleInput(down);
	assert.match(component.render(80).join("\n"), /p27\/model-27/);
	assert.doesNotMatch(component.render(80).join("\n"), /p00\/model-0/);
	component.handleInput(tab);
	component.handleInput(up); // wraps All -> last provider
	assert.equal(component.getScope(), "p29");
	assert.match(component.render(80).join("\n"), /> p29 \(1\)/);
	component.handleInput("\x1b[5~");
	assert.equal(component.getScope(), "p25");
});

test("injected native selection bindings and hints are honored", () => {
	const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
		"tui.select.down": "ctrl+n", "tui.select.up": "ctrl+p",
		"tui.select.confirm": "ctrl+s", "tui.select.cancel": "ctrl+q",
	});
	const { component, selected } = setup({ keybindings });
	component.handleInput("\x0e");
	assert.equal(component.getSelectedModel(), entries[2]);
	assert.match(component.render(180).join("\n"), /ctrl\+s switch \+ save/);
	component.handleInput("\x13");
	assert.deepEqual(selected, [entries[2]]);
});

test("left/right and home/end edit search rather than switching panes", () => {
	const { component } = setup();
	component.handleInput("ac");
	component.handleInput("\x1b[D");
	component.handleInput("b");
	assert.equal(component.getQuery(), "abc");
	assert.equal(component.getPane(), "models");
	component.handleInput("\x01");
	component.handleInput("z");
	assert.equal(component.getQuery(), "zabc");
	component.handleInput("\x05");
	component.handleInput("d");
	assert.equal(component.getQuery(), "zabcd");
});

test("Escape clears query then cancels without mutation; disposal prevents stale renders", () => {
	const { component, cancelled, selected, changed } = setup();
	component.handleInput("test");
	component.handleInput(escape);
	assert.equal(component.getQuery(), "");
	assert.equal(cancelled(), 0);
	component.handleInput(escape);
	assert.equal(cancelled(), 1);
	const renders = changed();
	component.handleInput("x");
	component.handleInput("\r");
	assert.equal(changed(), renders);
	assert.deepEqual(selected, []);
});

test("Input focus and invalidation propagate with cursor-safe rendering", () => {
	const { component } = setup();
	assert.ok(component.render(80).some((line) => line.includes(CURSOR_MARKER)));
	component.invalidate();
	component.focused = false;
	assert.ok(component.render(80).every((line) => !line.includes(CURSOR_MARKER)));
});

test("no models differs from no search matches", () => {
	const { component } = setup({ models: [] });
	assert.match(component.render(80).join("\n"), /No models available/);
	const other = setup().component;
	other.handleInput("zzzzzz");
	assert.match(other.render(80).join("\n"), /No matching models/);
});

test("narrow/short layouts keep active pane navigable and all Unicode lines within bounds", () => {
	const long = model("界😀é".repeat(40), "モデル👨‍👩‍👧‍👦".repeat(40), "Long 名称");
	for (const height of [1, 2, 3, 5, 7, 8, 10, 20]) {
		for (const width of [0, 1, 2, 3, 7, 12, 20, 40, 63, 64, 80, 120]) {
			const { component } = setup({ models: [long], current: long, getHeight: () => height });
			for (const pane of ["models", "providers"]) {
				if (pane === "providers") component.handleInput(tab);
				for (const query of ["", "界😀é".repeat(50)]) {
					if (query) component.handleInput(query);
					const lines = component.render(width);
					assert.ok(lines.length <= height, `${width}x${height}`);
					for (const line of lines) assert.ok(visibleWidth(line) <= width, `${width}x${height}: ${visibleWidth(line)} ${JSON.stringify(line)}`);
				}
			}
		}
	}
});

test("compact rendering avoids empty padding and keeps pane/save/cancel hints visible", () => {
	const { component } = setup();
	const lines = component.render(35);
	assert.match(lines.at(-1)!, /Tab · enter save · Esc close/);
	assert.ok(lines.length < 12);
	component.handleInput(tab);
	assert.match(component.render(35).at(-1)!, /Tab · enter models · Esc close/);
});

for (const width of [20, 21, 25, 35]) test(`compact hints retain confirm/cancel actions and active scope at width ${width}`, () => {
	const { component } = setup({ getHeight: () => 4 });
	let lines = component.render(width);
	assert.match(lines.join("\n"), /All/);
	assert.match(lines.at(-1)!, /[Ee]nter save.*Esc close/);
	assert.match(lines.join("\n"), />\* beta\/shared/);
	component.handleInput(tab); component.handleInput(down);
	lines = component.render(width);
	assert.match(lines.join("\n"), /alpha/);
	assert.match(lines.at(-1)!, /[Ee]nter (back|models).*Esc close/);
	assert.doesNotMatch(lines.at(-1)!, /save/);
	component.handleInput("shared");
	assert.match(component.render(width).at(-1)!, /Esc clear/);
});

for (const height of [1, 2, 3, 4]) test(`height ${height} shows selection and controls or disables mutation`, () => {
	const { component, selected } = setup({ getHeight: () => height });
	for (const width of [7, 19, 20, 25, 80]) {
		const lines = component.render(width);
		const initial = component.getSelectedModel();
		if (height < 4 || width < 20) {
			assert.match(lines[0], /Resize/);
			for (const key of [down, tab, "shared", "\r"]) component.handleInput(key);
			assert.equal(component.getSelectedModel(), initial);
			assert.equal(component.getPane(), "models");
			assert.equal(component.getQuery(), "");
			assert.deepEqual(selected, []);
		} else {
			assert.match(lines.join("\n"), /Search:/);
			assert.match(lines.join("\n"), />\* beta\/shared/);
			assert.match(lines.at(-1)!, /[Ee]nter.*save.*Esc close/);
		}
	}
	component.handleInput("\r");
	assert.equal(selected.length, height === 4 ? 1 : 0);
});

test("confirmation waits for the selected model to render, including return from providers and resize", () => {
	let height = 4;
	const { component, selected, cancelled } = setup({ getHeight: () => height });
	component.render(20);
	component.handleInput(down); component.handleInput("\r");
	assert.deepEqual(selected, []);
	assert.match(component.render(20).join("\n"), />  beta\/other/);
	component.handleInput(tab); component.render(20); component.handleInput("\r"); component.handleInput("\r");
	assert.deepEqual(selected, []);
	height = 1;
	assert.match(component.render(20)[0], /Resize required/);
	component.handleInput("\r");
	assert.deepEqual(selected, []);
	component.handleInput(escape);
	assert.equal(cancelled(), 1);
});

test("resize before repaint disables confirmation and navigation until the new frame is visible", () => {
	let width = 80, height = 10;
	const { component, selected } = setup({ getWidth: () => width, getHeight: () => height });
	component.render(width);
	width = 1;
	component.handleInput(down); component.handleInput("\r");
	assert.equal(component.getSelectedModel(), entries[1]);
	assert.deepEqual(selected, []);
	width = 80; height = 1;
	component.handleInput(down); component.handleInput("\r");
	assert.equal(component.getSelectedModel(), entries[1]);
	assert.deepEqual(selected, []);
	height = 4;
	component.render(width);
	component.handleInput("\r");
	assert.deepEqual(selected, [entries[1]]);
});
