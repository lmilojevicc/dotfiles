import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TASKS_CONFIG, saveGlobalTasksConfig, type TaskDisplayConfig } from "../src/config/tasks-config.ts";
import { registerLifecycle, restoreContext, synchronizationMessage } from "../src/lifecycle.ts";
import { snapshot, task } from "./helpers.ts";
import { STATE_ENTRY } from "../src/state/replay.ts";
import { taskActivity } from "../src/state/activity.ts";
import { commitSnapshot, evictSlot, getSnapshot, resetStore } from "../src/state/store.ts";

test.beforeEach(resetStore);

function ctx(id: string, branch: unknown[] = []) {
	return { sessionManager: { getSessionId: () => id, getBranch: () => branch } } as any;
}

test("lifecycle replay keeps sessions isolated", () => {
	restoreContext(ctx("a", [{ type: "custom", customType: STATE_ENTRY, data: snapshot([task(1)], 1) }]));
	restoreContext(ctx("b", [{ type: "custom", customType: STATE_ENTRY, data: snapshot([task(8)], 2) }]));
	assert.equal(getSnapshot("a").tasks[0]?.id, 1);
	assert.equal(getSnapshot("b").tasks[0]?.id, 8);
	evictSlot("a");
	assert.equal(getSnapshot("a").tasks.length, 0);
	assert.equal(getSnapshot("b").tasks.length, 1);
});

test("foreground session starts load shared global settings across projects and reload without sharing task truth", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "tasks-lifecycle-"));
	const agent = join(root, "agent");
	const originalAgent = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agent;
	t.after(() => {
		if (originalAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgent;
		rmSync(root, { recursive: true, force: true });
	});
	const handlers = new Map<string, Function>();
	const configs: TaskDisplayConfig[] = [];
	registerLifecycle({ on: (name: string, handler: Function) => handlers.set(name, handler) } as any, {
		setConfig: (config) => { configs.push(config); }, refresh() {}, dispose() {},
	});
	const contexts = ["a", "b"].map((id, index) => {
		const cwd = join(root, id);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "tasks-config.json"), JSON.stringify({ maxVisible: index + 1 }));
		return {
			...ctx(id, [{ type: "custom", customType: STATE_ENTRY, data: snapshot([task(index + 1)], 1) }]),
			cwd, mode: "tui", ui: { notify() {} },
		};
	});
	saveGlobalTasksConfig({ showAll: true, maxVisible: 30 });
	for (const context of contexts) await handlers.get("session_start")!({ reason: "startup" }, context);
	assert.deepEqual(configs, Array.from({ length: 2 }, () => ({ ...DEFAULT_TASKS_CONFIG, showAll: true, maxVisible: 30 })));
	saveGlobalTasksConfig({ showAll: false, maxVisible: 20 });
	// Already-applied configs remain cached until another session_start, including /reload.
	assert.equal(configs[0].maxVisible, 30);
	for (const reason of ["reload", "new", "resume", "fork"]) {
		await handlers.get("session_start")!({ reason }, contexts[0]);
		assert.deepEqual(configs.at(-1), { ...DEFAULT_TASKS_CONFIG, maxVisible: 20 });
	}
	assert.equal(getSnapshot("a").tasks[0]?.id, 1);
	assert.equal(getSnapshot("b").tasks[0]?.id, 2);
	for (const [index, context] of contexts.entries()) {
		assert.equal(readFileSync(join(context.cwd, ".pi", "tasks-config.json"), "utf8"), JSON.stringify({ maxVisible: index + 1 }));
	}
});

test("human edit synchronization is one-shot per revision", () => {
	commitSnapshot("a", snapshot([task(1)], 3), true);
	const first = synchronizationMessage("a");
	assert.equal(first?.details.revision, 3);
	assert.match(String(first?.content), /revision 3/);
	assert.equal(synchronizationMessage("a"), undefined);
	commitSnapshot("a", snapshot([task(1), task(2)], 4), true);
	assert.equal(synchronizationMessage("a")?.details.revision, 4);
});

test("registered lifecycle replays start/tree/compaction and cleans stale shutdown contexts", async () => {
	const handlers = new Map<string, Function>();
	const pi = { on: (name: string, handler: Function) => handlers.set(name, handler) } as any;
	const calls = { bind: 0, refresh: 0, dispose: 0 };
	registerLifecycle(pi, {
		bind: () => { calls.bind++; },
		refresh: () => { calls.refresh++; },
		dispose: () => { calls.dispose++; throw new Error("UI context is stale after session replacement"); },
	});
	const context: any = {
		mode: "tui", cwd: "/tmp/pi-tasks-lifecycle",
		sessionManager: { getSessionId: () => "a", getBranch: () => [{ type: "custom", customType: STATE_ENTRY, data: snapshot([task(1)], 1) }] },
		ui: { notify() {} },
	};
	await handlers.get("session_start")!({}, context);
	await handlers.get("session_tree")!({}, context);
	await handlers.get("session_compact")!({}, context);
	assert.equal(getSnapshot("a").revision, 1);
	assert.equal(calls.bind, 1);
	assert.equal(calls.refresh, 3);
	const stale: any = { sessionManager: { getSessionId() { throw new Error("ctx is stale after session replacement"); } } };
	await handlers.get("session_shutdown")!({}, stale);
	assert.equal(calls.dispose, 1);
	assert.equal(getSnapshot("a").tasks.length, 0);
	await handlers.get("session_shutdown")!({}, stale);
	assert.equal(calls.dispose, 1);
});

test("turn usage, compaction preservation, tree reset, and shutdown are ephemeral", async () => {
	const handlers = new Map<string, Function>();
	const pi = { on: (name: string, handler: Function) => handlers.set(name, handler) } as any;
	let refreshes = 0;
	registerLifecycle(pi, { bind() {}, refresh() { refreshes++; }, dispose() {} });
	const running = snapshot([task(1, "in_progress")], 1);
	const branch = [{ type: "custom", customType: STATE_ENTRY, data: running }];
	const context: any = { mode: "tui", cwd: "/tmp/pi-tasks-lifecycle", sessionManager: { getSessionId: () => "a", getBranch: () => branch }, ui: { notify() {} } };
	await handlers.get("session_start")!({}, context);
	const startedAt = taskActivity.get("a")?.metrics?.startedAt;
	await handlers.get("turn_end")!({ message: { role: "assistant", usage: { input: 10, output: 4 } } }, context);
	assert.equal(taskActivity.get("a")?.metrics?.inputTokens, 10);
	await handlers.get("session_compact")!({}, context);
	assert.equal(taskActivity.get("a")?.metrics?.startedAt, startedAt);
	assert.equal(taskActivity.get("a")?.metrics?.inputTokens, 10);
	await handlers.get("session_tree")!({}, context);
	assert.equal(taskActivity.get("a")?.metrics?.inputTokens, 0);
	await handlers.get("session_shutdown")!({}, context);
	assert.equal(taskActivity.get("a"), undefined);
	assert.ok(refreshes >= 4);
});

test("replay of an announced edit does not schedule a reminder loop", () => {
	const state = snapshot([task(1)], 2);
	restoreContext(ctx("a", [
		{ type: "custom", customType: STATE_ENTRY, data: state },
		{ type: "custom_message", customType: "pi-tasks-sync", details: { revision: 2 } },
	]));
	assert.equal(synchronizationMessage("a"), undefined);
});
