import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_TASKS_CONFIG } from "../src/config/tasks-config.ts";
import { taskActivity } from "../src/state/activity.ts";
import { commitSnapshot, resetStore, setForeground } from "../src/state/store.ts";
import { formatDuration, formatTokens, renderWidget, SPINNER_INTERVAL_MS, TaskWidget } from "../src/ui/widget.ts";
import { plainTheme, snapshot, task } from "./helpers.ts";

test.beforeEach(resetStore);

const render = (state: ReturnType<typeof snapshot>, options: Partial<typeof DEFAULT_TASKS_CONFIG> = {}, activity?: any, frame = 0, now = 0) =>
	renderWidget(state, activity, { ...DEFAULT_TASKS_CONFIG, ...options }, plainTheme, 120, frame, false, now);

test("renders exact upstream header grammar, source order, rows, and blocker suffix", () => {
	const state = snapshot([
		{ ...task(1, "completed", [], "Done"), updatedAt: 4 },
		{ ...task(2, "in_progress", [], "Run"), activeForm: "Working" },
		{ ...task(3, "pending", [1, 2], "Open") },
	]);
	const activity = { activeTaskId: 2, metrics: { startedAt: 0, inputTokens: 4100, outputTokens: 1200 } };
	assert.deepEqual(render(state, {}, activity, 0, 169_000), [
		"● 3 tasks (1 done, 1 in progress, 1 open)",
		"  ✔ ~#1 Done~",
		"  ✳ #2 Working… (2m 49s · ↑ 4.1k ↓ 1.2k)",
		"  ◻ #3 Open › blocked by #2",
		"",
	]);
});

test("applies exact sentinel theme roles", () => {
	const theme: any = {
		fg: (role: string, text: string) => `<${role}>${text}</${role}>`,
		strikethrough: (text: string) => `<strike>${text}</strike>`,
	};
	const state = snapshot([task(1, "completed", [], "Done"), { ...task(2, "in_progress"), activeForm: "Working" }, task(3)]);
	const lines = renderWidget(state, { activeTaskId: 2, metrics: { startedAt: 0, inputTokens: 0, outputTokens: 0 } }, DEFAULT_TASKS_CONFIG, theme, 200, 0, false, 12_000);
	assert.equal(lines[0], "<accent>●</accent> <accent>3 tasks (1 done, 1 in progress, 1 open)</accent>");
	assert.equal(lines[1], "  <success>✔</success> <dim><strike>#1 Done</strike></dim>");
	assert.equal(lines[2], "  <accent>✳</accent> <dim>#2</dim> <accent>Working…</accent> <dim>(12s)</dim>");
	assert.equal(lines[3], "  ◻ <dim>#3</dim> Task 3");
});

test("supports collapse, limits, top/bottom overflow, show-all toggle, and sort modes", () => {
	const state = snapshot([task(1, "completed"), task(2), task(3, "in_progress"), task(4), task(5)]);
	assert.deepEqual(render(state, { maxVisible: 2 }).slice(1, -1).map((line) => line.match(/#\d+/)?.[0] ?? line), ["#1", "#2", "    … and 3 more"]);
	assert.deepEqual(render(state, { maxVisible: 2, hiddenAt: "top" }).slice(1, -1).map((line) => line.match(/#\d+/)?.[0] ?? line), ["    … and 3 more", "#4", "#5"]);
	assert.deepEqual(render(state, { collapseCompleted: true, maxVisible: 2 }).slice(1, -1), ["  ◻ #2 Task 2", "  ✳ #3 Task 3… (0s)", "    … and 2 more", "  ✔ 1 completed"]);
	assert.equal(renderWidget(state, undefined, { ...DEFAULT_TASKS_CONFIG, showAll: true, maxVisible: 2 }, plainTheme, 120, 0, true).at(-2), "    … and 3 more");
	assert.match(render(state, { sortOrder: "active" })[1]!, /#3/);
	assert.match(render(state, { sortOrder: "status" })[1]!, /#1/);
});

test("uses all eleven spinner frames and exact formatting boundaries", () => {
	const state = snapshot([{ ...task(1, "in_progress"), activeForm: "Doing" }]);
	assert.match(render(state)[1]!, /✳ #1 Doing… \(0s\)/);
	const activity = { activeTaskId: 1, metrics: { startedAt: 0, inputTokens: 0, outputTokens: 0 } };
	const expected = ["✳", "✴", "✵", "✶", "✷", "✸", "✹", "✺", "✻", "✼", "✽", "✳"];
	assert.deepEqual(expected.map((_glyph, frame) => render(state, {}, activity, frame, 0)[1]!.split(" ")[2]), expected);
	assert.equal(SPINNER_INTERVAL_MS, 150);
	assert.deepEqual([59_999, 60_000, 61_000, 3_599_999, 3_600_000, 3_783_000].map(formatDuration), ["59s", "1m", "1m 1s", "59m 59s", "1h", "1h 3m"]);
	assert.deepEqual([999, 1000, 2000, 4100].map(formatTokens), ["999", "1k", "2k", "4.1k"]);
});

test("component timer ticks at 150ms, requests unforced render, and disposes", () => {
	const state = snapshot([task(1, "in_progress")]);
	commitSnapshot("s", state);
	setForeground("s");
	taskActivity.reset("s", state, 0);
	const originalSet = globalThis.setInterval;
	const originalClear = globalThis.clearInterval;
	let callback = () => {};
	let delay = 0;
	let cleared = false;
	(globalThis as any).setInterval = (cb: () => void, ms: number) => { callback = cb; delay = ms; return 44; };
	(globalThis as any).clearInterval = (id: number) => { if (id === 44) cleared = true; };
	try {
		let component: any;
		const requests: unknown[] = [];
		const ui: any = {
			theme: plainTheme,
			setWidget: (_key: string, factory: any) => { if (factory) component = factory({ requestRender: (force?: boolean) => requests.push(force) }, plainTheme); },
		};
		const widget = new TaskWidget();
		widget.bind(ui);
		widget.refresh();
		assert.equal(delay, 150);
		assert.match(component.render(80)[1], /✳/);
		callback();
		assert.deepEqual(requests, [undefined]);
		assert.match(component.render(80)[1], /✴/);
		component.dispose();
		assert.equal(cleared, true);
	} finally {
		globalThis.setInterval = originalSet;
		globalThis.clearInterval = originalClear;
	}
});

test("clips and sanitizes every line at hostile narrow widths", () => {
	const state = snapshot([{ ...task(1), subject: "safe\u001bc\u001bPpayload\u001b\\ tail " + "長".repeat(30) }]);
	for (const width of [80, 20, 5, 1]) {
		const lines = renderWidget(state, undefined, DEFAULT_TASKS_CONFIG, plainTheme, width);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		assert.doesNotMatch(lines.join("\n"), /payload|\u001bP|\u001bc/);
	}
});

test("empty snapshots and render exceptions are contained", () => {
	assert.deepEqual(renderWidget(snapshot(), undefined, DEFAULT_TASKS_CONFIG, plainTheme, 80), []);
	const broken: any = { ...plainTheme, fg: () => { throw new Error("theme"); } };
	assert.deepEqual(renderWidget(snapshot([task(1)]), undefined, DEFAULT_TASKS_CONFIG, broken, 80), []);
});
