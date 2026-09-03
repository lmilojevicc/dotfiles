import test from "node:test";
import assert from "node:assert/strict";
import { findCycle, unresolvedDependencies } from "../src/domain/graph.ts";
import { reduceTasks } from "../src/domain/reducer.ts";
import { snapshot, task } from "./helpers.ts";

test("findCycle detects long cycles", () => {
	assert.deepEqual(findCycle([task(1, "pending", [2]), task(2, "pending", [3]), task(3, "pending", [1])]), [1, 2, 3, 1]);
	assert.equal(findCycle([task(1), task(2, "pending", [1])]), undefined);
});

test("dependencies reject self, duplicates, dangling and deleted targets", () => {
	const state = snapshot([task(1), task(2), task(3, "deleted")]);
	assert.equal(reduceTasks(state, { action: "update", id: 1, addBlockedBy: [1] }).error?.code, "self_dependency");
	assert.equal(reduceTasks(state, { action: "update", id: 1, addBlockedBy: [2, 2] }).error?.code, "invalid_dependencies");
	assert.equal(reduceTasks(state, { action: "update", id: 1, addBlockedBy: [9] }).error?.code, "invalid_dependency");
	assert.equal(reduceTasks(state, { action: "update", id: 1, addBlockedBy: [3] }).error?.code, "invalid_dependency");
});

test("updates reject dependency cycles", () => {
	const state = snapshot([task(1), task(2, "pending", [1])]);
	assert.match(reduceTasks(state, { action: "update", id: 1, addBlockedBy: [2] }).error?.message ?? "", /cycle/);
});

test("unresolvedDependencies accepts only completed prerequisites", () => {
	const target = task(3, "pending", [1, 2]);
	assert.deepEqual(unresolvedDependencies(target, [task(1, "completed"), task(2), target]), [2]);
});
