import test from "node:test";
import assert from "node:assert/strict";
import { TaskActivityStore } from "../src/state/activity.ts";
import { snapshot, task } from "./helpers.ts";

test("attributes finite nonnegative parent usage to the sole current active task", () => {
	const store = new TaskActivityStore();
	const state = snapshot([task(1, "in_progress"), task(2)]);
	store.reset("a", state, 100);
	store.addTurnUsage("a", state, 41, 9, 200);
	store.addTurnUsage("a", state, Number.NaN, -4, 300);
	assert.deepEqual(store.get("a"), { activeTaskId: 1, metrics: { startedAt: 100, inputTokens: 41, outputTokens: 9 } });
});

test("reconcile preserves only the same active task and never resurrects dormant metrics", () => {
	const store = new TaskActivityStore();
	const one = snapshot([task(1, "in_progress"), task(2)]);
	store.reset("s", one, 10);
	store.addTurnUsage("s", one, 5, 6);
	assert.equal(store.reconcile("s", one, 20).metrics?.startedAt, 10);
	const paused = snapshot([task(1), task(2)]);
	assert.deepEqual(store.reconcile("s", paused, 30), {});
	const restarted = snapshot([task(1, "in_progress"), task(2)]);
	assert.deepEqual(store.reconcile("s", restarted, 40), { activeTaskId: 1, metrics: { startedAt: 40, inputTokens: 0, outputTokens: 0 } });
	const changed = snapshot([task(1), task(2, "in_progress")]);
	assert.deepEqual(store.reconcile("s", changed, 50), { activeTaskId: 2, metrics: { startedAt: 50, inputTokens: 0, outputTokens: 0 } });
});

test("sessions are isolated and reset/evict boundaries are explicit", () => {
	const store = new TaskActivityStore();
	const state = snapshot([task(1, "in_progress")]);
	store.reset("a", state, 1);
	store.reset("b", state, 2);
	store.addTurnUsage("a", state, 7, 8);
	assert.equal(store.get("a")?.metrics?.inputTokens, 7);
	assert.equal(store.get("b")?.metrics?.inputTokens, 0);
	store.reset("a", state, 3);
	assert.equal(store.get("a")?.metrics?.inputTokens, 0);
	store.evict("b");
	assert.equal(store.get("b"), undefined);
});
