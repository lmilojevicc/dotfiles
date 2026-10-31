import test from "node:test";
import assert from "node:assert/strict";
import { sortTasks } from "../src/ui/task-sort.ts";
import { task } from "./helpers.ts";

const tasks = [
	{ ...task(2, "pending"), updatedAt: 20 },
	{ ...task(1, "completed"), updatedAt: 30 },
	{ ...task(3, "in_progress"), updatedAt: 20 },
];
const ids = (order: any) => sortTasks(tasks, order).map((item) => item.id);

test("implements all upstream presets and tie breakers", () => {
	assert.deepEqual(ids("id"), [1, 2, 3]);
	assert.deepEqual(ids("status"), [1, 3, 2]);
	assert.deepEqual(ids("active"), [3, 2, 1]);
	assert.deepEqual(ids("recent"), [1, 3, 2]);
	assert.deepEqual(ids("oldest"), [2, 3, 1]);
});

test("valid custom specs work and malformed values fall back to id", () => {
	assert.deepEqual(ids([{ field: "status", rank: ["pending", "completed", "in_progress"] }]), [2, 1, 3]);
	assert.deepEqual(ids([{ field: "id", direction: "desc" }]), [3, 2, 1]);
	assert.deepEqual(ids([]), [1, 2, 3]);
	assert.deepEqual(ids([{ field: "owner" }]), [1, 2, 3]);
	assert.deepEqual(ids("toString"), [1, 2, 3]);
});
