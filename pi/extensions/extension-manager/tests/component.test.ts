import assert from "node:assert/strict";
import test from "node:test";
import { CURSOR_MARKER, KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import {
	ExtensionManagerComponent,
	extensionViewport,
	filterExtensionRows,
	type ExtensionManagerResult,
	type ExtensionManagerRow,
} from "../component.ts";

const up = "\x1b[A", down = "\x1b[B", pageDown = "\x1b[6~", enter = "\r", escape = "\x1b";
const plainTheme = {
	fg: (_color: string, value: string) => value,
	bold: (value: string) => value,
};
const keys = () => new KeybindingsManager(TUI_KEYBINDINGS);
const row = (name: string, options: Partial<ExtensionManagerRow> = {}): ExtensionManagerRow => ({
	id: `/extensions/${name}/index.ts`,
	label: `local · extensions/${name}/index.ts`,
	searchText: `local extensions ${name} /extensions/${name}/index.ts top-level`,
	enabled: true,
	...options,
});

function setup(rows: readonly ExtensionManagerRow[], initialHeight = 17, initialWidth = 100) {
	const desired = new Map(rows.map((item) => [item.id, item.enabled]));
	const done: ExtensionManagerResult[] = [];
	let changed = 0;
	const terminal = { height: initialHeight, width: initialWidth };
	const component = new ExtensionManagerComponent({
		rows,
		theme: plainTheme as never,
		keybindings: keys(),
		getHeight: () => terminal.height,
		getWidth: () => terminal.width,
		getTerminalHeight: () => terminal.height,
		getEnabled: (item) => desired.get(item.id) ?? item.enabled,
		getStagedCount: () => rows.filter((item) => desired.get(item.id) !== item.enabled).length,
		onToggle: (item) => desired.set(item.id, !(desired.get(item.id) ?? item.enabled)),
		onChange: () => changed++,
		onDone: (result) => done.push(result),
	});
	component.focused = true;
	component.render(initialWidth);
	return { component, desired, done, terminal, changed: () => changed };
}

test("search covers extension identity fields and fuzzy-ranks matches", () => {
	const rows = [
		row("other", { searchText: "npm:other fuzzy src search package" }),
		row("fuzzy-search", { searchText: "fuzzy-search local extensions/fuzzy-search/index.ts top-level" }),
		row("日本語", { searchText: "npm:国際 packages/日本語/index.ts package" }),
	];
	assert.equal(filterExtensionRows(rows, "FUZZY search")[0], rows[1]);
	assert.deepEqual(filterExtensionRows(rows, "国際"), [rows[2]]);
	assert.deepEqual(filterExtensionRows(rows, "missing"), []);
	assert.deepEqual(filterExtensionRows(rows, ""), rows);
});

test("centered viewport clamps at head, middle, and tail", () => {
	assert.deepEqual(extensionViewport(0, 20, 10), { start: 0, end: 10 });
	assert.deepEqual(extensionViewport(12, 20, 10), { start: 7, end: 17 });
	assert.deepEqual(extensionViewport(19, 20, 10), { start: 10, end: 20 });
});

test("bounded render reports exact hidden counts above and below", () => {
	const rows = Array.from({ length: 20 }, (_, index) => row(`item-${String(index).padStart(2, "0")}`));
	const { component } = setup(rows);
	let output = component.render(100).join("\n");
	assert.match(output, /↓ 10 more/);
	assert.doesNotMatch(output, /↑ \d+ more/);
	assert.equal(output.match(/\[[ x]\]/g)?.length, 10);

	for (let index = 0; index < 12; index++) component.handleInput(down);
	output = component.render(100).join("\n");
	assert.match(output, /↑ 7 more/);
	assert.match(output, /↓ 3 more/);
	assert.match(output, /› \[x\] local · extensions\/item-12/);

	for (let index = 12; index < 19; index++) component.handleInput(down);
	output = component.render(100).join("\n");
	assert.match(output, /↑ 10 more/);
	assert.doesNotMatch(output, /↓ \d+ more/);
});

test("navigation wraps, pages clamp, and actions stay outside filtering", () => {
	const rows = Array.from({ length: 12 }, (_, index) => row(`item-${index}`));
	const { component, done } = setup(rows, 12);
	component.handleInput(up);
	assert.equal(component.getSelectedKind(), "cancel");
	component.handleInput(down);
	assert.equal(component.getSelectedKind(), "extension");
	component.handleInput(pageDown);
	assert.equal(component.getSelectedRow(), rows[5]);
	component.handleInput("no-match");
	assert.equal(component.getFilteredRows().length, 0);
	assert.equal(component.getSelectedKind(), "apply");
	assert.match(component.render(80).join("\n"), /No matching extensions/);
	assert.match(component.render(80).join("\n"), /Apply changes and reload/);
	component.handleInput(down);
	component.handleInput(enter);
	assert.deepEqual(done, ["cancel"]);
});

test("toggles remain staged across searches and Apply returns all staged state", () => {
	const rows = [row("alpha"), row("beta"), row("gamma")];
	const { component, desired, done } = setup(rows);
	component.handleInput(enter);
	component.handleInput("beta");
	assert.equal(component.getSelectedRow(), rows[1]);
	component.handleInput(enter);
	assert.equal(desired.get(rows[0].id), false);
	assert.equal(desired.get(rows[1].id), false);
	assert.match(component.render(100).join("\n"), /Extensions \(2 staged\)/);
	component.handleInput(down);
	assert.equal(component.getSelectedKind(), "apply");
	component.handleInput(enter);
	assert.deepEqual(done, ["apply"]);
});

for (const [name, space] of [["raw", " "], ["Kitty CSI-u", "\x1b[32u"]] as const) {
	test(`${name} Space edits a nonempty query but toggles when search is empty`, () => {
		const rows = [row("alpha beta"), row("other")];
		const searching = setup(rows);
		searching.component.handleInput("alpha");
		searching.component.handleInput(space);
		assert.equal(searching.component.getQuery(), "alpha ");
		assert.equal(searching.desired.get(rows[0].id), true);

		const empty = setup(rows);
		empty.component.handleInput(space);
		assert.equal(empty.component.getQuery(), "");
		assert.equal(empty.desired.get(rows[0].id), false);
	});
}

test("resize recomputes capacity and stale frames cannot toggle or apply", () => {
	const rows = Array.from({ length: 20 }, (_, index) => row(`item-${index}`));
	const { component, desired, terminal } = setup(rows, 17, 80);
	assert.equal(component.render(80).join("\n").match(/\[[ x]\]/g)?.length, 10);
	terminal.height = 11;
	component.handleInput(enter);
	assert.equal(desired.get(rows[0].id), true);
	assert.equal(component.render(80).join("\n").match(/\[[ x]\]/g)?.length, 4);
	component.handleInput(enter);
	assert.equal(desired.get(rows[0].id), false);
});

test("tiny layouts remain cancellable; focus, clipping, and Unicode widths are safe", () => {
	const long = row("界😀é".repeat(30));
	for (const width of [0, 1, 7, 19, 20, 35]) {
		for (const height of [1, 2, 7, 8, 12, 17]) {
			const { component } = setup([long], height, width);
			const lines = component.render(width);
			assert.ok(lines.length <= height);
			for (const line of lines) assert.ok(visibleWidth(line) <= width, `${width}x${height}: ${JSON.stringify(line)}`);
		}
	}
	const tiny = setup([long], 2, 10);
	assert.match(tiny.component.render(10)[0], /Resize/);
	tiny.component.handleInput(enter);
	assert.equal(tiny.desired.get(long.id), true);
	tiny.component.handleInput(escape);
	assert.deepEqual(tiny.done, ["cancel"]);

	const focused = setup([long]);
	assert.ok(focused.component.render(80).some((line) => line.includes(CURSOR_MARKER)));
	focused.component.focused = false;
	assert.ok(focused.component.render(80).every((line) => !line.includes(CURSOR_MARKER)));
});

test("remapped native bindings control navigation, confirmation, and cancellation", () => {
	const rows = [row("alpha"), row("beta")];
	const done: ExtensionManagerResult[] = [];
	const component = new ExtensionManagerComponent({
		rows, theme: plainTheme as never,
		keybindings: new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.select.down": "ctrl+n", "tui.select.confirm": "ctrl+s", "tui.select.cancel": "ctrl+q",
		}),
		getHeight: () => 17, getEnabled: (item) => item.enabled, getStagedCount: () => 0,
		onToggle: () => {}, onChange: () => {}, onDone: (result) => done.push(result),
	});
	component.render(80);
	component.handleInput("\x0e");
	assert.equal(component.getSelectedRow(), rows[1]);
	component.handleInput("\x13");
	component.handleInput("\x11");
	assert.deepEqual(done, ["cancel"], "toggle confirmation does not close; remapped cancel does");
});
