import test from "node:test";
import assert from "node:assert/strict";
import { replayBranch, STATE_ENTRY, SYNC_MESSAGE } from "../src/state/replay.ts";
import { snapshot, task } from "./helpers.ts";

test("latest valid snapshot wins across mixed tool, legacy, and custom entries", () => {
	const modern = snapshot([task(1)], 2);
	const human = snapshot([task(1), task(2)], 3);
	const replay = replayBranch([
		{ type: "message", message: { role: "toolResult", toolName: "todo", details: { tasks: [{ id: 9, subject: "legacy", status: "pending" }], nextId: 10 } } },
		{ type: "message", message: { role: "toolResult", toolName: "todo", details: modern } },
		{ type: "message", message: { role: "toolResult", toolName: "todo", details: { kind: "pi.tasks.snapshot", schemaVersion: 1, revision: -1, nextId: 1, tasks: [] } } },
		{ type: "custom", customType: STATE_ENTRY, data: human },
	]);
	assert.equal(replay.snapshot.revision, 3);
	assert.equal(replay.snapshot.tasks.length, 2);
	assert.equal(replay.pendingHumanRevision, 3);
});

test("modern tool snapshots with invalid revisions are skipped without legacy fallback", () => {
	const valid = snapshot([task(1)], 2);
	for (const schemaVersion of [1, 99]) {
		const replay = replayBranch([
			{ type: "message", message: { role: "toolResult", toolName: "todo", details: valid } },
			{ type: "message", message: { role: "toolResult", toolName: "todo", details: { ...valid, schemaVersion, revision: -1 } } },
		]);
		assert.equal(replay.snapshot.revision, 2);
		assert.equal(replay.snapshot.tasks[0]?.id, 1);
	}
});

test("malformed modern blocked-active tool snapshots are skipped rather than repaired as legacy", () => {
	const valid = snapshot([task(7)], 2);
	const invalid = snapshot([task(1), task(2, "in_progress", [1])], 3);
	const replay = replayBranch([
		{ type: "message", message: { role: "toolResult", toolName: "todo", details: valid } },
		{ type: "message", message: { role: "toolResult", toolName: "todo", details: invalid } },
	]);
	assert.equal(replay.snapshot.revision, 2);
	assert.equal(replay.snapshot.tasks[0]?.id, 7);
	assert.equal(replay.migrationWarning, undefined);
});

test("human synchronization revisions replay without repeating an announcement", () => {
	const state = snapshot([task(1)], 4);
	const replay = replayBranch([
		{ type: "custom", customType: STATE_ENTRY, data: state },
		{ type: "custom_message", customType: SYNC_MESSAGE, details: { revision: 4 } },
	]);
	assert.equal(replay.announcedRevision, 4);
	assert.equal(replay.pendingHumanRevision, undefined);
});

test("invalid newest entries are skipped instead of erasing prior valid state", () => {
	const valid = snapshot([task(1)], 1);
	const replay = replayBranch([
		{ type: "custom", customType: STATE_ENTRY, data: valid },
		{ type: "custom", customType: STATE_ENTRY, data: { ...valid, nextId: 1 } },
	]);
	assert.equal(replay.snapshot.revision, 1);
	assert.equal(replay.snapshot.nextId, 2);
});

test("replay rejects modern snapshots with an active task blocked by a pending prerequisite", () => {
	const valid = snapshot([task(7)], 2);
	const invalid = snapshot([task(1), task(2, "in_progress", [1])], 3);
	const replay = replayBranch([
		{ type: "custom", customType: STATE_ENTRY, data: valid },
		{ type: "custom", customType: STATE_ENTRY, data: invalid },
	]);
	assert.equal(replay.snapshot.revision, 2);
	assert.equal(replay.snapshot.tasks[0]?.id, 7);
});

test("replay migrates and demotes a legacy active dependent with a pending prerequisite", () => {
	const replay = replayBranch([{ type: "message", message: { role: "toolResult", toolName: "todo", details: {
		nextId: 3,
		tasks: [
			{ id: 1, subject: "Prerequisite", status: "pending" },
			{ id: 2, subject: "Dependent", status: "in_progress", blockedBy: [1] },
		],
	} } }]);
	assert.deepEqual(replay.snapshot.tasks.map((entry) => entry.status), ["pending", "pending"]);
	assert.deepEqual(replay.snapshot.tasks[1]?.blockedBy, [1]);
});

test("replay rejects snapshots that bypass string or metadata bounds", () => {
	const valid = snapshot([task(1)], 1);
	const oversizedSubject = snapshot([{ ...task(2), subject: "x".repeat(501) }], 2);
	const oversizedMetadata = snapshot([{ ...task(3), metadata: { huge: "x".repeat(70_000) } }], 3);
	const replay = replayBranch([
		{ type: "custom", customType: STATE_ENTRY, data: valid },
		{ type: "custom", customType: STATE_ENTRY, data: oversizedSubject },
		{ type: "custom", customType: STATE_ENTRY, data: oversizedMetadata },
	]);
	assert.equal(replay.snapshot.revision, 1);
	assert.equal(replay.snapshot.tasks[0]?.id, 1);
});
