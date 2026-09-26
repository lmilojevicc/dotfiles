import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_TASKS_CONFIG, type TaskDisplayConfig } from "../src/config/tasks-config.ts";
import { taskActivity, type SessionActivity } from "../src/state/activity.ts";
import { commitSnapshot, resetStore, setForeground } from "../src/state/store.ts";
import { formatDuration, formatTokens, renderWidget, SPINNER_INTERVAL_MS, TaskWidget } from "../src/ui/widget.ts";
import { plainTheme, snapshot, task } from "./helpers.ts";

test.beforeEach(() => { resetStore(); taskActivity.clear(); });

// Golden rows retain af28aa8 content and styles, without obsolete row indentation.
// Only the tree prefix is removed; the header and spacer are untouched.
function stripTree(lines: string[], styled = false): string[] {
	return lines.map((line, index) => {
		if (index === 0 || index === lines.length - 1) return line;
		const branch = index === lines.length - 2 ? "└─" : "├─";
		const prefix = styled ? `<dim>${branch}</dim> ` : `${branch} `;
		assert.ok(line.startsWith(prefix), `expected ${prefix} in ${line}`);
		return line.slice(prefix.length);
	});
}

const render = (state: ReturnType<typeof snapshot>, options: Partial<TaskDisplayConfig> = {}, activity?: SessionActivity, frame = 0, now = 0) =>
	stripTree(renderWidget(state, activity, { ...DEFAULT_TASKS_CONFIG, ...options }, plainTheme, 1000, frame, false, now));

const sentinelTheme = {
	...plainTheme,
	fg: (role: string, text: string) => `<${role}>${text}</${role}>`,
	strikethrough: (text: string) => `<strike>${text}</strike>`,
};

test("renders exact upstream header grammar, source order, rows, and blocker suffix", () => {
	const state = snapshot([
		{ ...task(1, "completed", [], "Done"), updatedAt: 4 },
		{ ...task(2, "in_progress", [], "Run"), activeForm: "Working" },
		{ ...task(3, "pending", [1, 2], "Open") },
	]);
	const activity = { activeTaskId: 2, metrics: { startedAt: 0, inputTokens: 4100, outputTokens: 1200 } };
	assert.deepEqual(render(state, {}, activity, 0, 169_000), [
		"● 3 tasks (1 done, 1 in progress, 1 open)",
		"✔ ~#1 Done~",
		"✳ #2 Working… (2m 49s · ↑ 4.1k ↓ 1.2k)",
		"◻ #3 Open › blocked by #2",
		"",
	]);
});

test("stripping dim tree prefixes preserves original sentinel theme roles", () => {
	const state = snapshot([task(1, "completed", [], "Done"), { ...task(2, "in_progress"), activeForm: "Working" }, task(3)]);
	const lines = stripTree(renderWidget(state, { activeTaskId: 2, metrics: { startedAt: 0, inputTokens: 0, outputTokens: 0 } }, DEFAULT_TASKS_CONFIG, sentinelTheme, 1000, 0, false, 12_000), true);
	assert.equal(lines[0], "<accent>●</accent> <accent>3 tasks (1 done, 1 in progress, 1 open)</accent>");
	assert.equal(lines[1], "<success>✔</success> <dim><strike>#1 Done</strike></dim>");
	assert.equal(lines[2], "<accent>✳</accent> <dim>#2</dim> <accent>Working…</accent> <dim>(12s)</dim>");
	assert.equal(lines[3], "◻ <dim>#3</dim> Task 3");
});

test("supports collapse, limits, top/bottom overflow, show-all toggle, and sort modes", () => {
	const state = snapshot([task(1, "completed"), task(2), task(3, "in_progress"), task(4), task(5)]);
	assert.deepEqual(render(state, { maxVisible: 2 }).slice(1, -1).map((line) => line.match(/#\d+/)?.[0] ?? line), ["#1", "#2", "… and 3 more"]);
	assert.deepEqual(render(state, { maxVisible: 2, hiddenAt: "top" }).slice(1, -1).map((line) => line.match(/#\d+/)?.[0] ?? line), ["… and 3 more", "#4", "#5"]);
	assert.deepEqual(render(state, { collapseCompleted: true, maxVisible: 2 }).slice(1, -1), ["◻ #2 Task 2", "✳ #3 Task 3… (0s)", "… and 2 more", "✔ 1 completed"]);
	assert.equal(stripTree(renderWidget(state, undefined, { ...DEFAULT_TASKS_CONFIG, showAll: true, maxVisible: 2 }, plainTheme, 120, 0, true)).at(-2), "… and 3 more");
	assert.match(render(state, { sortOrder: "active" })[1]!, /#3/);
	assert.match(render(state, { sortOrder: "status" })[1]!, /#1/);
});

test("uses all eleven spinner frames and exact formatting boundaries", () => {
	const state = snapshot([{ ...task(1, "in_progress"), activeForm: "Doing" }]);
	assert.match(render(state)[1]!, /✳ #1 Doing… \(0s\)/);
	const activity = { activeTaskId: 1, metrics: { startedAt: 0, inputTokens: 0, outputTokens: 0 } };
	const expected = ["✳", "✴", "✵", "✶", "✷", "✸", "✹", "✺", "✻", "✼", "✽", "✳"];
	assert.deepEqual(expected.map((_glyph, frame) => render(state, {}, activity, frame, 0)[1]!.split(" ")[0]), expected);
	assert.equal(SPINNER_INTERVAL_MS, 150);
	assert.deepEqual([59_999, 60_000, 61_000, 3_599_999, 3_600_000, 3_783_000].map(formatDuration), ["59s", "1m", "1m 1s", "59m 59s", "1h", "1h 3m"]);
	assert.deepEqual([999, 1000, 2000, 4100].map(formatTokens), ["999", "1k", "2k", "4.1k"]);
});

function widgetHarness() {
	let component: any;
	const requests: unknown[] = [];
	const ui: any = {
		theme: plainTheme,
		setWidget: (_key: string, factory: any) => { if (factory) component = factory({ requestRender: (force?: boolean) => requests.push(force) }, plainTheme); },
	};
	return { ui, requests, get component() { return component; } };
}

test("150ms timer advances spinner and elapsed time, including single-frame glyphs", (t) => {
	const state = snapshot([task(1, "in_progress")]);
	commitSnapshot("s", state);
	setForeground("s");
	taskActivity.addTurnUsage("s", state, 4100, 1200, 0);
	let now = 1000;
	t.mock.method(Date, "now", () => now);
	let callback = () => {};
	const set = t.mock.method(globalThis, "setInterval", (cb: () => void, ms: number) => {
		assert.equal(ms, 150);
		callback = cb;
		return 44 as any;
	});
	const clear = t.mock.method(globalThis, "clearInterval", () => {});
	const harness = widgetHarness();
	const widget = new TaskWidget();
	widget.bind(harness.ui);
	widget.refresh();
	assert.equal(set.mock.callCount(), 1);
	assert.equal(harness.component.render(120)[1], "└─ ✳ #1 Task 1… (1s · ↑ 4.1k ↓ 1.2k)");
	now = 2000;
	callback();
	assert.deepEqual(harness.requests, [undefined]);
	assert.equal(harness.component.render(120)[1], "└─ ✴ #1 Task 1… (2s · ↑ 4.1k ↓ 1.2k)");
	widget.setConfig({ ...DEFAULT_TASKS_CONFIG, glyphs: { spinner: ["x"] } });
	assert.equal(clear.mock.callCount(), 0);
	now = 3000;
	callback();
	assert.equal(harness.component.render(120)[1], "└─ x #1 Task 1… (3s · ↑ 4.1k ↓ 1.2k)");
	assert.equal(set.mock.callCount(), 1);
	commitSnapshot("s", snapshot([task(1, "completed")], 1));
	widget.refresh();
	assert.equal(clear.mock.callCount(), 1);
	commitSnapshot("s", snapshot([task(1, "in_progress")], 2));
	widget.refresh();
	assert.equal(set.mock.callCount(), 2);
	harness.component.dispose();
	widget.dispose();
	widget.dispose();
	assert.equal(clear.mock.callCount(), 2);
});

test("clips and sanitizes Unicode subjects, active forms and glyphs at hostile narrow widths", () => {
	const hostile = "safe\u001bc\u001bPpayload\u001b\\\u001b]0;title\u0007\u202e\n\t tail " + "長👩‍💻e\u0301".repeat(30);
	const state = snapshot([task(1, "completed", [], hostile), { ...task(2, "in_progress", [], hostile), activeForm: `Working ${hostile}` }, task(3, "pending", [2], hostile)]);
	const ansiTheme = { ...plainTheme, fg: (_role: string, text: string) => `\u001b[32m${text}\u001b[39m`, strikethrough: (text: string) => `\u001b[9m${text}\u001b[29m` };
	for (const theme of [plainTheme, ansiTheme]) {
		for (const width of [200, 80, 40, 20, 5, 2, 1, 0]) {
			for (const glyphs of [{}, { pending: "👩‍💻", truncation: "長長長" }]) {
				const lines = renderWidget(state, undefined, { ...DEFAULT_TASKS_CONFIG, glyphs }, theme, width);
				assert.ok(lines.every((line) => visibleWidth(line) <= width), `width ${width}`);
				assert.doesNotMatch(lines.join(""), /payload|title|\u001bP|\u001bc|\u202e|\n|\t/);
				assert.equal(lines.length, width ? 5 : 0);
				if (width) assert.equal(lines.at(-1), "");
			}
		}
	}
});

test("rendering does not mutate task truth, display preferences or activity", () => {
	const state = snapshot([task(1, "completed"), task(2), task(3, "in_progress")]);
	const config: TaskDisplayConfig = { ...DEFAULT_TASKS_CONFIG, sortOrder: [{ field: "id", direction: "desc" }], glyphs: { spinner: ["a", "b"] } };
	const activity = { activeTaskId: 3, metrics: { startedAt: 0, inputTokens: 12, outputTokens: 34 } };
	const before = structuredClone({ state, config, activity });
	for (const width of [200, 20, 1]) renderWidget(state, activity, config, plainTheme, width, 1, true, 5000);
	assert.deepEqual({ state, config, activity }, before);
});

test("empty snapshots and render exceptions are contained", () => {
	assert.deepEqual(renderWidget(snapshot(), undefined, DEFAULT_TASKS_CONFIG, plainTheme, 80), []);
	const broken: any = { ...plainTheme, fg: () => { throw new Error("theme"); } };
	assert.deepEqual(renderWidget(snapshot([task(1)]), undefined, DEFAULT_TASKS_CONFIG, broken, 80), []);
});

test("default spinner stops on rebind, empty tasks and widget disposal", (t) => {
	commitSnapshot("s", snapshot([task(1, "in_progress")]));
	setForeground("s");
	const set = t.mock.method(globalThis, "setInterval", () => 44 as any);
	const clear = t.mock.method(globalThis, "clearInterval", () => {});
	const harness = widgetHarness();
	const widget = new TaskWidget();
	widget.bind(harness.ui);
	widget.refresh();
	assert.equal(set.mock.callCount(), 1);
	widget.bind(harness.ui);
	assert.equal(clear.mock.callCount(), 0);
	widget.bind(widgetHarness().ui);
	assert.equal(clear.mock.callCount(), 1);
	widget.refresh();
	assert.equal(set.mock.callCount(), 2);
	commitSnapshot("s", snapshot());
	widget.refresh();
	assert.equal(clear.mock.callCount(), 2);
	commitSnapshot("s", snapshot([task(1, "in_progress")]));
	widget.refresh();
	assert.equal(set.mock.callCount(), 3);
	widget.dispose();
	widget.dispose();
	assert.equal(clear.mock.callCount(), 3);
	assert.ok(clear.mock.calls.every((call) => call.arguments[0] === 44));
});


test("preserves original activeForm fallback and activity attribution", () => {
	for (const [activeForm, action] of [[undefined, "Run"], ["", "Run"], [" \t\n", ""], ["Run", "Run"], ["  Run\u001b[0m ", "Run"], ["Working", "Working"]]) {
		const state = snapshot([{ ...task(1, "in_progress", [], "Run"), activeForm }]);
		assert.equal(render(state)[1], `✳ #1 ${action}… (0s)`);
		assert.equal(render(state, {}, { activeTaskId: 99, metrics: { startedAt: 0, inputTokens: 999, outputTokens: 999 } }, 0, 12000)[1], `✳ #1 ${action}… (0s)`);
	}
	const state = snapshot([task(1, "in_progress")]);
	for (const [inputTokens, outputTokens, stats] of [[0, 0, "(12s)"], [1000, 0, "(12s · ↑ 1k)"], [0, 999, "(12s · ↓ 999)"]] as const) {
		assert.equal(render(state, {}, { activeTaskId: 1, metrics: { startedAt: 0, inputTokens, outputTokens } }, 0, 12000)[1], `✳ #1 Task 1… ${stats}`);
	}
	assert.equal(render(snapshot([{ ...task(1), activeForm: "Not started" }]))[1], "◻ #1 Task 1");
});

test("stripped custom-glyph rows preserve original text and styles, including summaries and overflow", () => {
	const state = snapshot([task(1, "completed"), { ...task(2, "in_progress"), activeForm: "Working" }, task(3, "pending", [1, 2, 4, 99]), task(4, "deleted")]);
	const glyphs = { header: "H", completed: "C", pending: "P", inProgress: "R", spinner: ["a", "b"], completedSummary: "DONE", overflow: "+", blocked: "!", inputTokens: "IN", outputTokens: "OUT", statsSeparator: "|", trailingEllipsis: "..." };
	const activity = { activeTaskId: 2, metrics: { startedAt: 0, inputTokens: 4100, outputTokens: 1200 } };
	const header = "<accent>H</accent> <accent>3 tasks (1 done, 1 in progress, 1 open)</accent>";
	const done = "<success>C</success> <dim><strike>#1 Task 1</strike></dim>";
	const active = "<accent>b</accent> <dim>#2</dim> <accent>Working...</accent> <dim>(2m 49s | IN 4.1k OUT 1.2k)</dim>";
	const pending = "P <dim>#3</dim> Task 3<dim> ! blocked by #2</dim>";
	const summary = "<success>DONE</success> <dim>1 completed</dim>";
	const cases: [Partial<TaskDisplayConfig>, string[]][] = [
		[{}, [done, active, pending]],
		[{ maxVisible: 1 }, [done, "<dim>+ and 2 more</dim>"]],
		[{ maxVisible: 1, hiddenAt: "top" }, ["<dim>+ and 2 more</dim>", pending]],
		[{ collapseCompleted: true, maxVisible: 1 }, [active, "<dim>+ and 1 more</dim>", summary]],
		[{ collapseCompleted: true, maxVisible: 1, hiddenAt: "top" }, ["<dim>+ and 1 more</dim>", pending, summary]],
		[{ collapseCompleted: true, showAll: true, maxVisible: 1 }, [active, pending, summary]],
	];
	for (const [options, rows] of cases) {
		const lines = renderWidget(state, activity, { ...DEFAULT_TASKS_CONFIG, glyphs, ...options }, sentinelTheme, 1000, 1, false, 169000);
		assert.deepEqual(stripTree(lines, true), [header, ...rows, ""]);
	}
	assert.deepEqual(render(snapshot([task(1, "deleted")])), []);
	assert.deepEqual(render(snapshot([task(1, "completed"), task(2, "completed")]), { collapseCompleted: true }), ["● 2 tasks (2 done)", "✔ 2 completed", ""]);
});

test("preserves sort modes, show-all inversion, limit fallback and spinner overrides", () => {
	const state = snapshot([task(1, "completed"), task(2), task(3, "in_progress"), task(4), task(5)]);
	for (const [sortOrder, firstId] of [["active", 3], ["status", 1], ["recent", 5], ["oldest", 1], [[{ field: "id", direction: "desc" }], 5]] as [TaskDisplayConfig["sortOrder"], number][]) {
		assert.match(render(state, { sortOrder })[1]!, new RegExp(`#${firstId}`));
	}
	for (const showAll of [false, true]) {
		const lines = stripTree(renderWidget(state, undefined, { ...DEFAULT_TASKS_CONFIG, showAll, maxVisible: 2 }, plainTheme, 1000, 0, true));
		assert.equal(lines.at(-2), showAll ? "… and 3 more" : "◻ #5 Task 5");
	}
	assert.deepEqual(render(state, { maxVisible: 0 }), render(state));
	assert.equal(render(state, { glyphs: { spinner: ["x"] } }, undefined, 9)[3], "x #3 Task 3… (0s)");
	for (const spinner of [undefined, [], ["ok", "\n"]]) {
		assert.equal(render(state, { glyphs: { inProgress: "R", spinner } }, undefined, 1)[3], "✴ #3 Task 3… (0s)");
	}
});

test("component keeps toggles local and renders current width and theme", () => {
	commitSnapshot("s", snapshot([task(1), task(2), task(3)]));
	setForeground("s");
	const config = { ...DEFAULT_TASKS_CONFIG, maxVisible: 1 };
	const before = structuredClone(config);
	const harness = widgetHarness();
	const widget = new TaskWidget(config);
	widget.bind(harness.ui);
	widget.refresh();
	const limited = harness.component.render(120);
	assert.equal(limited.at(-2), "└─ … and 2 more");
	widget.toggle();
	assert.equal(harness.component.render(120).at(-2), "└─ ◻ #3 Task 3");
	widget.refresh(true);
	assert.deepEqual(harness.component.render(120), limited);
	assert.ok(harness.component.render(5).every((line: string) => visibleWidth(line) <= 5));
	assert.deepEqual(harness.component.render(120), limited);
	harness.ui.theme = sentinelTheme;
	assert.match(harness.component.render(1000)[1], /^<dim>├─<\/dim> ◻ <dim>#1<\/dim>/);
	widget.toggle();
	const other = widgetHarness();
	widget.bind(other.ui);
	widget.refresh();
	assert.deepEqual(other.component.render(120), limited);
	assert.deepEqual(config, before);
	widget.dispose();
});

test("single-frame active tasks still start the clock; inactive tasks do not", (t) => {
	const set = t.mock.method(globalThis, "setInterval", () => 44 as any);
	t.mock.method(globalThis, "clearInterval", () => {});
	setForeground("s");
	const widget = new TaskWidget({ ...DEFAULT_TASKS_CONFIG, glyphs: { spinner: ["x"] } });
	widget.bind(widgetHarness().ui);
	for (const status of ["pending", "completed", "deleted", "in_progress"] as const) {
		commitSnapshot("s", snapshot([task(1, status)]));
		widget.refresh();
		assert.equal(set.mock.callCount(), status === "in_progress" ? 1 : 0);
	}
	widget.dispose();
});
