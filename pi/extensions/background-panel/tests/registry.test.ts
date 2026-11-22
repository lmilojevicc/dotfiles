import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BackgroundJob } from "../protocol.ts";
import { backgroundJobsSummary, BackgroundJobsRegistry, type TabJob } from "../registry.ts";

const shellTab = {
	id: "shell",
	label: "Shell",
	noun: ["shell", "shells"] as [string, string],
	order: 20,
};
const agentTab = {
	id: "subagents",
	label: "Subagents",
	noun: ["subagent", "subagents"] as [string, string],
	order: 10,
};

function publish(
	registry: BackgroundJobsRegistry,
	source: string,
	tab: typeof shellTab,
	jobs: BackgroundJob[],
): void {
	registry.update(source, tab, jobs);
}

describe("background-jobs registry", () => {
	it("groups sources into ordered tabs and removes them", () => {
		const registry = new BackgroundJobsRegistry();
		assert.equal(registry.hasJobs(), false);
		publish(registry, "bash", shellTab, [{ id: "1", title: "npm run dev", status: "running" }]);
		publish(registry, "agents", agentTab, [{ id: "a", title: "scout: look", status: "running" }]);
		assert.deepEqual(
			registry.tabs().map((tab) => [tab.id, tab.jobs.map((job) => job.key)]),
			[
				["subagents", ["agents:a"]],
				["shell", ["bash:1"]],
			],
		);
		assert.equal(registry.hasJobs(), true);
		registry.remove("bash");
		assert.deepEqual(
			registry.tabs().map((tab) => tab.id),
			["subagents"],
		);
		assert.equal(registry.hasJobs(), true);
		registry.remove("bash");
		assert.equal(typeof registry.onChange(() => {}), "function");
	});

	it("notifies listeners on change and on explicit refresh", () => {
		const registry = new BackgroundJobsRegistry();
		let changes = 0;
		registry.onChange(() => {
			changes += 1;
		});
		publish(registry, "bash", shellTab, [{ id: "1", title: "x", status: "running" }]);
		registry.changed();
		registry.remove("nope");
		registry.clear();
		registry.clear();
		assert.equal(changes, 3);
	});

	it("lets config tab order override the provider order", () => {
		const registry = new BackgroundJobsRegistry();
		publish(registry, "bash", shellTab, [{ id: "1", title: "x", status: "running" }]);
		publish(registry, "agents", agentTab, [{ id: "a", title: "y", status: "running" }]);
		assert.deepEqual(
			registry.tabs({ shell: 5 }).map((tab) => tab.id),
			["shell", "subagents"],
		);
		assert.deepEqual(
			registry.tabs().map((tab) => tab.id),
			["subagents", "shell"],
		);
	});

	it("arranges jobs as a tree: newest first, children by order, loops flattened", () => {
		const registry = new BackgroundJobsRegistry();
		publish(registry, "agents", agentTab, [
			{ id: "w1#1", parentId: "w1", order: 1, title: "reviewer", status: "running", startedAt: 3 },
			{
				id: "w1#0",
				parentId: "w1",
				order: 0,
				title: "scout",
				status: "done",
				startedAt: 1,
				endedAt: 42_000,
			},
			{ id: "w1", title: "Workflow: review-and-fix", status: "running", startedAt: 2 },
			{ id: "solo", title: "researcher: cats", status: "running", startedAt: 5 },
			{ id: "orphan", parentId: "gone", order: 0, title: "orphan", status: "done", startedAt: 4 },
			{ id: "loopA", parentId: "loopB", title: "loop a", status: "done", startedAt: 6 },
			{ id: "loopB", parentId: "loopA", title: "loop b", status: "done", startedAt: 7 },
			{ id: "w1#2", parentId: "w1#0", title: "grandchild flattens", status: "done", startedAt: 8 },
		]);
		const jobs = registry.tabs()[0].jobs;
		assert.deepEqual(
			jobs.map((job: TabJob) => [job.id, job.depth, job.last, job.childCount]),
			[
				["solo", 0, false, 0],
				["orphan", 0, false, 0],
				["w1", 0, false, 2],
				["w1#0", 1, false, 1],
				["w1#2", 1, false, 0],
				["w1#1", 1, true, 0],
				["loopA", 0, false, 1],
				["loopB", 0, false, 1],
			],
		);
	});

	it("finds a job by key across tabs", () => {
		const registry = new BackgroundJobsRegistry();
		publish(registry, "bash", shellTab, [{ id: "1", title: "x", status: "running" }]);
		assert.equal(registry.job("bash:1")?.title, "x");
		assert.equal(registry.job("bash:2"), undefined);
	});

	it("caps the number of sources", () => {
		const registry = new BackgroundJobsRegistry();
		for (let index = 0; index < 32; index += 1)
			publish(registry, `s${index}`, { ...shellTab, id: `t${index}` }, [
				{ id: "1", title: "x", status: "running" },
			]);
		publish(registry, "extra", { ...shellTab, id: "extra" }, [
			{ id: "1", title: "x", status: "running" },
		]);
		assert.equal(
			registry.tabs().some((tab) => tab.id === "extra"),
			false,
		);
		publish(registry, "s0", { ...shellTab, id: "t0" }, []);
		assert.equal(
			registry.tabs().some((tab) => tab.id === "extra"),
			false,
		);
	});
});

describe("background-jobs summary", () => {
	it("counts running parents as workflows and running leaves with the tab noun", () => {
		const registry = new BackgroundJobsRegistry();
		publish(registry, "agents", agentTab, [
			{ id: "w1", title: "Chain: scout → worker", status: "running", startedAt: 3 },
			{ id: "w1#0", parentId: "w1", order: 0, title: "scout", status: "done", startedAt: 1 },
			{ id: "w1#1", parentId: "w1", order: 1, title: "worker", status: "running", startedAt: 2 },
			{ id: "w1#2", parentId: "w1", order: 2, title: "reviewer", status: "running", startedAt: 4 },
			{ id: "solo", title: "solo", status: "running", startedAt: 5 },
		]);
		publish(registry, "bash", shellTab, [
			{ id: "1", title: "npm run dev", status: "running" },
			{ id: "2", title: "make", status: "done" },
		]);
		assert.equal(backgroundJobsSummary(registry.tabs()), "↓ 1 workflow · 3 subagents · 1 shell");
	});

	it("is undefined when nothing runs and pluralizes", () => {
		const registry = new BackgroundJobsRegistry();
		assert.equal(backgroundJobsSummary(registry.tabs()), undefined);
		publish(registry, "agents", agentTab, [
			{ id: "a", title: "a", status: "running" },
			{ id: "b", title: "b", status: "running" },
			{ id: "c", title: "c", status: "failed" },
			{ id: "w", title: "w", status: "running" },
			{ id: "w#0", parentId: "w", order: 0, title: "child", status: "running" },
		]);
		assert.equal(backgroundJobsSummary(registry.tabs()), "↓ 1 workflow · 3 subagents");
	});
});
