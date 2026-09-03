import test from "node:test";
import assert from "node:assert/strict";
import { reduceTasks } from "../src/domain/reducer.ts";
import { snapshot, task } from "./helpers.ts";

test("batch resolves preceding-create refs and increments revision exactly once", () => {
	const result = reduceTasks(snapshot([], 5), {
		action: "batch",
		expectedRevision: 5,
		operations: [
			{ op: "create", ref: "foundation", subject: "Build foundation" },
			{ op: "create", ref: "finish", subject: "Finish", blockedBy: [{ ref: "foundation" }] },
			{ op: "update", target: { ref: "foundation" }, status: "completed" },
			{ op: "update", target: { ref: "finish" }, status: "in_progress" },
		],
	}, 50);
	assert.equal(result.committed, true);
	assert.equal(result.state.revision, 6);
	assert.equal(result.state.nextId, 3);
	assert.deepEqual(result.state.tasks.map(({ id, status, blockedBy }) => ({ id, status, blockedBy })), [
		{ id: 1, status: "completed", blockedBy: [] },
		{ id: 2, status: "in_progress", blockedBy: [1] },
	]);
	assert.deepEqual(result.operationResults?.map((entry) => entry.id), [1, 2, 1, 2]);
});

test("batch rolls back all operations and reports the failing index", () => {
	const state = snapshot([task(1)], 2);
	const result = reduceTasks(state, {
		action: "batch",
		operations: [
			{ op: "update", target: 1, subject: "Changed" },
			{ op: "update", target: 99, status: "completed" },
		],
	});
	assert.strictEqual(result.state, state);
	assert.equal(result.committed, false);
	assert.equal(result.error?.operationIndex, 1);
	assert.equal(state.tasks[0]?.subject, "Task 1");
});

test("batch rejects forward, duplicate, and unknown refs", () => {
	const forward = reduceTasks(snapshot(), { action: "batch", operations: [{ op: "create", subject: "x", blockedBy: [{ ref: "later" }] }, { op: "create", ref: "later", subject: "y" }] });
	assert.equal(forward.error?.code, "unknown_ref");
	assert.equal(forward.error?.operationIndex, 0);
	const duplicate = reduceTasks(snapshot(), { action: "batch", operations: [{ op: "create", ref: "x", subject: "a" }, { op: "create", ref: "x", subject: "b" }] });
	assert.equal(duplicate.error?.code, "invalid_ref");
});

test("batch supports remove-edge then delete as one transaction", () => {
	const state = snapshot([task(1), task(2, "pending", [1])], 7);
	const result = reduceTasks(state, { action: "batch", operations: [{ op: "update", target: 2, removeBlockedBy: [1] }, { op: "delete", target: 1 }] });
	assert.equal(result.committed, true);
	assert.equal(result.state.revision, 8);
	assert.equal(result.state.tasks[0]?.status, "deleted");
});

test("batch stale revision and invalid operation count do not allocate ids", () => {
	const state = snapshot([], 3, 10);
	assert.equal(reduceTasks(state, { action: "batch", expectedRevision: 2, operations: [{ op: "create", subject: "x" }] }).error?.code, "stale_revision");
	const empty = reduceTasks(state, { action: "batch", operations: [] });
	assert.equal(empty.error?.code, "invalid_batch");
	assert.equal(empty.state.nextId, 10);
});

test("an all-no-op batch keeps the revision", () => {
	const state = snapshot([task(1)], 4);
	const result = reduceTasks(state, { action: "batch", operations: [{ op: "update", target: 1, status: "pending" }] });
	assert.equal(result.committed, false);
	assert.equal(result.state.revision, 4);
});

test("batch string and metadata bounds roll back earlier operations", () => {
	const state = snapshot([task(1)], 4);
	const oversized = reduceTasks(state, { action: "batch", operations: [
		{ op: "update", target: 1, subject: "changed" },
		{ op: "create", subject: "new", owner: "x".repeat(201) },
	] });
	assert.equal(oversized.error?.code, "invalid_owner");
	assert.equal(oversized.error?.operationIndex, 1);
	assert.strictEqual(oversized.state, state);
	const metadata = reduceTasks(state, { action: "batch", operations: [
		{ op: "update", target: 1, metadata: Object.fromEntries(Array.from({ length: 51 }, (_, index) => [String(index), index])) },
	] });
	assert.equal(metadata.error?.code, "invalid_metadata");
	assert.strictEqual(metadata.state, state);
});

test("revision exhaustion rejects an otherwise valid atomic batch", () => {
	const state = snapshot([task(1)], Number.MAX_SAFE_INTEGER);
	const result = reduceTasks(state, { action: "batch", operations: [{ op: "update", target: 1, subject: "changed" }] });
	assert.equal(result.error?.code, "revision_exhausted");
	assert.strictEqual(result.state, state);
	assert.equal(result.committed, false);
});
