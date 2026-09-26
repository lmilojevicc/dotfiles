import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_TASKS_CONFIG, type TaskDisplayConfig } from "../src/config/tasks-config.ts";
import type { SessionActivity } from "../src/state/activity.ts";
import { commitSnapshot, resetStore, setForeground } from "../src/state/store.ts";
import { formatDuration, formatTokens, renderWidget, SPINNER_INTERVAL_MS, TaskWidget } from "../src/ui/widget.ts";
import { plainTheme, snapshot, task } from "./helpers.ts";

test.beforeEach(resetStore);

const render = (state: ReturnType<typeof snapshot>, options: Partial<TaskDisplayConfig> = {}, activity?: SessionActivity, frame = 0, now = 0) =>
	renderWidget(state, activity, { ...DEFAULT_TASKS_CONFIG, ...options }, plainTheme, 200, frame, false, now);

function referenceSnapshot() {
	return snapshot([
		task(1, "completed", [], "Create DemoTodo domain entity"),
		task(2, "completed", [], "Create IDemoTodoRepository interface"),
		{ ...task(3, "in_progress", [], "Create DemoTodoRepository in Infrastructure"), activeForm: "Creating DemoTodoRepository implementation" },
		task(4, "pending", [], "Create DemoTodoService in Application layer"),
		task(5, "pending", [], "Create DemoTodosController in Web.Api"),
		task(6, "pending", [], "Register DemoTodo services in DI container"),
		task(7, "pending", [], "Write unit and integration tests"),
	]);
}

test("matches the seven-row reference checklist with Tasks title and no telemetry", () => {
	const activity = { activeTaskId: 3, metrics: { startedAt: 0, inputTokens: 4100, outputTokens: 1200 } };
	assert.deepEqual(render(referenceSnapshot(), {}, activity, 0, 169_000), [
		"● Tasks (2/7)",
		"├─ ✔ ~Create DemoTodo domain entity~",
		"├─ ✔ ~Create IDemoTodoRepository interface~",
		"├─ ✳ Create DemoTodoRepository in Infrastructure (Creating DemoTodoRepository implementation)",
		"├─ ◻ Create DemoTodoService in Application layer",
		"├─ ◻ Create DemoTodosController in Web.Api",
		"├─ ◻ Register DemoTodo services in DI container",
		"└─ ◻ Write unit and integration tests",
		"",
	]);
});

test("applies semantic theme roles to heading, branches, statuses and subjects", () => {
	const theme: any = {
		fg: (role: string, text: string) => `<${role}>${text}</${role}>`,
		strikethrough: (text: string) => `<strike>${text}</strike>`,
	};
	const state = snapshot([task(1, "completed", [], "Done"), { ...task(2, "in_progress", [], "Run"), activeForm: "Working" }, task(3)]);
	assert.deepEqual(renderWidget(state, undefined, DEFAULT_TASKS_CONFIG, theme, 200), [
		"<accent>● Tasks (1/3)</accent>",
		"<dim>├─</dim> <success>✔</success> <dim><strike>Done</strike></dim>",
		"<dim>├─</dim> <warning>✳</warning> <text>Run</text><dim> (Working)</dim>",
		"<dim>└─</dim> <dim>◻</dim> <text>Task 3</text>",
		"",
	]);
});

test("shows activeForm only when nonempty and distinct after sanitization", () => {
	for (const activeForm of [undefined, "", " \t\n", "Run", "  Run\u001b[0m "]) {
		assert.equal(render(snapshot([{ ...task(1, "in_progress", [], "Run"), activeForm }]))[1], "└─ ✳ Run");
	}
	assert.equal(render(snapshot([{ ...task(1, "in_progress", [], "Run"), activeForm: "Running" }]))[1], "└─ ✳ Run (Running)");
	assert.equal(render(snapshot([{ ...task(1), activeForm: "Not started" }]))[1], "└─ ◻ Task 1");
});

test("retains blocker IDs without adding task IDs or completed/deleted blockers", () => {
	const state = snapshot([task(1, "completed"), task(2, "in_progress"), task(3, "pending", [1, 2, 4, 99]), task(4, "deleted")]);
	assert.equal(render(state)[0], "● Tasks (1/3)");
	assert.equal(render(state)[3], "└─ ◻ Task 3 › blocked by #2");
});

test("tree endings include top/bottom overflow and completed summaries", () => {
	const state = snapshot([task(1, "completed"), task(2), task(3, "in_progress"), task(4), task(5)]);
	assert.deepEqual(render(state, { maxVisible: 2 }).slice(1), ["├─ ✔ ~Task 1~", "├─ ◻ Task 2", "└─ … and 3 more", ""]);
	assert.deepEqual(render(state, { maxVisible: 2, hiddenAt: "top" }).slice(1), ["├─ … and 3 more", "├─ ◻ Task 4", "└─ ◻ Task 5", ""]);
	assert.deepEqual(render(state, { collapseCompleted: true, maxVisible: 2 }).slice(1), ["├─ ◻ Task 2", "├─ ✳ Task 3", "├─ … and 2 more", "└─ ✔ 1 completed", ""]);
	assert.deepEqual(render(state, { collapseCompleted: true, maxVisible: 2, hiddenAt: "top" }).slice(1), ["├─ … and 2 more", "├─ ◻ Task 4", "├─ ◻ Task 5", "└─ ✔ 1 completed", ""]);
	assert.deepEqual(render(state, { collapseCompleted: true, showAll: true }).slice(-3), ["├─ ◻ Task 5", "└─ ✔ 1 completed", ""]);
});

test("respects sort preferences, show-all inversion and invalid limit fallback", () => {
	const state = snapshot([task(1, "completed"), task(2), task(3, "in_progress"), task(4), task(5)]);
	assert.equal(render(state, { sortOrder: "active" })[1], "├─ ✳ Task 3");
	assert.equal(render(state, { sortOrder: "status" })[1], "├─ ✔ ~Task 1~");
	assert.equal(render(state, { sortOrder: "recent" })[1], "├─ ◻ Task 5");
	assert.equal(render(state, { sortOrder: "oldest" })[1], "├─ ✔ ~Task 1~");
	assert.equal(render(state, { sortOrder: [{ field: "id", direction: "desc" }] })[1], "├─ ◻ Task 5");
	for (const showAll of [false, true]) {
		const lines = renderWidget(state, undefined, { ...DEFAULT_TASKS_CONFIG, showAll, maxVisible: 2 }, plainTheme, 120, 0, true);
		assert.equal(lines.at(-2), showAll ? "└─ … and 3 more" : "└─ ◻ Task 5");
	}
	assert.deepEqual(render(state, { maxVisible: 0 }), render(state));
});

test("empty and deleted-only snapshots disappear; all-completed lists keep their counts", () => {
	assert.deepEqual(render(snapshot()), []);
	assert.deepEqual(render(snapshot([task(1, "deleted")])), []);
	const state = snapshot([task(1, "completed"), task(2, "completed"), task(3, "deleted")]);
	assert.deepEqual(render(state), ["● Tasks (2/2)", "├─ ✔ ~Task 1~", "└─ ✔ ~Task 2~", ""]);
	assert.deepEqual(render(state, { collapseCompleted: true }), ["● Tasks (2/2)", "└─ ✔ 2 completed", ""]);
});

test("uses the original default spinner sequence and wraps after eleven frames", () => {
	const state = snapshot([task(1, "in_progress")]);
	assert.deepEqual(Array.from({ length: 12 }, (_, frame) => render(state, {}, undefined, frame)[1]),
		["✳", "✴", "✵", "✶", "✷", "✸", "✹", "✺", "✻", "✼", "✽", "✳"].map((glyph) => `└─ ${glyph} Task 1`));
});

test("honors shared glyph overrides and spinner fallbacks without an inProgress substitution", () => {
	const state = snapshot([task(1, "completed"), task(2, "in_progress"), task(3, "pending", [2])]);
	const glyphs = { header: "H", completed: "[x]", pending: "[ ]", inProgress: "R", blocked: "!", overflow: "+" };
	assert.deepEqual(render(state, { glyphs }).slice(0, -1), ["H Tasks (1/3)", "├─ [x] ~Task 1~", "├─ ✳ Task 2", "└─ [ ] Task 3 ! blocked by #2"]);
	assert.equal(render(state, { glyphs, collapseCompleted: true }).at(-2), "└─ [x] 1 completed");
	assert.equal(render(state, { glyphs: { ...glyphs, completedSummary: "DONE" }, collapseCompleted: true }).at(-2), "└─ DONE 1 completed");
	assert.equal(render(state, { glyphs, maxVisible: 1 }).at(-2), "└─ + and 2 more");
	assert.deepEqual([0, 1, 2].map((frame) => render(state, { glyphs: { ...glyphs, spinner: ["a", "b"] } }, undefined, frame)[2]), ["├─ a Task 2", "├─ b Task 2", "├─ a Task 2"]);
	assert.equal(render(state, { glyphs: { inProgress: "R", spinner: ["x"] } }, undefined, 9)[2], "├─ x Task 2");
	for (const spinner of [undefined, [], ["ok", "\n"]]) {
		assert.equal(render(state, { glyphs: { inProgress: "R", spinner } }, undefined, 1)[2], "├─ ✴ Task 2");
	}
	assert.deepEqual(render(state, { glyphs: { header: "\u001b]0;bad", completed: "", pending: "\u202e", inProgress: "\n", spinner: [] } }), render(state));
});

test("preserves board duration/token formatting and spinner interval exports", () => {
	assert.equal(SPINNER_INTERVAL_MS, 150);
	assert.deepEqual([59_999, 60_000, 61_000, 3_599_999, 3_600_000, 3_783_000].map(formatDuration), ["59s", "1m", "1m 1s", "59m 59s", "1h", "1h 3m"]);
	assert.deepEqual([999, 1000, 2000, 4100].map(formatTokens), ["999", "1k", "2k", "4.1k"]);
});

function widgetHarness() {
	let component: any;
	const requests: unknown[] = [];
	const registrations: unknown[] = [];
	const ui: any = {
		theme: plainTheme,
		setWidget: (key: string, factory: any, options: unknown) => {
			registrations.push({ key, options, removed: !factory });
			if (factory) component = factory({ requestRender: (force?: boolean) => requests.push(force) }, plainTheme);
		},
	};
	return { ui, requests, registrations, get component() { return component; } };
}

test("default spinner ticks; timers follow config, completion and component disposal", (t) => {
	commitSnapshot("s", snapshot([task(1, "in_progress")]));
	setForeground("s");
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
	assert.equal(harness.component.render(80)[1], "└─ ✳ Task 1");
	callback();
	assert.deepEqual(harness.requests, [undefined]);
	assert.equal(harness.component.render(80)[1], "└─ ✴ Task 1");
	widget.refresh();
	assert.equal(set.mock.callCount(), 1);
	const animated = { ...DEFAULT_TASKS_CONFIG, glyphs: { spinner: ["a", "b"] } };
	widget.setConfig(animated);
	assert.equal(set.mock.callCount(), 1);
	assert.equal(harness.component.render(80)[1], "└─ b Task 1");
	harness.requests.length = 0;
	callback();
	assert.deepEqual(harness.requests, [undefined]);
	assert.equal(harness.component.render(80)[1], "└─ a Task 1");
	widget.setConfig({ ...DEFAULT_TASKS_CONFIG, glyphs: { spinner: ["x"] } });
	assert.equal(clear.mock.callCount(), 1);
	assert.equal(set.mock.callCount(), 1);
	assert.equal(harness.component.render(80)[1], "└─ x Task 1");
	widget.setConfig({ ...DEFAULT_TASKS_CONFIG, glyphs: { inProgress: "R", spinner: [] } });
	assert.equal(set.mock.callCount(), 2);
	assert.equal(harness.component.render(80)[1], "└─ ✵ Task 1");
	commitSnapshot("s", snapshot([task(1, "completed")], 1));
	widget.refresh();
	assert.equal(clear.mock.callCount(), 2);
	commitSnapshot("s", snapshot([task(1, "in_progress")], 2));
	widget.refresh();
	assert.equal(set.mock.callCount(), 3);
	harness.component.dispose();
	assert.equal(clear.mock.callCount(), 3);
	widget.dispose();
	widget.dispose();
	assert.equal(clear.mock.callCount(), 3);
});

test("does not start timers for inactive tasks or a single-frame spinner", (t) => {
	const set = t.mock.method(globalThis, "setInterval", () => 44 as any);
	setForeground("s");
	const harness = widgetHarness();
	const widget = new TaskWidget();
	widget.bind(harness.ui);
	for (const status of ["pending", "completed", "deleted"] as const) {
		commitSnapshot("s", snapshot([task(1, status)]));
		widget.refresh();
	}
	widget.setConfig({ ...DEFAULT_TASKS_CONFIG, glyphs: { spinner: ["x"] } });
	commitSnapshot("s", snapshot([task(1, "in_progress")]));
	widget.refresh();
	assert.equal(harness.component.render(80)[1], "└─ x Task 1");
	assert.equal(set.mock.callCount(), 0);
	widget.dispose();
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

test("toggle stays local, resets on refresh/rebind, and clears registration for empty tasks", () => {
	commitSnapshot("s", referenceSnapshot());
	setForeground("s");
	const config = { ...DEFAULT_TASKS_CONFIG, maxVisible: 2 };
	const original = structuredClone(config);
	const harness = widgetHarness();
	const widget = new TaskWidget(config);
	widget.toggle();
	assert.deepEqual(harness.requests, []);
	widget.bind(harness.ui);
	widget.refresh();
	assert.deepEqual(harness.registrations, [{ key: "tasks", options: { placement: "aboveEditor" }, removed: false }]);
	assert.equal(harness.component.render(80).at(-2), "└─ … and 5 more");
	widget.toggle();
	assert.equal(harness.component.render(80).at(-2), "└─ ◻ Write unit and integration tests");
	assert.deepEqual(harness.requests, [true]);
	widget.refresh(true);
	assert.equal(harness.component.render(80).at(-2), "└─ … and 5 more");
	widget.toggle();
	const other = widgetHarness();
	widget.bind(other.ui);
	widget.refresh();
	assert.equal(other.component.render(80).at(-2), "└─ … and 5 more");
	assert.equal((harness.registrations.at(-1) as any).removed, true);
	assert.deepEqual(widget.getConfig(), original);
	commitSnapshot("s", snapshot());
	widget.refresh();
	assert.equal((other.registrations.at(-1) as any).removed, true);
	widget.dispose();
});

test("component uses the current theme and width on every render", () => {
	commitSnapshot("s", referenceSnapshot());
	setForeground("s");
	const harness = widgetHarness();
	const widget = new TaskWidget();
	widget.bind(harness.ui);
	widget.refresh();
	const wide = harness.component.render(200);
	assert.equal(wide[0], "● Tasks (2/7)");
	assert.ok(harness.component.render(20).every((line: string) => visibleWidth(line) <= 20));
	assert.deepEqual(harness.component.render(200), wide);
	harness.ui.theme = { ...plainTheme, fg: (_role: string, text: string) => `\u001b[32m${text}\u001b[39m` };
	assert.match(harness.component.render(200)[0], /\u001b\[32m/);
	widget.dispose();
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
	const state = referenceSnapshot();
	const config: TaskDisplayConfig = { ...DEFAULT_TASKS_CONFIG, sortOrder: [{ field: "id", direction: "desc" }], glyphs: { spinner: ["a", "b"] } };
	const activity = { activeTaskId: 3, metrics: { startedAt: 0, inputTokens: 12, outputTokens: 34 } };
	const before = structuredClone({ state, config, activity });
	for (const width of [200, 20, 1]) renderWidget(state, activity, config, plainTheme, width, 1, true, 5000);
	assert.deepEqual({ state, config, activity }, before);
});

test("render exceptions are contained", () => {
	const broken: any = { ...plainTheme, fg: () => { throw new Error("theme"); } };
	assert.deepEqual(renderWidget(snapshot([task(1)]), undefined, DEFAULT_TASKS_CONFIG, broken, 80), []);
});
