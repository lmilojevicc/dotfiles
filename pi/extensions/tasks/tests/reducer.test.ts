import test from "node:test";
import assert from "node:assert/strict";
import { reduceTasks } from "../src/domain/reducer.ts";
import { snapshot, task } from "./helpers.ts";

test("create trims subject, preserves compatible fields, and increments revision", () => {
	const result = reduceTasks(snapshot(), { action: "create", subject: "  Build feature  ", description: "Details", activeForm: "Building", owner: "worker", metadata: { source: "user" } }, 100);
	assert.equal(result.committed, true);
	assert.equal(result.state.revision, 1);
	assert.deepEqual(result.state.tasks[0], { id: 1, subject: "Build feature", description: "Details", activeForm: "Building", owner: "worker", metadata: { source: "user" }, status: "pending", blockedBy: [], createdAt: 100, updatedAt: 100 });
});

test("update supports field clearing, metadata merge/removal, and no-op revision stability", () => {
	let state = snapshot([{ ...task(1), description: "old", owner: "a", metadata: { keep: 1, remove: 2 } }], 4);
	const changed = reduceTasks(state, { action: "update", id: 1, description: null, owner: null, metadata: { remove: null, add: true } }, 200);
	assert.equal(changed.state.revision, 5);
	assert.deepEqual(changed.state.tasks[0]?.metadata, { keep: 1, add: true });
	assert.equal(changed.state.tasks[0]?.description, undefined);
	state = changed.state;
	const noop = reduceTasks(state, { action: "update", id: 1, status: "pending" }, 300);
	assert.equal(noop.committed, false);
	assert.equal(noop.state.revision, 5);
	assert.equal(noop.state.tasks[0]?.updatedAt, 200);
});

test("enforces one active task and legal transitions", () => {
	const state = snapshot([task(1, "in_progress"), task(2)], 1);
	assert.match(reduceTasks(state, { action: "update", id: 2, status: "in_progress" }).error?.message ?? "", /at most one/);
	assert.equal(reduceTasks(snapshot([task(1, "completed")]), { action: "update", id: 1, status: "pending" }).error?.code, "illegal_transition");
	assert.equal(reduceTasks(snapshot([task(1, "deleted")]), { action: "update", id: 1, subject: "again" }).error?.code, "deleted");
});

test("a blocked task cannot start until every prerequisite is completed", () => {
	const blocked = snapshot([task(1), task(2, "pending", [1])]);
	assert.equal(reduceTasks(blocked, { action: "update", id: 2, status: "in_progress" }).error?.code, "blocked");
	const ready = snapshot([task(1, "completed"), task(2, "pending", [1])]);
	assert.equal(reduceTasks(ready, { action: "update", id: 2, status: "in_progress" }).committed, true);
});

test("delete is gated by live dependents and repeated delete is a no-op", () => {
	const state = snapshot([task(1), task(2, "pending", [1])]);
	assert.equal(reduceTasks(state, { action: "delete", id: 1 }).error?.code, "has_dependents");
	const deleted = snapshot([task(1, "deleted")], 2);
	const result = reduceTasks(deleted, { action: "delete", id: 1 });
	assert.equal(result.committed, false);
	assert.equal(result.state.revision, 2);
});

test("deleting a dependent clears its outbound edges so its prerequisite can be deleted later", () => {
	let state = snapshot([task(1), task(2, "pending", [1])], 1);
	state = reduceTasks(state, { action: "delete", id: 2 }).state;
	assert.deepEqual(state.tasks[1]?.blockedBy, []);
	const prerequisite = reduceTasks(state, { action: "delete", id: 1 });
	assert.equal(prerequisite.committed, true);
});

test("clear preserves monotonic nextId and empty clear is a no-op", () => {
	const result = reduceTasks(snapshot([task(7)], 3, 9), { action: "clear" });
	assert.equal(result.state.nextId, 9);
	assert.equal(result.state.revision, 4);
	const noop = reduceTasks(result.state, { action: "clear" });
	assert.equal(noop.state.revision, 4);
});

test("expectedRevision rejects stale writes atomically", () => {
	const state = snapshot([task(1)], 3);
	const result = reduceTasks(state, { action: "update", id: 1, subject: "new", expectedRevision: 2 });
	assert.equal(result.error?.code, "stale_revision");
	assert.strictEqual(result.state, state);
});

test("read actions and no-op updates do not increment revision", () => {
	const state = snapshot([task(1)], 8);
	assert.equal(reduceTasks(state, { action: "list" }).state.revision, 8);
	assert.equal(reduceTasks(state, { action: "get", id: 1 }).state.revision, 8);
	assert.equal(reduceTasks(state, { action: "get", id: 9 }).error?.code, "not_found");
});

test("rejects action-inapplicable fields", () => {
	const result = reduceTasks(snapshot(), { action: "clear", subject: "ignored" });
	assert.equal(result.error?.code, "invalid_fields");
});

test("metadata must be bounded JSON", () => {
	assert.equal(reduceTasks(snapshot(), { action: "create", subject: "x", metadata: { value: BigInt(1) } }).error?.code, "invalid_metadata");
	assert.equal(reduceTasks(snapshot(), { action: "create", subject: "x", metadata: { huge: "x".repeat(70_000) } }).error?.code, "invalid_metadata");
	assert.equal(reduceTasks(snapshot(), { action: "create", subject: "x", metadata: Object.fromEntries(Array.from({ length: 51 }, (_, index) => [String(index), index])) }).error?.code, "invalid_metadata");
	let nested: Record<string, unknown> = {};
	for (let index = 0; index < 9; index++) nested = { child: nested };
	assert.equal(reduceTasks(snapshot(), { action: "create", subject: "x", metadata: nested }).error?.code, "invalid_metadata");
});

test("all persisted string bounds reject singular creates and updates atomically", () => {
	const createCases = [
		[{ subject: "x".repeat(501) }, "invalid_subject"],
		[{ subject: "x", description: "x".repeat(20_001) }, "invalid_description"],
		[{ subject: "x", activeForm: "x".repeat(501) }, "invalid_active_form"],
		[{ subject: "x", owner: "x".repeat(201) }, "invalid_owner"],
	] as const;
	for (const [fields, code] of createCases) {
		const state = snapshot([], 7);
		const result = reduceTasks(state, { action: "create", ...fields });
		assert.equal(result.error?.code, code);
		assert.strictEqual(result.state, state);
		assert.equal(result.state.revision, 7);
	}
	const state = snapshot([task(1)], 7);
	const update = reduceTasks(state, { action: "update", id: 1, description: "x".repeat(20_001) });
	assert.equal(update.error?.code, "invalid_description");
	assert.strictEqual(update.state, state);
});

test("revision exhaustion rejects changed singular mutations without changing state", () => {
	const state = snapshot([task(1)], Number.MAX_SAFE_INTEGER);
	const result = reduceTasks(state, { action: "update", id: 1, subject: "changed" });
	assert.equal(result.error?.code, "revision_exhausted");
	assert.strictEqual(result.state, state);
	assert.equal(result.committed, false);
});
