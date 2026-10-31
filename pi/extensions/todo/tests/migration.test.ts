import test from "node:test";
import assert from "node:assert/strict";
import { migrateLegacySnapshot } from "../src/state/migration.ts";

test("legacy migration preserves rpiv fields and demotes extra active tasks deterministically", () => {
	const result = migrateLegacySnapshot({
		nextId: 4,
		tasks: [
			{ id: 1, subject: "First", status: "in_progress", metadata: { a: 1 }, owner: "one" },
			{ id: 2, subject: "Second", description: "d", activeForm: "Doing", status: "in_progress", blockedBy: [1] },
			{ id: 3, subject: "Old", status: "deleted" },
		],
	});
	assert.ok(result);
	assert.deepEqual(result.snapshot.tasks.map((task) => task.status), ["in_progress", "pending", "deleted"]);
	assert.deepEqual(result.snapshot.tasks[0]?.metadata, { a: 1 });
	assert.equal(result.snapshot.tasks[0]?.owner, "one");
	assert.match(result.warning ?? "", /paused 1 extra active task/);
});

test("legacy migration repairs nextId and removes dangling legacy edges", () => {
	assert.equal(migrateLegacySnapshot({ nextId: 1, tasks: [{ id: 4, subject: "x", status: "pending" }] })?.snapshot.nextId, 5);
	const repaired = migrateLegacySnapshot({ nextId: 3, tasks: [{ id: 1, subject: "x", status: "pending", blockedBy: [9] }] });
	assert.deepEqual(repaired?.snapshot.tasks[0]?.blockedBy, []);
	assert.match(repaired?.warning ?? "", /removed 1 invalid dependency edge/);
});

test("legacy migration demotes an active task blocked by a pending prerequisite", () => {
	const result = migrateLegacySnapshot({
		nextId: 3,
		tasks: [
			{ id: 1, subject: "Prerequisite", status: "pending" },
			{ id: 2, subject: "Dependent", status: "in_progress", blockedBy: [1] },
		],
	});
	assert.ok(result);
	assert.equal(result.snapshot.tasks[1]?.status, "pending");
	assert.deepEqual(result.snapshot.tasks[1]?.blockedBy, [1]);
	assert.match(result.warning ?? "", /including blocked tasks/);
});

test("legacy cycle repair retains valid edges despite an unrelated raw cycle", () => {
	const result = migrateLegacySnapshot({
		nextId: 5,
		tasks: [
			{ id: 1, subject: "Valid dependent", status: "pending", blockedBy: [2] },
			{ id: 2, subject: "Valid prerequisite", status: "pending" },
			{ id: 3, subject: "Cycle A", status: "pending", blockedBy: [4] },
			{ id: 4, subject: "Cycle B", status: "pending", blockedBy: [3] },
		],
	});
	assert.ok(result);
	assert.deepEqual(result.snapshot.tasks.map((task) => task.blockedBy), [[2], [], [4], []]);
	assert.match(result.warning ?? "", /removed 1 invalid dependency edge/);
});

test("legacy migration rejects persisted fields outside domain bounds", () => {
	assert.equal(migrateLegacySnapshot({ nextId: 2, tasks: [{ id: 1, subject: "x".repeat(501), status: "pending" }] }), undefined);
	assert.equal(migrateLegacySnapshot({ nextId: 2, tasks: [{ id: 1, subject: "x", status: "pending", metadata: { huge: "x".repeat(70_000) } }] }), undefined);
});
