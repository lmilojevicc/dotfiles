import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Panel, type PanelResult, type PanelState } from "../panel.ts";
import type { BackgroundJob } from "../protocol.ts";
import { BackgroundJobsRegistry, type TabJob } from "../registry.ts";

const KEY = {
	up: "\x1b[A",
	down: "\x1b[B",
	right: "\x1b[C",
	left: "\x1b[D",
	enter: "\r",
	escape: "\x1b",
	ctrlA: "\x01",
	ctrlD: "\x04",
	ctrlO: "\x0f",
};

/** Plain text: every style is dropped, so rows can be matched as text. */
const plain = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

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

/** A bordered panel line without its `│` sides. */
const unbox = (line: string) => line.replace(/^│ /, "").replace(/ │$/, "").trimEnd();

function open(registry: BackgroundJobsRegistry, state: PanelState = { showInactive: false }) {
	const results: PanelResult[] = [];
	const stopped: TabJob[] = [];
	const panel = new Panel(
		registry,
		() => ({}),
		plain,
		state,
		{
			stop: (job) => {
				stopped.push(job);
				return Promise.resolve({ ok: true });
			},
		},
		(result) => results.push(result),
	);
	const text = () => panel.render(80).map(unbox);
	return { panel, results, stopped, text, state };
}

describe("background panel", () => {
	it("opens on the first tab with running work and moves like OpenCode's composer", () => {
		const registry = new BackgroundJobsRegistry();
		publish(registry, "agents", agentTab, [{ id: "a", title: "scout: old", status: "done" }]);
		publish(registry, "bash", shellTab, [
			{ id: "1", title: "npm run dev", status: "running", startedAt: 2, actions: { output: true } },
			{ id: "2", title: "cargo watch", status: "running", startedAt: 1, actions: { output: true } },
		]);
		const { panel, results, text } = open(registry);
		const lines = text();
		assert.match(lines[0], /^╭─+╮$/);
		assert.match(lines[1], /Subagents {2}Shell +esc$/);
		assert.match(lines[2], /^├─+┤$/);
		assert.match(lines[3], /npm run dev +Running$/);
		assert.match(lines[4], /cargo watch +Running$/);
		assert.match(lines.at(-2) ?? "", /output enter {2}show finished ctrl\+a {2}tabs ←\/→$/);

		panel.handleInput(KEY.down);
		panel.handleInput(KEY.enter);
		assert.equal(results[0]?.kind, "output");
		assert.ok(results[0]?.kind === "output" && results[0].job.title === "cargo watch");

		panel.handleInput(KEY.down); // wraps to the first row
		panel.handleInput(KEY.up); // ↑ on the first row closes
		assert.deepEqual(results.at(-1), { kind: "close" });
	});

	it("←/→ switch tabs, Ctrl+A shows finished jobs, and an empty tab says so", () => {
		const registry = new BackgroundJobsRegistry();
		publish(registry, "agents", agentTab, [
			{ id: "a", title: "scout: old", status: "done", startedAt: 0, endedAt: 65_000 },
		]);
		publish(registry, "bash", shellTab, [{ id: "1", title: "npm run dev", status: "running" }]);
		const { panel, text, state } = open(registry);
		assert.equal(state.tabId, "shell");
		panel.handleInput(KEY.left);
		assert.equal(state.tabId, "subagents");
		assert.match(text()[3], /No running subagents$/);
		panel.handleInput(KEY.ctrlA);
		assert.match(text()[3], /scout: old +Done · 1m 5s$/);
		assert.match(text().at(-2) ?? "", /show running ctrl\+a/);
		panel.handleInput(KEY.right);
		assert.equal(state.tabId, "shell");
	});

	it("renders a failing job in the error color and pads short lists to five rows", () => {
		const registry = new BackgroundJobsRegistry();
		publish(registry, "bash", shellTab, [
			{ id: "1", title: "exploded", status: "failed", startedAt: 0, endedAt: 1000 },
		]);
		const { text } = open(registry, { showInactive: true });
		const lines = text();
		assert.match(lines[3], /exploded +Failed · 1s$/);
		assert.equal(
			lines.slice(4, 7).every((line) => /^ *$/.test(line)),
			true,
		);
	});

	it("truncates long titles and keeps the row width", () => {
		const registry = new BackgroundJobsRegistry();
		publish(registry, "bash", shellTab, [
			{ id: "1", title: `x`.repeat(120), status: "running", actions: { output: true } },
		]);
		const { text } = open(registry);
		const row = text()[3];
		assert.ok(row.includes("…"));
		assert.ok(visibleWidth(row) <= 80);
	});

	it("sends the stop action for the selected running job and shows the notice until it settles", async () => {
		const registry = new BackgroundJobsRegistry();
		publish(registry, "bash", shellTab, [
			{ id: "7", title: "sleep 100", status: "running", actions: { stop: "kill" } },
		]);
		let settle: (value: { ok: boolean; error?: string }) => void = () => {};
		const results: TabJob[] = [];
		const panel = new Panel(
			registry,
			() => ({}),
			plain,
			{ showInactive: false },
			{
				stop: (job) => {
					results.push(job);
					return new Promise((resolve) => {
						settle = resolve;
					});
				},
			},
			() => {},
		);
		panel.handleInput(KEY.ctrlD);
		assert.deepEqual(
			results.map((job) => [job.source, job.id]),
			[["bash", "7"]],
		);
		assert.match(panel.render(80).map(unbox).at(-2) ?? "", /Killing sleep 100…$/);
		settle({ ok: false, error: "no such process" });
		await Promise.resolve();
		assert.match(panel.render(80).map(unbox).at(-2) ?? "", /Could not kill: no such process$/);
	});

	it("offers no stop hint for finished jobs or jobs without the stop action", () => {
		const registry = new BackgroundJobsRegistry();
		publish(registry, "bash", shellTab, [
			{ id: "1", title: "done", status: "done", actions: { stop: "kill" } },
			{ id: "2", title: "running", status: "running" },
		]);
		const { panel, text } = open(registry);
		assert.equal(text().at(-2)?.includes("kill"), false);
		panel.handleInput(KEY.down);
		assert.equal(text().at(-2)?.includes("kill"), false);
	});

	it("jobs with a parentId form tree rows and selection moves across them", () => {
		const registry = new BackgroundJobsRegistry();
		publish(registry, "agents", agentTab, [
			{
				id: "w1",
				title: "Chain: scout → worker",
				status: "running",
				badge: "Running · 1/2",
				startedAt: 2,
				actions: { output: true },
			},
			{
				id: "w1#0",
				parentId: "w1",
				order: 0,
				title: "scout: map the auth code",
				status: "done",
				startedAt: 1,
				endedAt: 42_000,
				actions: { output: true },
			},
			{
				id: "w1#1",
				parentId: "w1",
				order: 1,
				title: "worker: apply the fixes",
				status: "running",
				actions: { output: true },
			},
		]);
		const { panel, results, text, state } = open(registry);
		const lines = text();
		assert.match(lines[3], /Chain: scout → worker +Running · 1\/2$/);
		assert.match(lines[4], /^├─ scout: map the auth code +Done · 42s$/);
		assert.match(lines[5], /^└─ worker: apply the fixes +Running$/);

		panel.handleInput(KEY.down); // the first child
		panel.handleInput(KEY.enter);
		assert.ok(results[0]?.kind === "output" && results[0].job.title === "scout: map the auth code");
		panel.handleInput(KEY.down); // the last child
		panel.handleInput(KEY.down); // wraps back onto the header
		panel.handleInput(KEY.enter);
		assert.ok(results[1]?.kind === "output" && results[1].job.title === "Chain: scout → worker");

		// The filter applies to top-level jobs; children follow their parent either way.
		panel.handleInput(KEY.ctrlA);
		assert.match(text()[3], /No finished subagents$/);
		state.showInactive = false;
		panel.handleInput(KEY.up); // on the first row again, closes
		assert.deepEqual(results.at(-1), { kind: "close" });
	});

	it("keeps the selection on its job when the list changes under it", () => {
		const jobs: BackgroundJob[] = [
			{ id: "1", title: "first", status: "running", startedAt: 2, actions: { output: true } },
			{ id: "2", title: "second", status: "running", startedAt: 1, actions: { output: true } },
		];
		const registry = new BackgroundJobsRegistry();
		publish(registry, "bash", shellTab, jobs);
		const { panel, results } = open(registry);
		panel.handleInput(KEY.down); // "second"
		jobs.unshift({
			id: "3",
			title: "newest",
			status: "running",
			startedAt: 3,
			actions: { output: true },
		});
		publish(registry, "bash", shellTab, jobs);
		panel.handleInput(KEY.enter);
		assert.ok(results[0]?.kind === "output" && results[0].job.title === "second");
	});

	it("a job with an open action takes Enter; its output moves to Ctrl+O", () => {
		const registry = new BackgroundJobsRegistry();
		publish(
			registry,
			"bash",
			{
				id: "terminals",
				label: "Terminals",
				noun: ["terminal", "terminals"] as [string, string],
				order: 30,
			},
			[
				{
					id: "calm-reef",
					title: "sudo make install",
					status: "running",
					actions: { open: "attach", output: true },
				},
			],
		);
		const { panel, results, text } = open(registry);
		assert.match(text().at(-2) ?? "", /attach enter {2}output ctrl\+o/);
		panel.handleInput(KEY.ctrlO);
		assert.equal(results[0]?.kind, "output");
		panel.handleInput(KEY.enter);
		assert.equal(results[1]?.kind, "open");
		assert.ok(results[1]?.kind === "open" && results[1].job.id === "calm-reef");
	});

	it("renders a single tab without a tabs row and a single tab without tab switching", () => {
		const registry = new BackgroundJobsRegistry();
		publish(registry, "bash", shellTab, [{ id: "1", title: "only", status: "running" }]);
		const { panel, text, state } = open(registry);
		assert.match(text()[1], /^Shell +esc$/);
		assert.equal(text().at(-2)?.includes("tabs"), false);
		panel.handleInput(KEY.right);
		assert.equal(state.tabId, "shell");
	});

	it("opens the first tab with running work", () => {
		const registry = new BackgroundJobsRegistry();
		publish(registry, "agents", agentTab, [{ id: "a", title: "finished", status: "done" }]);
		publish(registry, "bash", shellTab, [{ id: "1", title: "running", status: "running" }]);
		const { state } = open(registry);
		assert.equal(state.tabId, "shell");
		const { state: empty } = open(new BackgroundJobsRegistry());
		assert.equal(empty.tabId, undefined);
	});
});
