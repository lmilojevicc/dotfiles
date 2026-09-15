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

function setup(rows: readonly ExtensionManagerRow[], initialHeight = 19, initialWidth = 100, theme = plainTheme) {
	const desired = new Map(rows.map((item) => [item.id, item.enabled]));
	const done: ExtensionManagerResult[] = [];
	let changed = 0;
	const terminal = { height: initialHeight, width: initialWidth };
	const component = new ExtensionManagerComponent({
		rows,
		theme: theme as never,
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

test("rounded frame uses themed borders, one-cell padding, and exact ANSI-safe widths", () => {
	const calls: Array<{ role: string; value: string }> = [];
	const ansiTheme = {
		fg: (role: string, value: string) => {
			calls.push({ role, value });
			return `\x1b[36m${value}\x1b[39m`;
		},
		bold: (value: string) => `\x1b[1m${value}\x1b[22m`,
	};
	const rows = Array.from({ length: 20 }, (_, index) => row(`界😀-${index}`));
	const { component } = setup(rows, 19, 64, ansiTheme);
	const lines = component.render(64);

	assert.equal(lines.length, 19);
	assert.ok(calls.some(({ role, value }) => role === "border" && /^╭─+╮$/.test(value)));
	assert.ok(calls.some(({ role, value }) => role === "border" && value === "│"));
	assert.ok(calls.some(({ role, value }) => role === "border" && /^╰─+╯$/.test(value)));
	assert.ok(calls.some(({ role }) => role === "borderMuted"));
	for (const line of lines) assert.equal(visibleWidth(line), 64, JSON.stringify(line));

	const plain = setup(rows, 19, 64).component.render(64);
	assert.match(plain[0], /^╭─{62}╮$/);
	assert.match(plain.at(-1)!, /^╰─{62}╯$/);
	for (const line of plain.slice(1, -1)) {
		assert.ok(line.startsWith("│ ") && line.endsWith(" │"));
		assert.equal(visibleWidth(line), 64);
	}
});

test("frame accounting preserves adaptive one-to-ten-row list capacity", () => {
	const rows = Array.from({ length: 20 }, (_, index) => row(`item-${index}`));
	for (const [height, count] of [[10, 1], [13, 4], [19, 10]] as const) {
		const { component } = setup(rows, height, 80);
		const lines = component.render(80);
		assert.equal(lines.length, height);
		assert.equal(lines.join("\n").match(/\[[ x]\]/g)?.length, count);
		assert.equal(visibleWidth(lines[0]), 80);
		assert.equal(visibleWidth(lines.at(-1)!), 80);
	}
});

test("navigation wraps, pages clamp, and actions stay outside filtering", () => {
	const rows = Array.from({ length: 12 }, (_, index) => row(`item-${index}`));
	const { component, done } = setup(rows, 14);
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

test("resize recomputes framed capacity and stale frames cannot toggle or apply", () => {
	const rows = Array.from({ length: 20 }, (_, index) => row(`item-${index}`));
	const { component, desired, terminal } = setup(rows, 19, 80);
	assert.equal(component.render(80).join("\n").match(/\[[ x]\]/g)?.length, 10);
	terminal.height = 13;
	component.handleInput(enter);
	assert.equal(desired.get(rows[0].id), true);
	assert.equal(component.render(80).join("\n").match(/\[[ x]\]/g)?.length, 4);
	component.handleInput(enter);
	assert.equal(desired.get(rows[0].id), false);
});

test("feasible Resize required layouts use a compact themed frame without enabling actions", () => {
	const disabled = row("disabled", { enabled: false });
	for (const [width, height] of [[35, 8], [24, 17]] as const) {
		const { component } = setup([disabled], height, width);
		const lines = component.render(width);
		assert.equal(lines.length, 4);
		assert.equal(lines[0], `╭${"─".repeat(width - 2)}╮`);
		assert.equal(lines.at(-1), `╰${"─".repeat(width - 2)}╯`);
		assert.ok(lines[1].startsWith("│ Resize required") && lines[1].endsWith(" │"));
		assert.ok(lines[2].startsWith("│ Esc cancel") && lines[2].endsWith(" │"));
		for (const line of lines) assert.equal(visibleWidth(line), width);
	}

	const borderCalls: string[] = [];
	const themed = setup([disabled], 8, 35, {
		fg: (role: string, value: string) => {
			if (role === "border") borderCalls.push(value);
			return `\x1b[36m${value}\x1b[39m`;
		},
		bold: (value: string) => value,
	});
	const themedLines = themed.component.render(35);
	assert.ok(borderCalls.some((value) => /^╭─+╮$/.test(value)));
	assert.ok(borderCalls.includes("│"));
	assert.ok(borderCalls.some((value) => /^╰─+╯$/.test(value)));
	for (const line of themedLines) assert.equal(visibleWidth(line), 35);

	const blocked = setup([disabled], 19, 80);
	blocked.component.handleInput(down);
	assert.equal(blocked.component.getSelectedKind(), "apply");
	blocked.terminal.width = 24;
	blocked.terminal.height = 17;
	blocked.component.render(24);
	blocked.component.handleInput(enter);
	assert.equal(blocked.desired.get(disabled.id), false);
	assert.deepEqual(blocked.done, []);
	blocked.component.handleInput(escape);
	assert.deepEqual(blocked.done, ["cancel"]);
});

test("tiny layouts remain cancellable; focus, clipping, and Unicode widths are safe", () => {
	const long = row("界😀é".repeat(30));
	for (const width of [0, 1, 7, 19, 20, 24, 25, 26, 35]) {
		for (const height of [1, 2, 7, 8, 12, 17]) {
			const { component } = setup([long], height, width);
			const lines = component.render(width);
			assert.ok(lines.length <= height);
			for (const line of lines) assert.ok(visibleWidth(line) <= width, `${width}x${height}: ${JSON.stringify(line)}`);
		}
	}
	const disabledLong = { ...long, enabled: false };
	const tiny = setup([disabledLong], 2, 10);
	const tinyLines = tiny.component.render(10);
	assert.match(tinyLines[0], /Resize/);
	assert.doesNotMatch(tinyLines.join("\n"), /[╭╮╰╯│]/);
	for (const line of tinyLines) assert.ok(visibleWidth(line) <= 10);
	tiny.component.handleInput(enter);
	assert.equal(tiny.desired.get(disabledLong.id), false, "Resize state disables mutation");
	tiny.component.handleInput(escape);
	assert.deepEqual(tiny.done, ["cancel"]);

	const tooNarrow = setup([disabledLong], 17, 3);
	const tooNarrowLines = tooNarrow.component.render(3);
	assert.deepEqual(tooNarrowLines.map((line) => line.slice(0, 3)), ["Res", "Esc"]);
	assert.ok(tooNarrowLines.every((line) => visibleWidth(line) === 3));
	assert.doesNotMatch(tooNarrowLines.join("\n"), /[╭╮╰╯│]/);

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
