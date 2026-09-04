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
	assert.match(render, /   \* beta\/shared/);
	assert.match(render, /❯    alpha\/shared/);
	assert.equal(component.getSelectedModel(), entries[0]);
});

test("scope changes preserve query and identity; zero-match scope stays explicit", () => {
	const { component } = setup();
	component.handleInput("shared");
	component.handleInput(tab);
	component.handleInput(down); // Favorites
	component.handleInput(down); // alpha
	assert.deepEqual(component.getScope(), { kind: "provider", provider: "alpha" });
	assert.equal(component.getSelectedModel(), entries[0]);
	component.handleInput(down); // beta
	assert.deepEqual(component.getScope(), { kind: "provider", provider: "beta" });
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
	component.handleInput(down); // Favorites
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
	assert.equal(component.getSelectedModel(), many[3], "three physical body rows after frame and footer");
	for (let i = 0; i < 20; i++) component.handleInput(down);
	assert.match(component.render(80).join("\n"), /p23\/model-23/);
	assert.doesNotMatch(component.render(80).join("\n"), /p00\/model-0/);
	component.handleInput(tab);
	component.handleInput(up); // wraps All -> last provider
	assert.deepEqual(component.getScope(), { kind: "provider", provider: "p29" });
	assert.match(component.render(80).join("\n"), /❯ p29 \(1\)/);
	component.handleInput("\x1b[5~");
	assert.deepEqual(component.getScope(), { kind: "provider", provider: "p26" });
});

test("injected native selection bindings and hints are honored", () => {
	const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
		"tui.select.down": "ctrl+n", "tui.select.up": "ctrl+p",
		"tui.select.confirm": "ctrl+s", "tui.select.cancel": "ctrl+q",
	});
	const { component, selected } = setup({ keybindings });
	component.handleInput("\x0e");
	assert.equal(component.getSelectedModel(), entries[0]);
	assert.match(component.render(180).join("\n"), /ctrl\+s save/);
	component.handleInput("\x13");
	assert.deepEqual(selected, [entries[0]]);
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
	for (const height of [1, 2, 3, 4, 5, 7, 8, 10, 20]) {
		for (const width of [0, 1, 2, 3, 7, 12, 20, 21, 25, 40, 63, 64, 80, 120]) {
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

test("compact rounded frame packs primary hints before secondary hints", () => {
	const { component } = setup();
	const lines = component.render(35);
	assert.match(lines[0], /^╭─/);
	assert.match(lines.at(-1)!, /^╰─/);
	assert.match(lines.join("\n"), /Enter save · Esc close/);
	assert.match(lines.join("\n"), /Tab pane/);
	assert.ok(lines.length <= 12);
	component.handleInput(tab);
	assert.match(component.render(35).join("\n"), /Enter back · Esc close/);
});

for (const width of [20, 21, 25, 35]) test(`compact hints retain confirm/cancel actions and active scope at width ${width}`, () => {
	const { component } = setup({ getHeight: () => 4 });
	let lines = component.render(width);
	assert.match(lines.join("\n"), /All/);
	assert.match(lines.at(-1)!, /[Ee]nter save.*Esc close/);
	assert.match(lines.join("\n"), /❯  \* beta\/shared/);
	component.handleInput(tab); component.handleInput(down); component.handleInput(down);
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
			assert.match(lines.join("\n"), /❯  \* beta\/shared/);
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
	assert.match(component.render(20).join("\n"), /❯    alpha\/shared/);
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

const favoriteKey = (item: { provider: string; id: string }) => `${item.provider}/${item.id}`;

test("legacy favorites order, distinct current marker and opening preferences", () => {
	for (const [favorites, current, expected] of [
		[["beta/other", "alpha/shared"], entries[1], entries[2]],
		[["beta/other", "beta/shared"], entries[1], entries[1]],
		[["missing/model"], entries[1], entries[1]],
		[["missing/model"], undefined, entries[0]],
	] as const) {
		const { component } = setup({ favorites, current });
		assert.equal(component.getSelectedModel(), expected);
		const rows = component.render(100).filter((line) => /\/(shared|other)/.test(line));
		if (favorites[0] === "beta/other") {
			assert.match(rows[0], /★.*beta\/other/);
			assert.match(rows[1], /★/);
			assert.match(rows.join("\n"), /\* beta\/shared/);
		}
	}
});

test("add/remove/readd stars retain highlighted tuple, query and provider without reorder", () => {
	let saved = ["unavailable/model", "alpha/shared"];
	const { component } = setup({ favorites: saved, onToggleFavorite: (item) => {
		const id = favoriteKey(item);
		saved = saved.includes(id) ? saved.filter((value) => value !== id) : [...saved, id];
		return saved;
	} });
	component.handleInput("shared");
	component.handleInput(tab); component.handleInput(down); component.handleInput(down); component.handleInput(down); component.handleInput(tab);
	assert.deepEqual(component.getScope(), { kind: "provider", provider: "beta" });
	assert.equal(component.getSelectedModel(), entries[1]);
	for (const favorite of [true, false, true]) {
		component.render(100); component.handleInput("\x06");
		assert.equal(component.getSelectedModel(), entries[1]);
		assert.deepEqual(component.getScope(), { kind: "provider", provider: "beta" });
		assert.equal(component.getQuery(), "shared");
		const render = component.render(100).join("\n");
		assert.equal(/❯ ★\* shared/.test(render), favorite);
		assert.doesNotMatch(render, /beta\/shared/);
	}
	assert.deepEqual(saved, ["unavailable/model", "alpha/shared", "beta/shared"]);
});

test("failed favorite toggle never changes stars, highlight, query or scope; browsing and save still work", () => {
	const { component, selected } = setup({ onToggleFavorite: () => { throw Error("read-only"); } });
	component.handleInput("shared"); component.handleInput(tab); component.handleInput(down); component.handleInput(down); component.handleInput(tab);
	component.render(100); component.handleInput("\x06");
	assert.equal(component.getSelectedModel(), entries[0]);
	assert.equal(component.getQuery(), "shared"); assert.deepEqual(component.getScope(), { kind: "provider", provider: "alpha" });
	const lines = component.render(100).join("\n");
	assert.match(lines, /Favorites: read-only/); assert.doesNotMatch(lines, /★/);
	component.handleInput("\r"); assert.deepEqual(selected, [entries[0]]);
});

test("favorite toggle refuses providers, empty results, unrendered selection, stale resize, tiny and disposed UI", () => {
	let calls = 0, width = 80, height = 12;
	const { component } = setup({ getWidth: () => width, getHeight: () => height, onToggleFavorite: () => { calls++; return []; } });
	component.render(width);
	component.handleInput(tab); component.render(width); component.handleInput("\x06");
	component.handleInput(tab); component.handleInput("\x06"); // models not rendered yet
	component.render(width); component.handleInput(down); component.handleInput("\x06");
	component.render(width); width = 25; component.handleInput("\x06");
	component.render(width); height = 1; component.handleInput("\x06");
	component.render(width); component.handleInput("\x06");
	height = 4; component.render(width); component.handleInput("no-match-xyz"); component.render(width); component.handleInput("\x06");
	component.handleInput(escape); component.render(width); component.dispose(); component.handleInput("\x06");
	assert.equal(calls, 0);
});

for (const action of ["up", "down", "pageUp", "pageDown", "confirm", "cancel"]) test(`native ${action} remapped to Ctrl+F takes precedence and hides favorite hint`, () => {
	let calls = 0;
	const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, { [`tui.select.${action}`]: "ctrl+f" });
	const { component, selected, cancelled } = setup({ keybindings, onToggleFavorite: () => { calls++; return []; } });
	assert.doesNotMatch(component.render(120).join("\n"), /Ctrl\+F favorite/);
	component.handleInput("\x06");
	assert.equal(calls, 0);
	if (action === "confirm") assert.deepEqual(selected, [entries[1]]);
	else if (action === "cancel") assert.equal(cancelled(), 1);
	else if (action !== "pageUp") assert.notEqual(component.getSelectedModel(), entries[1]);
});

test("simplified rows omit repeated scope, headings, names, capabilities, prices and tutorials", () => {
	const { component } = setup({ scoped: true, favorites: ["beta/shared"], onToggleFavorite: () => [] });
	const all = component.render(100).join("\n");
	assert.match(all, /beta\/shared/); assert.match(all, /Ctrl\+F favorite/);
	component.handleInput(tab); component.handleInput(down); component.handleInput(down); component.handleInput(down); component.handleInput(tab);
	for (const width of [25, 63, 64, 100]) {
		const lines = component.render(width), rendered = lines.join("\n");
		assert.doesNotMatch(rendered, /Providers|Models|Matches|matches|models|Change provider|browse models|configure|context|output|Reasoning|image|per 1M|First|Second|beta\//);
		assert.equal((rendered.match(/\[session\]/g) ?? []).length, 1);
		assert.equal((rendered.match(/beta/g) ?? []).length, 1);
		assert.match(rendered, /❯ ★\* shared/);
	}
});

test("minimum layout preserves scope/session, cursor, visible row and save/cancel despite favorite error", () => {
	const { component, selected } = setup({ getHeight: () => 4, scoped: true, favoriteError: "Favorites: read-only", favorites: ["beta/shared"] });
	const lines = component.render(20);
	assert.match(lines[0], /All \[session\]/);
	assert.match(lines[1], /Favorites error:/);
	assert.ok(lines[1].includes(CURSOR_MARKER));
	assert.match(lines[2], /❯ ★\* beta\/shared/);
	assert.match(lines[3], /Enter save Esc close/);
	component.handleInput("\r"); assert.deepEqual(selected, [entries[1]]);
});
