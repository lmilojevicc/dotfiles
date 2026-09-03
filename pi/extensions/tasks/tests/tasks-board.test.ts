import test from "node:test";
import assert from "node:assert/strict";
import { CURSOR_MARKER, KeybindingsManager, setKeybindings, stripTerminalSequences, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_TASKS_CONFIG } from "../src/config/tasks-config.ts";
import type { TaskSnapshot } from "../src/domain/types.ts";
import {
	openTasksBoard,
	renderTasksBoard,
	TASKS_BOARD_OVERLAY_OPTIONS,
	TasksBoardComponent,
	type TasksBoardState,
} from "../src/ui/tasks-board.ts";
import { SPINNER_INTERVAL_MS } from "../src/ui/widget.ts";
import { plainTheme, snapshot, task } from "./helpers.ts";

const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
setKeybindings(keybindings);

function boardSnapshot(): TaskSnapshot {
	return snapshot([
		{ ...task(1, "completed", [], "Finished task"), description: "Archived description", createdAt: Date.UTC(2026, 0, 1), updatedAt: Date.UTC(2026, 0, 2) },
		{ ...task(2, "in_progress", [], "Assess pi-subagents integration"), activeForm: "Assessing pi-subagents integration", description: "Compare the live Fleet/status hierarchy; keep task truth separate.", metadata: { z: 2, a: 1 }, createdAt: Date.UTC(2026, 0, 3), updatedAt: Date.UTC(2026, 0, 4) },
		{ ...task(3, "pending", [2], "Add read-only Tasks board"), owner: "milo", createdAt: Date.UTC(2026, 0, 5), updatedAt: Date.UTC(2026, 0, 6) },
		task(4, "pending", [], "Test narrow terminal layouts"),
	]);
}

function state(overrides: Partial<TasksBoardState> = {}): TasksBoardState {
	return { selectedId: 2, filter: "All", collapseCompleted: true, query: "", searching: false, pane: "list", listOffset: 0, detailOffset: 0, frame: 0, ...overrides };
}

function render(width: number, terminalRows = 28, overrides: Partial<TasksBoardState> = {}, theme = plainTheme): string[] {
	return renderTasksBoard({
		snapshot: boardSnapshot(),
		activity: { activeTaskId: 2, metrics: { startedAt: 0, inputTokens: 9_000, outputTokens: 4_700 } },
		config: DEFAULT_TASKS_CONFIG,
		state: state(overrides),
		theme,
		keybindings,
		width,
		terminalRows,
		now: 464_000,
	});
}

function stripped(lines: string[]): string[] {
	return lines.map(stripTerminalSequences);
}

test("wide, medium, small, tiny, and short layouts obey geometry and exact fallback copy", () => {
	const wide = stripped(render(120));
	const medium = stripped(render(80));
	const small = stripped(render(50, 28, { pane: "detail" }));
	assert.ok(wide.some((line) => line.includes("┬")));
	assert.ok(wide.some((line) => line.includes("│") && line.includes("Details  #2")));
	assert.ok(!medium.some((line) => line.includes("┬")));
	assert.ok(!small.some((line) => line.includes("┬")));
	assert.ok(small.some((line) => line.includes("parent ↑ 9k ↓ 4.7k")));
	assert.deepEqual(render(20), ["Tasks board needs at", "least 36 columns.", "Esc closes."]);
	assert.deepEqual(render(50, 10), ["Tasks board needs at least 14 rows. Esc closes."]);
	for (const width of [120, 96, 80, 60, 50, 36, 20, 5, 1]) {
		const lines = render(width);
		assert.ok(lines.every((line) => visibleWidth(line) <= width), `width ${width}`);
		if (width >= 36) assert.ok(lines.every((line) => visibleWidth(line) === width), `framed width ${width}`);
	}
});

test("headers, controls, footers, detail order, telemetry attribution, and spinner are source-faithful", () => {
	const wide = stripped(render(120));
	assert.equal(wide[1], "│ ● Tasks · live, read-only                                                    4 tasks (1 done, 1 in progress, 2 open) │");
	assert.equal(wide[2], "│ Search: / to search                                                               Filter: All · Completed: collapsed │");
	assert.ok(wide.at(-2)?.includes("↑↓/jk task · Tab pane · / search · f filter · c completed · PgUp/PgDn scroll · Esc close"));
	const detail = [
		...stripped(render(80, 28, { pane: "detail" })),
		...stripped(render(80, 28, { pane: "detail", detailOffset: 8 })),
	].join("\n");
	for (const expected of ["parent ↑ 9k ↓ 4.7k", "Subject", "Description", "Status", "Blocked by", "Blocking", "Owner", "Created", "Updated", "Metadata", "Linked run  Not linked"]) assert.match(detail, new RegExp(expected));
	assert.ok(stripped(render(80)).some((line) => line.includes("✔ 1 completed")));
	const frames = ["✳", "✴", "✵", "✶", "✷", "✸", "✹", "✺", "✻", "✼", "✽"];
	assert.deepEqual(frames.map((_frame, frame) => stripped(render(80, 28, { frame }))[5]?.match(/[✳-✽]/u)?.[0]), frames);
	assert.equal(SPINNER_INTERVAL_MS, 150);
});

test("sanitizes hostile content, applies search roles, and remains width-safe", () => {
	const roles = new Set<string>();
	const theme: any = {
		...plainTheme,
		fg: (role: string, text: string) => { roles.add(role); return text; },
		bg: (role: string, text: string) => { roles.add(role); return text; },
		bold: (text: string) => text,
		strikethrough: (text: string) => text,
	};
	const hostile = boardSnapshot();
	hostile.tasks[1]!.subject = "safe\u001bc\u001bPpayload\u001b\\ tail " + "長".repeat(80);
	hostile.tasks[1]!.description = "description\nwith\ttabs\u001b]0;title\u0007";
	const lines = renderTasksBoard({ snapshot: hostile, activity: undefined, config: DEFAULT_TASKS_CONFIG, state: state({ query: "description", searching: true, collapseCompleted: false, pane: "detail" }), theme, keybindings, width: 50, terminalRows: 28 });
	renderTasksBoard({ snapshot: hostile, activity: undefined, config: DEFAULT_TASKS_CONFIG, state: state({ collapseCompleted: false }), theme, keybindings, width: 120, terminalRows: 28 });
	renderTasksBoard({ snapshot: hostile, activity: undefined, config: DEFAULT_TASKS_CONFIG, state: state({ staleWarning: true, error: "bad\u001bc" }), theme, keybindings, width: 80, terminalRows: 28 });
	assert.ok(lines.every((line) => visibleWidth(line) === 50));
	assert.doesNotMatch(lines.join("\n"), /payload|\u001bP|\u001bc/);
	for (const role of ["border", "borderMuted", "borderAccent", "accent", "success", "dim", "warning", "error", "searchMatchText", "searchMatchBg"]) assert.ok(roles.has(role), role);
});

function makeComponent(initial = boardSnapshot()) {
	let current = initial;
	let done = 0;
	let requests = 0;
	const tui: any = { terminal: { rows: 28 }, requestRender: () => { requests++; } };
	const component = new TasksBoardComponent({
		tui,
		theme: plainTheme,
		keybindings,
		done: () => { done++; },
		source: { getSnapshot: () => current, getActivity: () => ({ activeTaskId: 2, metrics: { startedAt: 0, inputTokens: 9_000, outputTokens: 4_700 } }), getConfig: () => DEFAULT_TASKS_CONFIG },
		now: () => 464_000,
	});
	component.focused = true;
	return { component, setSnapshot: (value: TaskSnapshot) => { current = value; }, done: () => done, requests: () => requests };
}

test("search covers id, active form, description, and owner without metadata stringification", () => {
	for (const query of ["#2", "Assessing", "Fleet/status", "milo"]) {
		const output = stripped(render(80, 28, { query, searching: true })).join("\n");
		assert.match(output, /1 matches · Completed: shown in search/);
	}
	assert.match(stripped(render(80, 28, { query: "Archived", searching: true })).join("\n"), /1 matches/, "completed matches are revealed");
	assert.match(stripped(render(80, 28, { query: "missing", searching: true })).join("\n"), /0 matches/);
	assert.match(stripped(render(80, 28, { query: "\\\"z\\\":2", searching: true })).join("\n"), /0 matches/, "metadata is not searched");
});

test("selection follows stable IDs across filtering, search, reorder, and deletion", () => {
	const harness = makeComponent();
	harness.component.render(80);
	harness.component.handleInput("\x1b[B");
	harness.component.handleInput("j");
	assert.equal(harness.component.state.selectedId, 3);
	const reordered = boardSnapshot();
	reordered.tasks.find((entry) => entry.id === 3)!.updatedAt = 0;
	harness.setSnapshot(reordered);
	harness.component.render(80);
	assert.equal(harness.component.state.selectedId, 3);
	harness.component.handleInput("/");
	harness.component.handleInput("Finished");
	assert.equal(harness.component.state.selectedId, 1, "completed search matches are revealed");
	harness.component.handleInput("\x7f");
	assert.equal(harness.component.state.query, "Finishe");
	harness.component.handleInput("\x1b");
	assert.equal(harness.component.state.query, "");
	const deleted = boardSnapshot();
	deleted.tasks.find((entry) => entry.id === 1)!.status = "deleted";
	harness.setSnapshot(deleted);
	harness.component.render(80);
	assert.notEqual(harness.component.state.selectedId, 1);
	harness.component.dispose();
});

test("filter cycle, local completed collapse, one-pane navigation, and detail scrolling are ephemeral", () => {
	const original = boardSnapshot();
	const frozenText = JSON.stringify(original);
	const harness = makeComponent(original);
	harness.component.render(50);
	for (const expected of ["In progress", "Open", "Completed", "All"]) {
		harness.component.handleInput("f");
		assert.equal(harness.component.state.filter, expected);
	}
	harness.component.handleInput("c");
	assert.equal(harness.component.state.collapseCompleted, true);
	harness.component.handleInput("\r");
	assert.equal(harness.component.state.pane, "detail");
	harness.component.handleInput("\x1b[6~");
	assert.ok(harness.component.state.detailOffset > 0);
	harness.component.handleInput("\x1b");
	assert.equal(harness.component.state.pane, "list");
	harness.component.handleInput("\x1b");
	assert.equal(harness.done(), 1);
	assert.equal(JSON.stringify(original), frozenText);
});

test("rendering and local controls do not mutate task snapshots or display config", () => {
	const source = boardSnapshot();
	const config = { ...DEFAULT_TASKS_CONFIG, glyphs: { ...DEFAULT_TASKS_CONFIG.glyphs } };
	const beforeSnapshot = JSON.stringify(source);
	const beforeConfig = JSON.stringify(config);
	for (const localState of [state(), state({ filter: "Completed", collapseCompleted: false }), state({ query: "task", searching: true, pane: "detail" })]) {
		renderTasksBoard({ snapshot: source, config, state: localState, theme: plainTheme, keybindings, width: 120, terminalRows: 28 });
	}
	assert.equal(JSON.stringify(source), beforeSnapshot);
	assert.equal(JSON.stringify(config), beforeConfig);
});

test("wide Tab switches pane focus with a non-color marker and no mutating controls", () => {
	const harness = makeComponent();
	const initial = harness.component.render(120).join("\n");
	assert.equal(harness.component.state.pane, "list");
	assert.match(initial, /› Tasks/);
	harness.component.handleInput("\t");
	const detailFocused = harness.component.render(120).join("\n");
	assert.equal(harness.component.state.pane, "detail");
	assert.match(detailFocused, /› Details/);
	assert.notEqual(initial, detailFocused, "focus must remain byte-distinct with a no-color theme");
	assert.doesNotMatch(initial.toLocaleLowerCase(), /\b(start|complete|delete|clear|steer|stop|inspect)\b/);
	harness.component.dispose();
});

function paginationSnapshot(): TaskSnapshot {
	return snapshot([
		...Array.from({ length: 30 }, (_, index) => ({
			...task(index + 1, index === 13 ? "in_progress" : "pending", [], `Task ${index + 1} ${"wrapped subject ".repeat(index === 13 ? 8 : 1)}`),
			...(index === 13 ? { activeForm: "Working through a deliberately long active task row" } : {}),
		})),
		task(31, "completed", [], "Collapsed completion"),
	]);
}

test("physical-row pagination keeps every stable-ID selection visible at every layout and height", () => {
	const source = paginationSnapshot();
	for (const width of [120, 96, 80, 60, 50, 36]) {
		for (const terminalRows of [14, 20, 28]) {
			for (let selectedId = 1; selectedId <= 30; selectedId++) {
				const output = stripTerminalSequences(renderTasksBoard({
					snapshot: source,
					activity: { activeTaskId: 14, metrics: { startedAt: 0, inputTokens: 1, outputTokens: 2 } },
					config: DEFAULT_TASKS_CONFIG,
					state: state({ selectedId }),
					theme: plainTheme,
					keybindings,
					width,
					terminalRows,
					now: 10_000,
				}).join("\n"));
				assert.match(output, new RegExp(`›[^\\n]*#${selectedId}(?:\\D|$)`), `${width}x${terminalRows} selection #${selectedId}`);
			}
		}
	}
});

test("End keeps the last task visible with wrapped active rows and a collapsed summary", () => {
	const harness = makeComponent(paginationSnapshot());
	harness.component.state.collapseCompleted = true;
	for (const width of [120, 80, 50]) {
		harness.component.state.selectedId = 1;
		harness.component.state.listOffset = 0;
		harness.component.render(width);
		harness.component.handleInput("\x1b[F");
		assert.equal(harness.component.state.selectedId, 30);
		assert.match(stripTerminalSequences(harness.component.render(width).join("\n")), /›[^\n]*#30\D/);
	}
	harness.component.dispose();
});

test("disappearing and no-result selections reset one-pane detail so Esc and q close once", () => {
	for (const closeKey of ["\x1b", "q"]) {
		const harness = makeComponent();
		harness.component.render(80);
		harness.component.handleInput("\r");
		assert.equal(harness.component.state.pane, "detail");
		harness.setSnapshot(snapshot());
		harness.component.render(80);
		assert.equal(harness.component.state.pane, "list");
		harness.component.handleInput(closeKey);
		assert.equal(harness.done(), 1, `close key ${JSON.stringify(closeKey)}`);
	}
	const filtered = makeComponent();
	filtered.component.render(50);
	filtered.component.handleInput("\r");
	filtered.component.handleInput("/");
	filtered.component.handleInput("no matches anywhere");
	assert.equal(filtered.component.state.pane, "list");
	filtered.component.handleInput("\x1b");
	assert.equal(filtered.component.state.query, "");
	filtered.component.handleInput("\x1b");
	assert.equal(filtered.done(), 1);
});

test("per-key search preserves spaces, cursor edits, safe input, and matching normalization", () => {
	const source = snapshot([
		task(1, "pending", [], "foo bar"),
		task(2, "pending", [], "foo wide bar"),
		task(3, "pending", [], "foo X Ybar"),
		task(4, "pending", [], "foobar"),
	]);
	const typeKeys = (component: TasksBoardComponent, text: string) => {
		for (const key of text) component.handleInput(key);
	};
	const cursorParts = (component: TasksBoardComponent) => {
		const line = component.render(80).find((candidate) => candidate.includes("Search >"))!;
		const marker = line.indexOf(CURSOR_MARKER);
		assert.ok(marker >= 0);
		return {
			line,
			before: stripTerminalSequences(line.slice(0, marker)),
			after: stripTerminalSequences(line.slice(marker + CURSOR_MARKER.length)),
		};
	};

	const ordinary = makeComponent(source);
	ordinary.component.render(80);
	ordinary.component.handleInput("/");
	typeKeys(ordinary.component, "foo");
	ordinary.component.handleInput(" ");
	typeKeys(ordinary.component, "bar");
	assert.equal(ordinary.component.state.query, "foo bar");
	let output = ordinary.component.render(80);
	assert.match(stripTerminalSequences(output.join("\n")), /1 matches/);
	assert.ok(cursorParts(ordinary.component).before.endsWith("foo bar"));
	assert.ok(output.every((line) => visibleWidth(line) === 80));
	ordinary.component.dispose();

	const surrounding = makeComponent(source);
	surrounding.component.render(80);
	surrounding.component.handleInput("/");
	surrounding.component.handleInput(" ");
	surrounding.component.handleInput(" ");
	typeKeys(surrounding.component, "foo");
	surrounding.component.handleInput(" ");
	surrounding.component.handleInput(" ");
	typeKeys(surrounding.component, "bar");
	surrounding.component.handleInput(" ");
	surrounding.component.handleInput(" ");
	assert.equal(surrounding.component.state.query, "  foo  bar  ");
	assert.match(stripTerminalSequences(surrounding.component.render(80).join("\n")), /1 matches/);
	assert.ok(cursorParts(surrounding.component).before.endsWith("  foo  bar  "));
	surrounding.component.dispose();

	const edited = makeComponent(source);
	edited.component.render(80);
	edited.component.handleInput("/");
	typeKeys(edited.component, "foo bar");
	for (let index = 0; index < 3; index++) edited.component.handleInput("\x1b[D");
	typeKeys(edited.component, "wide");
	edited.component.handleInput(" ");
	assert.equal(edited.component.state.query, "foo wide bar");
	assert.match(stripTerminalSequences(edited.component.render(80).join("\n")), /1 matches/);
	let cursor = cursorParts(edited.component);
	assert.ok(cursor.before.endsWith("foo wide "));
	assert.ok(cursor.after.startsWith("bar"));
	edited.component.dispose();

	const hostile = makeComponent(source);
	hostile.component.render(80);
	hostile.component.handleInput("/");
	typeKeys(hostile.component, "foo bar");
	for (let index = 0; index < 3; index++) hostile.component.handleInput("\x1b[D");
	hostile.component.handleInput("\u001b[200~\u001b]0;title\u0007X\n\tY\u202e\u001b[201~");
	assert.equal(hostile.component.state.query, "foo X Ybar");
	cursor = cursorParts(hostile.component);
	assert.ok(cursor.before.endsWith("foo X Y"));
	assert.ok(cursor.after.startsWith("bar"));
	hostile.component.handleInput("\u202e");
	hostile.component.handleInput("\u001bc");
	hostile.component.handleInput("\u0000control");
	assert.equal(hostile.component.state.query, "foo X Ybar");
	cursor = cursorParts(hostile.component);
	assert.ok(cursor.before.endsWith("foo X Y"));
	assert.ok(cursor.after.startsWith("bar"));
	output = hostile.component.render(80);
	assert.match(stripTerminalSequences(output.join("\n")), /1 matches/);
	assert.doesNotMatch(stripTerminalSequences(output.join("\n")), /title|\u202e/);
	assert.ok(output.every((line) => visibleWidth(line) === 80));
	hostile.component.dispose();
});

test("strict search edit keeps the filtered selection, body row, count, and public Input cursor aligned", () => {
	const harness = makeComponent(snapshot([
		task(1, "pending", [], "foo baXr target"),
		task(2, "pending", [], "unrelated task"),
	]));
	harness.component.render(80);
	harness.component.handleInput("/");
	for (const key of "foo bar") harness.component.handleInput(key);
	harness.component.handleInput("\x1b[D");
	harness.component.handleInput("X");

	assert.equal(harness.component.state.query, "foo baXr");
	const output = harness.component.render(80);
	const plain = stripTerminalSequences(output.join("\n"));
	assert.match(plain, /1 matches · Completed: shown in search/);
	assert.match(plain, /›[^\n]*#1[^\n]*foo baXr target/);
	assert.doesNotMatch(plain, /No tasks match/);
	const searchLine = output.find((line) => line.includes("Search >"))!;
	const marker = searchLine.indexOf(CURSOR_MARKER);
	assert.ok(marker >= 0);
	assert.ok(stripTerminalSequences(searchLine.slice(0, marker)).endsWith("foo baX"));
	assert.ok(stripTerminalSequences(searchLine.slice(marker + CURSOR_MARKER.length)).startsWith("r"));
	harness.component.dispose();
});

test("projection changes reconcile large physical offsets, no-match recovery, filters, and completed collapse", () => {
	const large = makeComponent(paginationSnapshot());
	large.component.render(50);
	large.component.handleInput("\x1b[F");
	assert.ok(large.component.state.listOffset > 0);
	large.component.handleInput("/");
	for (const key of "#1 ") large.component.handleInput(key);
	assert.equal(large.component.state.listOffset, 0);
	let output = stripTerminalSequences(large.component.render(50).join("\n"));
	assert.match(output, /›[^\n]*#1(?:\D|$)/);
	assert.doesNotMatch(output, /No tasks match/);
	large.component.dispose();

	const recovering = makeComponent(snapshot([
		task(1, "pending", [], "recover target"),
		task(2, "in_progress", [], "active item"),
		task(3, "completed", [], "completed item"),
	]));
	recovering.component.render(80);
	recovering.component.handleInput("/");
	for (const key of "recover targetz") recovering.component.handleInput(key);
	assert.match(stripTerminalSequences(recovering.component.render(80).join("\n")), /0 matches[\s\S]*No tasks match/);
	recovering.component.handleInput("\x7f");
	output = stripTerminalSequences(recovering.component.render(80).join("\n"));
	assert.match(output, /1 matches/);
	assert.match(output, /›[^\n]*#1[^\n]*recover target/);
	recovering.component.handleInput("\x1b");

	recovering.component.handleInput("f");
	output = stripTerminalSequences(recovering.component.render(80).join("\n"));
	assert.equal(recovering.component.state.filter, "In progress");
	assert.match(output, /›[^\n]*#2[^\n]*active item/);
	recovering.component.handleInput("f");
	output = stripTerminalSequences(recovering.component.render(80).join("\n"));
	assert.equal(recovering.component.state.filter, "Open");
	assert.match(output, /›[^\n]*#1[^\n]*recover target/);
	recovering.component.handleInput("f");
	output = stripTerminalSequences(recovering.component.render(80).join("\n"));
	assert.equal(recovering.component.state.filter, "Completed");
	assert.match(output, /›[^\n]*#3[^\n]*completed item/);
	recovering.component.handleInput("c");
	output = stripTerminalSequences(recovering.component.render(80).join("\n"));
	assert.match(output, /›[^\n]*#3[^\n]*completed item/);
	recovering.component.handleInput("f");
	output = stripTerminalSequences(recovering.component.render(80).join("\n"));
	assert.equal(recovering.component.state.filter, "All");
	assert.match(output, /›[^\n]*#1[^\n]*recover target/, "collapsed completed selection falls back visibly");
	recovering.component.handleInput("c");
	recovering.component.state.selectedId = 3;
	recovering.component.render(80);
	recovering.component.handleInput("c");
	output = stripTerminalSequences(recovering.component.render(80).join("\n"));
	assert.match(output, /›[^\n]*#1[^\n]*recover target/, "completed toggle reconciles selection and body");
	recovering.component.dispose();
});

test("split bracketed paste markers sanitize buffered control and line attempts without changing spaces", () => {
	const harness = makeComponent(snapshot([task(1, "pending", [], "foo  ba Xr target")]));
	harness.component.render(80);
	harness.component.handleInput("/");
	harness.component.handleInput("\x1b[20");
	harness.component.handleInput("0~foo  \x1b]0;title");
	harness.component.handleInput("\x07ba\nX\u202e\u0000r\x1b[20");
	assert.equal(harness.component.state.query, "", "partial paste is not exposed to Input");
	harness.component.handleInput("1~");
	assert.equal(harness.component.state.query, "foo  ba Xr");
	let output = stripTerminalSequences(harness.component.render(80).join("\n"));
	assert.match(output, /1 matches/);
	assert.match(output, /›[^\n]*#1[^\n]*foo ba Xr target/);
	assert.doesNotMatch(output, /title|\u202e|\u0000/);

	harness.component.handleInput("\x1b[88u");
	assert.equal(harness.component.state.query, "foo  ba XrX");
	output = stripTerminalSequences(harness.component.render(80).join("\n"));
	assert.match(output, /0 matches[\s\S]*No tasks match/);
	harness.component.dispose();
});

test("search submit keeps exact spacing and cancel still clears before closing", () => {
	const harness = makeComponent(snapshot([task(1, "pending", [], "foo bar")]));
	harness.component.render(80);
	harness.component.handleInput("/");
	for (const key of " foo bar ") harness.component.handleInput(key);
	harness.component.handleInput("\r");
	assert.equal(harness.component.state.searching, false);
	assert.equal(harness.component.state.query, " foo bar ");
	assert.equal(harness.done(), 0);
	harness.component.handleInput("/");
	harness.component.handleInput("\x1b");
	assert.equal(harness.component.state.searching, false);
	assert.equal(harness.component.state.query, "");
	assert.equal(harness.done(), 0);
	harness.component.handleInput("\x1b");
	assert.equal(harness.done(), 1);
});

test("search embeds Input cursor output, redraws cursor-only moves, and uses input submit binding", () => {
	const harness = makeComponent();
	harness.component.render(80);
	harness.component.handleInput("/");
	harness.component.handleInput("ab");
	const requestsBeforeMove = harness.requests();
	harness.component.handleInput("\x1b[D");
	assert.ok(harness.requests() > requestsBeforeMove);
	harness.component.handleInput("x");
	assert.equal(harness.component.state.query, "axb");
	const searchLine = harness.component.render(80).find((line) => line.includes("Search >"))!;
	assert.ok(searchLine.includes(CURSOR_MARKER));
	assert.ok(searchLine.indexOf("ax") < searchLine.indexOf(CURSOR_MARKER));
	assert.ok(searchLine.indexOf(CURSOR_MARKER) < searchLine.indexOf("b"));
	harness.component.dispose();

	const customBindings: any = {
		getKeys: (binding: string) => binding === "tui.input.submit" ? ["ctrl+s"] : binding === "tui.select.confirm" ? ["enter"] : keybindings.getKeys(binding as any),
	};
	const output = renderTasksBoard({ snapshot: boardSnapshot(), config: DEFAULT_TASKS_CONFIG, state: state({ searching: true }), theme: plainTheme, keybindings: customBindings, width: 80, terminalRows: 28 });
	assert.match(output.join("\n"), /ctrl\+s keep/);
	assert.doesNotMatch(output.join("\n"), /Enter keep/);
});

test("stale warning is height-accounted and preserves the closing border on short terminals", () => {
	for (const terminalRows of [14, 20, 28]) {
		for (const width of [120, 80, 50, 36]) {
			const output = renderTasksBoard({ snapshot: paginationSnapshot(), config: DEFAULT_TASKS_CONFIG, state: state({ staleWarning: true }), theme: plainTheme, keybindings, width, terminalRows });
			const maxHeight = Math.min(22, Math.floor(terminalRows * 0.85), terminalRows - 2);
			assert.equal(output.length, maxHeight, `${width}x${terminalRows}`);
			assert.match(stripTerminalSequences(output.at(-1)!), /^╰─+╯$/);
		}
	}
});

test("wide detail End and Up share exact rendered wrapping bounds", () => {
	const source = boardSnapshot();
	source.tasks[1]!.description = "x".repeat(400);
	const harness = makeComponent(source);
	harness.component.render(120);
	harness.component.handleInput("\t");
	harness.component.handleInput("\x1b[F");
	const end = harness.component.state.detailOffset;
	assert.ok(end > 0);
	harness.component.handleInput("\x1b[A");
	assert.equal(harness.component.state.detailOffset, end - 1);
	harness.component.dispose();
});

test("blocker IDs survive subject-first truncation at wide and 50 columns", () => {
	const source = snapshot([
		task(2, "in_progress", [], "Blocker"),
		task(9, "pending", [2], "A subject that is deliberately far too long to coexist with blocker attribution ".repeat(4)),
	]);
	for (const width of [120, 50]) {
		const output = stripTerminalSequences(renderTasksBoard({ snapshot: source, config: DEFAULT_TASKS_CONFIG, state: state({ selectedId: 9 }), theme: plainTheme, keybindings, width, terminalRows: 28 }).join("\n"));
		assert.match(output, /blocked by #2/);
	}
});

test("narrow measured footer preserves every essential list action", () => {
	for (const width of [36, 50, 60]) {
		const output = stripTerminalSequences(render(width).join("\n"));
		for (const meaning of ["task", "details", "search", "filter", "completed", "close"]) assert.match(output, new RegExp(meaning), `${width}: ${meaning}`);
	}
});

test("selected completed rows are bold before dim strikethrough", () => {
	const markedTheme: any = {
		...plainTheme,
		bold: (text: string) => `<b>${text}</b>`,
		strikethrough: (text: string) => `<s>${text}</s>`,
		fg: (role: string, text: string) => role === "dim" ? `<dim>${text}</dim>` : text,
	};
	const output = renderTasksBoard({ snapshot: snapshot([task(1, "completed", [], "Done")]), config: DEFAULT_TASKS_CONFIG, state: state({ selectedId: 1, collapseCompleted: false }), theme: markedTheme, keybindings, width: 80, terminalRows: 28 }).join("\n");
	assert.match(output, /<dim><s><b>#1 Done<\/b><\/s><\/dim>/);
});

test("empty and no-result states use actionable read-only copy", () => {
	const empty = renderTasksBoard({ snapshot: snapshot(), config: DEFAULT_TASKS_CONFIG, state: state({ selectedId: undefined }), theme: plainTheme, keybindings, width: 80, terminalRows: 28 });
	assert.match(empty.join("\n"), /No tasks in this session\./);
	assert.match(empty.join("\n"), /Use \/tasks to create one; this board is read-only\./);
	assert.match(render(80, 28, { query: "missing" }).join("\n"), /No tasks match "missing"\./);
	assert.match(render(80, 28, { filter: "Completed", collapseCompleted: false, query: "impossible" }).join("\n"), /Esc clears search\./);
	const completed = snapshot([task(1, "completed"), task(2, "completed")]);
	const hidden = renderTasksBoard({ snapshot: completed, config: DEFAULT_TASKS_CONFIG, state: state({ selectedId: undefined }), theme: plainTheme, keybindings, width: 80, terminalRows: 28 });
	assert.match(hidden.join("\n"), /All 2 tasks are completed\./);
});

test("live spinner timer uses 150 ms, unrefs, invalidates, and is cleared exactly once", () => {
	const originalSet = globalThis.setInterval;
	const originalClear = globalThis.clearInterval;
	let callback = () => {};
	let delay = 0;
	let unref = 0;
	let cleared = 0;
	(globalThis as any).setInterval = (cb: () => void, ms: number) => { callback = cb; delay = ms; return { unref: () => { unref++; } }; };
	(globalThis as any).clearInterval = () => { cleared++; };
	try {
		const harness = makeComponent();
		harness.component.render(80);
		assert.equal(delay, 150);
		assert.equal(unref, 1);
		callback();
		assert.equal(harness.component.state.frame, 1);
		assert.equal(harness.requests(), 1);
		harness.component.dispose();
		harness.component.dispose();
		assert.equal(cleared, 1);
	} finally {
		globalThis.setInterval = originalSet;
		globalThis.clearInterval = originalClear;
	}
});

test("command uses public overlay options, single-open guard, and non-TUI fallback", async () => {
	const notices: Array<[string, string]> = [];
	let release: (() => void) | undefined;
	let component: TasksBoardComponent | undefined;
	const custom = (factory: any, options: any) => {
		assert.deepEqual(options, { overlay: true, overlayOptions: TASKS_BOARD_OVERLAY_OPTIONS });
		return new Promise<void>((resolve) => {
			release = resolve;
			component = factory({ terminal: { rows: 28 }, requestRender() {} }, plainTheme, keybindings, resolve);
		});
	};
	const ctx: any = { mode: "tui", ui: { custom, notify: (message: string, type: string) => notices.push([message, type]) } };
	const first = openTasksBoard(ctx, () => DEFAULT_TASKS_CONFIG);
	await Promise.resolve();
	await openTasksBoard(ctx, () => DEFAULT_TASKS_CONFIG);
	assert.deepEqual(notices, [["Tasks board is already open.", "info"]]);
	component?.dispose();
	release?.();
	await first;
	let customCalled = false;
	await openTasksBoard({ mode: "rpc", ui: { custom: () => { customCalled = true; }, notify: (message: string, type: string) => notices.push([message, type]) } } as any, () => DEFAULT_TASKS_CONFIG);
	assert.equal(customCalled, false);
	assert.deepEqual(notices.at(-1), ["/tasks-board requires TUI mode; task data remains available through the todo tool.", "warning"]);
});
