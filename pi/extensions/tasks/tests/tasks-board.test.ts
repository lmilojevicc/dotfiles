import test from "node:test";
import assert from "node:assert/strict";
import { CURSOR_MARKER, KeybindingsManager, setKeybindings, stripTerminalSequences, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_TASKS_CONFIG } from "../src/config/tasks-config.ts";
import type { TaskSnapshot } from "../src/domain/types.ts";
import { taskActivity } from "../src/state/activity.ts";
import { commitSnapshot, getSnapshot, resetStore, setForeground } from "../src/state/store.ts";
import { applyHumanMutation } from "../src/ui/controller.ts";
import {
	disposeTasksBoard,
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
		{ ...task(3, "pending", [2], "Add Tasks board"), owner: "milo", createdAt: Date.UTC(2026, 0, 5), updatedAt: Date.UTC(2026, 0, 6) },
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
	assert.equal(wide[1], "│ ● Tasks · live inspection                                                    4 tasks (1 done, 1 in progress, 2 open) │");
	assert.equal(wide[2], "│ Search: / to search                                                               Filter: All · Completed: collapsed │");
	assert.ok(wide.slice(-3).some((line) => line.includes("↑↓/jk task · Tab pane · / search · c completed · f filter · d delete")));
	assert.ok(wide.at(-2)?.includes("PgUp/PgDn scroll · Esc close"));
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
	const results: any[] = [];
	let requests = 0;
	const tui: any = { terminal: { rows: 28 }, requestRender: () => { requests++; } };
	const component = new TasksBoardComponent({
		tui,
		theme: plainTheme,
		keybindings,
		done: (result) => { results.push(result); },
		source: { getSnapshot: () => current, getActivity: () => ({ activeTaskId: 2, metrics: { startedAt: 0, inputTokens: 9_000, outputTokens: 4_700 } }), getConfig: () => DEFAULT_TASKS_CONFIG },
		now: () => 464_000,
	});
	component.focused = true;
	return { component, setSnapshot: (value: TaskSnapshot) => { current = value; }, done: () => results.length, results, requests: () => requests };
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

test("lowercase d yields a typed delete action from list and detail while uppercase D does nothing", () => {
	for (const pane of ["list", "detail"] as const) {
		const harness = makeComponent();
		harness.component.state.selectedId = 3;
		harness.component.state.pane = pane;
		harness.component.state.filter = "Open";
		harness.component.state.collapseCompleted = false;
		harness.component.state.query = "";
		harness.component.render(pane === "detail" ? 50 : 120);
		harness.component.state.listOffset = 2;
		harness.component.state.detailOffset = 4;
		harness.component.handleInput("D");
		assert.equal(harness.results.length, 0, `${pane} has no uppercase alias`);
		harness.component.handleInput("d");
		assert.deepEqual(harness.results, [{
			action: "delete",
			id: 3,
			subject: "Add Tasks board",
			expectedRevision: 0,
			fallbackId: 4,
			viewState: {
				selectedId: 3,
				filter: "Open",
				collapseCompleted: false,
				query: "",
				pane,
				listOffset: 0,
				detailOffset: 4,
			},
		}]);
	}
});

test("search edit treats d as ordinary text and never yields a board action", () => {
	const harness = makeComponent();
	harness.component.render(80);
	harness.component.handleInput("/");
	harness.component.handleInput("d");
	assert.equal(harness.component.state.query, "d");
	assert.equal(harness.component.state.searching, true);
	assert.equal(harness.results.length, 0);
	harness.component.dispose();
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

test("wide Tab switches pane focus with a non-color marker and only the approved delete control", () => {
	const harness = makeComponent();
	const initial = harness.component.render(120).join("\n");
	assert.equal(harness.component.state.pane, "list");
	assert.match(initial, /› Tasks/);
	harness.component.handleInput("\t");
	const detailFocused = harness.component.render(120).join("\n");
	assert.equal(harness.component.state.pane, "detail");
	assert.match(detailFocused, /› Details/);
	assert.notEqual(initial, detailFocused, "focus must remain byte-distinct with a no-color theme");
	assert.match(initial, /d delete/);
	assert.doesNotMatch(initial.toLocaleLowerCase(), /\b(start|complete|clear|steer|stop|launch)\b/);
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

test("wide, medium, and small measured footers preserve every essential list action", () => {
	for (const width of [120, 80, 60, 50, 36]) {
		const lines = render(width);
		const output = stripTerminalSequences(lines.join("\n"));
		for (const meaning of ["task", width >= 92 ? "pane" : "details", "search", "filter", "completed", "d delete", "close"]) {
			assert.match(output, new RegExp(meaning), `${width}: ${meaning}`);
		}
		assert.ok(lines.every((line) => visibleWidth(line) === width), `footer width ${width}`);
	}
	for (const width of [80, 50, 36]) {
		const output = stripTerminalSequences(render(width, 28, { pane: "detail" }).join("\n"));
		assert.match(output, /d delete/, `detail ${width}`);
	}
});

test("submitted search footers put clear-search precedence before close or list at every width", () => {
	for (const width of [120, 80, 60, 50, 36]) {
		const output = stripTerminalSequences(render(width, 28, { query: "Task", searching: false }).join("\n"));
		assert.match(output, /Esc clear search/, `${width}: clear search`);
		assert.ok(output.indexOf("Esc clear search") < output.indexOf("q close"), `${width}: clear precedes close`);
	}
	for (const width of [80, 50, 36]) {
		const output = stripTerminalSequences(render(width, 28, { query: "Task", searching: false, pane: "detail" }).join("\n"));
		assert.match(output, /Esc clear search/, `${width}: detail clear search`);
		assert.ok(output.indexOf("Esc clear search") < output.indexOf("Backspace list"), `${width}: clear precedes list`);
		assert.doesNotMatch(output, /Esc list/, `${width}: Escape clears before returning to list`);
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

test("empty and no-result states use actionable inspection-first copy", () => {
	const empty = renderTasksBoard({ snapshot: snapshot(), config: DEFAULT_TASKS_CONFIG, state: state({ selectedId: undefined }), theme: plainTheme, keybindings, width: 80, terminalRows: 28 });
	assert.match(empty.join("\n"), /No tasks in this session\./);
	assert.match(empty.join("\n"), /Use \/tasks to create and manage tasks\./);
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

interface BoardScenario {
	components: TasksBoardComponent[];
	results: any[];
	confirmCalls: any[];
	notices: any[];
	entries: any[];
	refreshes: number;
}

async function runBoardScenario(
	initial: TaskSnapshot,
	drivers: Array<(component: TasksBoardComponent) => void>,
	confirmations: boolean[],
	activity = false,
	onConfirm?: (pi: any, ctx: any) => void,
): Promise<BoardScenario> {
	resetStore();
	const session = "tasks-board-session";
	commitSnapshot(session, initial);
	setForeground(session);
	if (activity) taskActivity.reset(session, initial, 10);
	const components: TasksBoardComponent[] = [];
	const results: any[] = [];
	const confirmCalls: any[] = [];
	const notices: any[] = [];
	const entries: any[] = [];
	let refreshes = 0;
	const pi: any = { appendEntry: (...args: any[]) => entries.push(args) };
	const ctx: any = {
		mode: "tui",
		sessionManager: { getSessionId: () => session },
		ui: {
			custom: (factory: any, options: any) => {
				assert.deepEqual(options, { overlay: true, overlayOptions: TASKS_BOARD_OVERLAY_OPTIONS });
				return new Promise((resolve) => {
					const component = factory(
						{ terminal: { rows: 28 }, requestRender() {} },
						plainTheme,
						keybindings,
						(result: any) => { results.push(result); resolve(result); },
					);
					components.push(component);
					const driver = drivers.shift();
					assert.ok(driver, "unexpected board reopen");
					driver(component);
				});
			},
			confirm: async (...args: any[]) => {
				confirmCalls.push(args);
				onConfirm?.(pi, ctx);
				onConfirm = undefined;
				return confirmations.shift() ?? false;
			},
			notify: (...args: any[]) => notices.push(args),
		},
	};
	await openTasksBoard(pi, ctx, () => DEFAULT_TASKS_CONFIG, () => { refreshes++; });
	assert.equal(drivers.length, 0);
	return { components, results, confirmCalls, notices, entries, refreshes };
}

test("cancelled board deletion reopens with stable selection and preserved serializable view state", async () => {
	let yielded: any;
	const source = snapshot([
		{ ...task(1), description: "one ".repeat(100) },
		{ ...task(2), description: "two ".repeat(100) },
		task(3),
	], 9);
	const scenario = await runBoardScenario(source, [
		(component) => {
			component.state.selectedId = 2;
			component.state.filter = "Open";
			component.state.collapseCompleted = true;
			component.state.query = "Task";
			component.state.pane = "detail";
			component.render(50);
			component.state.listOffset = 1;
			component.state.detailOffset = 5;
			component.handleInput("d");
		},
		(component) => {
			yielded = scenarioResult(component, 50);
			component.close();
		},
	], [false]);
	const requested = scenario.results[0];
	assert.equal(requested.action, "delete");
	assert.deepEqual(yielded, requested.viewState);
	assert.equal(getSnapshot("tasks-board-session").revision, 9);
	assert.equal(scenario.entries.length, 0);
	assert.equal(scenario.refreshes, 0);
	assert.deepEqual(scenario.confirmCalls[0]?.slice(0, 2), ["Delete task", "Delete #2 Task 2?"]);
	assert.equal(scenario.confirmCalls[0]?.[2]?.signal instanceof AbortSignal, true);
});

function scenarioResult(component: TasksBoardComponent, width: number): any {
	component.render(width);
	return {
		...(component.state.selectedId === undefined ? {} : { selectedId: component.state.selectedId }),
		filter: component.state.filter,
		collapseCompleted: component.state.collapseCompleted,
		query: component.state.query,
		pane: component.state.pane,
		listOffset: component.state.listOffset,
		detailOffset: component.state.detailOffset,
	};
}

test("confirmed board deletion commits once, appends the human snapshot, refreshes activity/widget, and selects the next visible task", async () => {
	const source = snapshot([task(1), task(2, "in_progress"), task(3)], 7);
	const scenario = await runBoardScenario(source, [
		(component) => {
			component.render(80);
			component.state.selectedId = 2;
			component.state.filter = "All";
			component.state.collapseCompleted = true;
			component.state.query = "Task";
			component.handleInput("d");
		},
		(component) => {
			component.render(80);
			assert.equal(component.state.selectedId, 3);
			assert.equal(component.state.filter, "All");
			assert.equal(component.state.collapseCompleted, true);
			assert.equal(component.state.query, "Task");
			assert.match(stripTerminalSequences(component.render(80).join("\n")), /›[^\n]*#3\D/);
			component.close();
		},
	], [true], true);
	const committed = getSnapshot("tasks-board-session");
	assert.equal(committed.revision, 8);
	assert.equal(committed.tasks.find((entry) => entry.id === 2)?.status, "deleted");
	assert.equal(scenario.entries.length, 1);
	assert.equal(scenario.entries[0][0], "pi-tasks-state");
	assert.equal(scenario.entries[0][1], committed);
	assert.equal(scenario.refreshes, 1);
	assert.deepEqual(taskActivity.get("tasks-board-session"), {});
});

test("confirmation rejects selected-task changes and unrelated revision advances without deleting or refreshing", async () => {
	for (const change of [
		{ name: "selected rename", apply: (pi: any, ctx: any) => applyHumanMutation(pi, ctx, { action: "update", id: 1, subject: "Renamed while confirming" }) },
		{ name: "unrelated update", apply: (pi: any, ctx: any) => applyHumanMutation(pi, ctx, { action: "update", id: 2, subject: "Unrelated change" }) },
	]) {
		const source = snapshot([task(1), task(2)], 4);
		let reopenedRevision = 0;
		const scenario = await runBoardScenario(source, [
			(component) => {
				component.render(80);
				component.state.selectedId = 1;
				component.handleInput("d");
			},
			(component) => {
				reopenedRevision = scenarioResult(component, 80).selectedId === 1
					? getSnapshot("tasks-board-session").revision
					: 0;
				component.close();
			},
		], [true], false, change.apply);
		const current = getSnapshot("tasks-board-session");
		assert.equal(scenario.results[0]?.expectedRevision, 4, change.name);
		assert.equal(reopenedRevision, 5, change.name);
		assert.notEqual(current.tasks.find((entry) => entry.id === 1)?.status, "deleted", change.name);
		assert.equal(scenario.entries.length, 1, `${change.name}: only the intervening mutation appends`);
		assert.equal(scenario.refreshes, 0, `${change.name}: rejected delete does not refresh`);
		assert.match(scenario.notices[0]?.[0] ?? "", /Tasks changed while delete confirmation was open; #1 was not deleted/, change.name);
		assert.equal(scenario.notices[0]?.[1], "warning", change.name);
	}
});

test("dependency-gated board deletion notifies and reopens unchanged", async () => {
	const source = snapshot([task(1), task(2, "pending", [1])], 4);
	let reopened: any;
	const scenario = await runBoardScenario(source, [
		(component) => {
			component.render(50);
			component.state.selectedId = 1;
			component.state.filter = "Open";
			component.state.collapseCompleted = true;
			component.state.pane = "detail";
			component.state.detailOffset = 3;
			component.handleInput("d");
		},
		(component) => {
			reopened = scenarioResult(component, 50);
			component.close();
		},
	], [true]);
	assert.deepEqual(reopened, scenario.results[0].viewState);
	assert.equal(getSnapshot("tasks-board-session"), source);
	assert.equal(scenario.entries.length, 0);
	assert.equal(scenario.refreshes, 0);
	assert.match(scenario.notices[0]?.[0] ?? "", /Could not delete #1: #1 is required by #2/);
	assert.equal(scenario.notices[0]?.[1], "error");
});

test("successful deletion resets a scrolled detail before opening the fallback task", async () => {
	const source = snapshot([
		{ ...task(1), description: "first ".repeat(100) },
		{ ...task(2), description: "second ".repeat(100) },
	], 3);
	await runBoardScenario(source, [
		(component) => {
			component.render(50);
			component.state.pane = "detail";
			component.state.detailOffset = 7;
			component.handleInput("d");
		},
		(component) => {
			component.render(50);
			assert.equal(component.state.selectedId, 2);
			assert.equal(component.state.detailOffset, 0);
			assert.match(stripTerminalSequences(component.render(50).join("\n")), /Details  #2 · lines 1–/);
			component.close();
		},
	], [true]);
});

test("deleting the only query match keeps clear-search precedence in the no-results footer", async () => {
	const source = snapshot([task(1, "pending", [], "Unique needle"), task(2, "pending", [], "Other")], 2);
	await runBoardScenario(source, [
		(component) => {
			component.render(50);
			component.state.query = "needle";
			component.render(50);
			component.handleInput("d");
		},
		(component) => {
			const output = stripTerminalSequences(component.render(50).join("\n"));
			assert.match(output, /No tasks match "needle"\./);
			assert.match(output, /Esc clear search/);
			assert.ok(output.indexOf("Esc clear search") < output.indexOf("q close"));
			component.close();
		},
	], [true]);
});

test("deleting the only visible task reopens the board empty without hard-deleting its snapshot record", async () => {
	const source = snapshot([task(1)], 2);
	await runBoardScenario(source, [
		(component) => { component.render(80); component.handleInput("d"); },
		(component) => {
			assert.equal(component.state.selectedId, undefined);
			assert.match(component.render(80).join("\n"), /No tasks in this session\./);
			component.close();
		},
	], [true]);
	const committed = getSnapshot("tasks-board-session");
	assert.equal(committed.tasks.length, 1);
	assert.equal(committed.tasks[0]?.status, "deleted");
});

test("disposing during confirmation aborts the board run and ignores both late confirmation resolutions", async () => {
	for (const lateResult of [true, false]) {
		resetStore();
		const session = `dispose-confirm-${lateResult}`;
		const source = snapshot([task(1)], 6);
		commitSnapshot(session, source);
		setForeground(session);
		const entries: any[] = [];
		const notices: any[] = [];
		let refreshes = 0;
		let customCalls = 0;
		let resolveConfirm!: (value: boolean) => void;
		let confirmStarted!: (signal: AbortSignal) => void;
		const started = new Promise<AbortSignal>((resolve) => { confirmStarted = resolve; });
		const confirmation = new Promise<boolean>((resolve) => { resolveConfirm = resolve; });
		const pi: any = { appendEntry: (...args: any[]) => entries.push(args) };
		const ctx: any = {
			mode: "tui",
			sessionManager: { getSessionId: () => session },
			ui: {
				custom: (factory: any) => new Promise((resolve) => {
					customCalls++;
					const component = factory(
						{ terminal: { rows: 28 }, requestRender() {} },
						plainTheme,
						keybindings,
						resolve,
					);
					component.render(80);
					component.handleInput("d");
				}),
				confirm: (_title: string, _message: string, options: { signal: AbortSignal }) => {
					confirmStarted(options.signal);
					return confirmation;
				},
				notify: (...args: any[]) => notices.push(args),
			},
		};
		const opening = openTasksBoard(pi, ctx, () => DEFAULT_TASKS_CONFIG, () => { refreshes++; });
		const signal = await started;
		disposeTasksBoard();
		disposeTasksBoard();
		assert.equal(signal.aborted, true, `${lateResult}: signal aborted`);
		resolveConfirm(lateResult);
		await opening;
		assert.equal(customCalls, 1, `${lateResult}: board does not reopen`);
		assert.equal(getSnapshot(session), source, `${lateResult}: task state unchanged`);
		assert.equal(entries.length, 0, `${lateResult}: no append`);
		assert.equal(refreshes, 0, `${lateResult}: no refresh`);
		assert.equal(notices.length, 0, `${lateResult}: shutdown is silent`);
	}
});

test("command uses public overlay options, single-open guard, and non-TUI fallback", async () => {
	const notices: Array<[string, string]> = [];
	let release: (() => void) | undefined;
	let component: TasksBoardComponent | undefined;
	const custom = (factory: any, options: any) => {
		assert.deepEqual(options, { overlay: true, overlayOptions: TASKS_BOARD_OVERLAY_OPTIONS });
		return new Promise<any>((resolve) => {
			component = factory({ terminal: { rows: 28 }, requestRender() {} }, plainTheme, keybindings, resolve);
			release = () => component?.close();
		});
	};
	const pi: any = {};
	const ctx: any = { mode: "tui", sessionManager: { getSessionId: () => "session" }, ui: { custom, notify: (message: string, type: string) => notices.push([message, type]) } };
	const first = openTasksBoard(pi, ctx, () => DEFAULT_TASKS_CONFIG);
	await Promise.resolve();
	await openTasksBoard(pi, ctx, () => DEFAULT_TASKS_CONFIG);
	assert.deepEqual(notices, [["Tasks board is already open.", "info"]]);
	release?.();
	await first;
	let customCalled = false;
	await openTasksBoard(pi, { mode: "rpc", ui: { custom: () => { customCalled = true; }, notify: (message: string, type: string) => notices.push([message, type]) } } as any, () => DEFAULT_TASKS_CONFIG);
	assert.equal(customCalled, false);
	assert.deepEqual(notices.at(-1), ["/tasks-board requires TUI mode; task data remains available through the todo tool.", "warning"]);
});
