import test from "node:test";
import assert from "node:assert/strict";
import { applyHumanMutation, openTaskManager, reduceClearCompleted } from "../src/ui/controller.ts";
import { getSnapshot, resetStore } from "../src/state/store.ts";
import { snapshot, task } from "./helpers.ts";

test.beforeEach(resetStore);

function harness(responses: Array<string | undefined> = [], mode = "tui") {
	const calls: any = { select: [], input: [], notify: [], confirm: [] };
	const ctx: any = {
		mode, cwd: "/tmp/tasks-controller-no-settings", sessionManager: { getSessionId: () => "session" },
		ui: {
			select: async (title: string, options: string[]) => { calls.select.push([title, options]); return responses.shift(); },
			input: async (title: string) => { calls.input.push(title); return responses.shift(); },
			confirm: async (...args: any[]) => { calls.confirm.push(args); return responses.shift() === "yes"; },
			notify: (...args: any[]) => calls.notify.push(args),
			custom: async () => undefined,
		},
	};
	const entries: any[] = [];
	const pi: any = { appendEntry: (...args: any[]) => entries.push(args) };
	return { ctx, calls, pi, entries };
}

test("human mutations append full snapshots only on commit and preserve explicit revision expectations", () => {
	const { ctx, pi, entries } = harness();
	assert.equal(applyHumanMutation(pi, ctx, { action: "create", subject: "One" }).changed, true);
	assert.equal(entries[0][0], "pi-tasks-state");
	assert.equal(applyHumanMutation(pi, ctx, { action: "update", id: 1, status: "pending" }).changed, false);
	const stale = applyHumanMutation(pi, ctx, { action: "update", id: 1, subject: "Stale", expectedRevision: 0 });
	assert.deepEqual(stale, { changed: false, error: "expected revision 0, current revision is 1" });
	assert.equal(getSnapshot("session").tasks[0]?.subject, "One");
	assert.equal(entries.length, 1);
});

test("main menu uses exact dynamic upstream order", async () => {
	const { ctx, calls, pi } = harness();
	applyHumanMutation(pi, ctx, { action: "create", subject: "Open" });
	applyHumanMutation(pi, ctx, { action: "create", subject: "Done" });
	applyHumanMutation(pi, ctx, { action: "update", id: 2, status: "completed" });
	await openTaskManager(pi, ctx);
	assert.deepEqual(calls.select[0], ["Tasks", ["View all tasks (2)", "Create task", "Clear completed (1)", "Clear all (2)", "Settings"]]);
});

test("list and detail flows have exact rows, titles, and status actions", async () => {
	const { ctx, calls, pi } = harness(["View all tasks (3)", "◻ #1 [pending] Pending", "← Back", undefined]);
	applyHumanMutation(pi, ctx, { action: "create", subject: "Pending", description: "Details" });
	applyHumanMutation(pi, ctx, { action: "create", subject: "Running" });
	applyHumanMutation(pi, ctx, { action: "update", id: 2, status: "in_progress" });
	applyHumanMutation(pi, ctx, { action: "create", subject: "Done" });
	applyHumanMutation(pi, ctx, { action: "update", id: 2, status: "completed" });
	applyHumanMutation(pi, ctx, { action: "update", id: 3, status: "completed" });
	await openTaskManager(pi, ctx);
	assert.deepEqual(calls.select[1], ["Tasks", ["◻ #1 [pending] Pending", "✔ #2 [completed] Running", "✔ #3 [completed] Done", "← Back"]]);
	assert.deepEqual(calls.select[2], ["#1 [pending] Pending\nDetails", ["▸ Start (in_progress)", "✗ Delete", "← Back"]]);
});

test("empty view and create cancellation/empty description persist nothing", async () => {
	const empty = harness(["View all tasks (0)", "← Back", undefined]);
	await openTaskManager(empty.pi, empty.ctx);
	assert.deepEqual(empty.calls.select[1], ["No tasks", ["← Back"]]);
	const create = harness(["Create task", "Subject", "", undefined]);
	await openTaskManager(create.pi, create.ctx);
	assert.deepEqual(create.calls.input, ["Task subject", "Task description"]);
	assert.equal(getSnapshot("session").tasks.length, 0);
});

test("delete and clear-all retain confirmations", async () => {
	const remove = harness(["View all tasks (1)", "◻ #1 [pending] Keep", "✗ Delete", undefined, undefined]);
	applyHumanMutation(remove.pi, remove.ctx, { action: "create", subject: "Keep" });
	await openTaskManager(remove.pi, remove.ctx);
	assert.deepEqual(remove.calls.confirm[0], ["Delete task", "Delete #1 Keep?"]);
	assert.equal(getSnapshot("session").tasks[0]?.status, "pending");

	resetStore();
	const clear = harness(["Clear all (1)", "yes", undefined]);
	applyHumanMutation(clear.pi, clear.ctx, { action: "create", subject: "Gone" });
	await openTaskManager(clear.pi, clear.ctx);
	assert.deepEqual(clear.calls.confirm[0], ["Clear all tasks", "Delete all 1 tasks?"]);
	assert.equal(getSnapshot("session").tasks.length, 0);
});

test("starting a second task surfaces the one-active reducer error", async () => {
	const h = harness(["View all tasks (2)", "◻ #2 [pending] Two", "▸ Start (in_progress)", "← Back", undefined]);
	applyHumanMutation(h.pi, h.ctx, { action: "create", subject: "One" });
	applyHumanMutation(h.pi, h.ctx, { action: "update", id: 1, status: "in_progress" });
	applyHumanMutation(h.pi, h.ctx, { action: "create", subject: "Two" });
	await openTaskManager(h.pi, h.ctx);
	assert.match(h.calls.notify.at(-1)?.[0] ?? "", /at most one task may be in_progress/);
	assert.equal(getSnapshot("session").tasks[1]?.status, "pending");
});

test("clear completed is one atomic commit and rejects surviving dependents", () => {
	const blocked = snapshot([task(1, "completed"), task(2, "pending", [1])], 4);
	const failure = reduceClearCompleted(blocked);
	assert.equal(failure.committed, false);
	assert.equal(failure.state, blocked);
	assert.equal(failure.error?.code, "has_dependents");
	const many = snapshot(Array.from({ length: 75 }, (_, index) => task(index + 1, "completed")), 2);
	const result = reduceClearCompleted(many);
	assert.equal(result.committed, true);
	assert.equal(result.state.tasks.length, 0);
	assert.equal(result.state.revision, 3);
});

test("non-TUI manager fails gracefully", async () => {
	const h = harness([], "rpc");
	await openTaskManager(h.pi, h.ctx);
	assert.match(h.calls.notify[0][0], /requires TUI mode/);
	assert.equal(h.calls.select.length, 0);
});
