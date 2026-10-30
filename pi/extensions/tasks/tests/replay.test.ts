import test from "node:test";
import assert from "node:assert/strict";
import { MIGRATION_ENTRY, replayBranch, STATE_ENTRY, SYNC_MESSAGE } from "../src/state/replay.ts";
import { snapshot, task } from "./helpers.ts";

test("replay reads only the newest snapshot, not every snapshot in a long branch", () => {
	// Counting accessors stand in for the per-task validation and cloning work: a metadata value is
	// read once per validateSnapshot and once more per cloneSnapshot.
	let olderReads = 0;
	const counting = (id: number, revision: number) => ({
		type: "custom",
		customType: STATE_ENTRY,
		data: snapshot([{ ...task(id), metadata: { get marker() { olderReads++; return id; } } }], revision),
	});
	const branch = [
		counting(1, 1),
		counting(2, 2),
		{ type: "custom_message", customType: SYNC_MESSAGE, details: { revision: 2 } },
		{ type: "message", message: { role: "toolResult", toolName: "todo", details: snapshot([task(8)], 3) } },
		{ type: "custom", customType: STATE_ENTRY, data: snapshot([task(9)], 4) },
	];
	const replay = replayBranch(branch);
	assert.equal(replay.snapshot.revision, 4);
	assert.equal(replay.snapshot.tasks[0]?.id, 9);
	assert.equal(olderReads, 0, "superseded snapshots must not be validated or cloned");
	assert.equal(replay.pendingHumanRevision, 4, "the newest human edit is still reported as unannounced");
});

test("replay still reports the newest unannounced human revision in a long branch", () => {
	const replay = replayBranch([
		{ type: "custom", customType: STATE_ENTRY, data: snapshot([task(1)], 1) },
		{ type: "custom_message", customType: SYNC_MESSAGE, details: { revision: 1 } },
		{ type: "custom", customType: STATE_ENTRY, data: snapshot([task(1), task(2)], 2) },
		{ type: "custom", customType: STATE_ENTRY, data: { ...snapshot([task(1)], 3), nextId: 1 } },
	]);
	assert.equal(replay.announcedRevision, 1);
	assert.equal(replay.pendingHumanRevision, 2, "an invalid newer entry must not announce itself");
});

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

const legacyResult = (subject: string) => ({
	type: "message",
	message: {
		role: "toolResult",
		toolName: "todo",
		details: {
			nextId: 3,
			tasks: [
				{ id: 1, subject, status: "pending" },
				{ id: 2, subject: "Dependent", status: "in_progress", blockedBy: [1] },
			],
		},
	},
});
const notice = { type: "custom", customType: MIGRATION_ENTRY, data: { warning: "Migrated legacy tasks: paused 1 extra active task." } };

test("a reported-migration marker only covers the legacy snapshot it followed", () => {
	const covered = replayBranch([legacyResult("First"), notice]);
	assert.match(String(covered.migrationWarning), /^Migrated legacy tasks: /);
	assert.equal(covered.migrationAnnounced, true);
	// A newer legacy result is a new migration the user has not seen yet.
	const fresh = replayBranch([legacyResult("First"), notice, legacyResult("Second")]);
	assert.equal(fresh.snapshot.tasks[0]?.subject, "Second");
	assert.equal(fresh.migrationAnnounced, undefined);
	// A modern snapshot clears the notice entirely.
	const modern = replayBranch([legacyResult("First"), { type: "custom", customType: STATE_ENTRY, data: snapshot([task(1)], 1) }]);
	assert.equal(modern.migrationWarning, undefined);
	assert.equal(modern.migrationAnnounced, undefined);
});
