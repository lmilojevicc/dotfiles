import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { asyncRunsDir, PiSubagentsBridge } from "../bridges/subagents.ts";
import {
	PiInteractiveShellBridge,
	PI_INTERACTIVE_SHELL_SOURCE,
} from "../bridges/interactive-shell.ts";
import {
	backgroundJobsActionReply,
	backgroundJobsMessage,
	BACKGROUND_JOBS_ACTION_EVENT,
	BACKGROUND_JOBS_ACTION_REPLY_EVENT,
	BACKGROUND_JOBS_SNAPSHOT_EVENT,
	type BackgroundJobsSnapshot,
} from "../protocol.ts";

type Bus = {
	on(channel: string, handler: (data: unknown) => void): () => void;
	emit(channel: string, data: unknown): void;
	requests: Array<{ method: string; params: Record<string, unknown> }>;
	snapshots: BackgroundJobsSnapshot[];
	removals: string[];
};

function bus(): Bus {
	const handlers = new Map<string, Set<(data: unknown) => void>>();
	const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
	const snapshots: BackgroundJobsSnapshot[] = [];
	const removals: string[] = [];
	const events = {
		requests,
		snapshots,
		removals,
		on(channel: string, handler: (data: unknown) => void) {
			const set = handlers.get(channel) ?? new Set();
			set.add(handler);
			handlers.set(channel, set);
			return () => set.delete(handler);
		},
		emit(channel: string, data: unknown) {
			for (const handler of handlers.get(channel) ?? []) handler(data);
			if (channel !== BACKGROUND_JOBS_SNAPSHOT_EVENT) return;
			const message = backgroundJobsMessage(data);
			if (!message)
				throw new Error(
					`bridge published a snapshot that fails validation: ${JSON.stringify(data)}`,
				);
			if ("remove" in message) removals.push(message.source);
			else snapshots.push(message);
		},
	};
	return events;
}

/** pi-subagents' RPC, answering `status` with the given runs and recording `stop`. */
function fakeSubagents(
	events: Bus,
	runs: () => unknown[],
	options: { failChildStop?: string } = {},
): void {
	events.on("subagents:rpc:v1:request", (raw) => {
		const request = raw as { method: string; params: Record<string, unknown>; requestId: string };
		events.requests.push(request);
		if (request.method === "status") {
			events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
				success: true,
				data: { asyncSnapshot: { runs: runs() } },
			});
			return;
		}
		const stopParams = request.params as { childId?: string };
		if (request.method === "stop" && stopParams.childId === options.failChildStop) {
			events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
				success: false,
				error: { message: `Child '${stopParams.childId}' was not found.` },
			});
			return;
		}
		events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
			success: true,
			data: { state: "stopping" },
		});
	});
}

const settle = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

const subagentBridge = (events: Bus, runsDir: string, timeoutMs = 100) =>
	new PiSubagentsBridge(events, { runsDir, timeoutMs, pollMs: 50 });

const writeRun = (runsDir: string, id: string, status: Record<string, unknown>) => {
	mkdirSync(join(runsDir, id));
	writeFileSync(join(runsDir, id, "status.json"), JSON.stringify(status));
};

describe("pi-subagents bridge", () => {
	it("resolves the runs directory from pi-subagents' own environment variables", () => {
		assert.equal(
			asyncRunsDir({ PI_SUBAGENTS_TEMP_ROOT: "/tmp/root", USER: "u" }),
			"/tmp/root/async-subagent-runs",
		);
		assert.ok(asyncRunsDir({ USER: "u" }).includes("async-subagent-runs"));
	});

	it("publishes protocol-valid snapshots with the workflow tree from the status RPC", async () => {
		const runsDir = mkdtempSync(join(tmpdir(), "runs-"));
		writeRun(runsDir, "run-1", {
			steps: [{ agent: "researcher", sessionName: "researcher: web exploration about cats" }],
		});
		writeRun(runsDir, "run-2", {
			steps: [
				{
					agent: "scout",
					sessionName: "scout: map the repo",
					status: "completed",
					startedAt: 10,
					endedAt: 41_010,
				},
				{ agent: "worker", sessionName: "worker: fix it", status: "running", startedAt: 42_000 },
			],
		});
		const events = bus();
		fakeSubagents(events, () => [
			{ id: "run-1", label: "researcher", state: "running", startedAt: 1 },
			{ id: "run-2", label: "scout → worker", state: "running", startedAt: 2 },
		]);
		const bridge = subagentBridge(events, runsDir);
		bridge.setActive(true);
		await settle();
		try {
			assert.equal(events.snapshots.length, 1);
			const snapshot = events.snapshots[0];
			assert.equal(snapshot.source, "pi-subagents");
			assert.deepEqual(snapshot.tab, {
				id: "subagents",
				label: "Subagents",
				noun: ["subagent", "subagents"],
				order: 10,
			});
			assert.deepEqual(
				snapshot.jobs.map((job) => [job.id, job.title, job.status, job.parentId, job.order]),
				[
					["run-1", "researcher: web exploration about cats", "running", undefined, undefined],
					["run-2", "Workflow: scout → worker", "running", undefined, undefined],
					["run-2#0", "scout: map the repo", "done", "run-2", 0],
					["run-2#1", "worker: fix it", "running", "run-2", 1],
				],
			);
			assert.equal(snapshot.jobs[1].badge, "Running · 1/2");
			assert.deepEqual(snapshot.jobs[2].actions, { stop: "stop", output: true });
			await bridge.poll();
			assert.equal(events.snapshots.length, 1);
		} finally {
			bridge.setActive(false);
		}
	});

	it("labels chains, parallels and workflows, and folds a nested run under its parent", async () => {
		const runsDir = mkdtempSync(join(tmpdir(), "runs-"));
		writeRun(runsDir, "chain-1", {
			mode: "chain",
			steps: [
				{
					agent: "scout",
					sessionName: "scout: map the auth code",
					workflowKey: "map",
					status: "completed",
					startedAt: 10,
					endedAt: 41_010,
				},
				{
					agent: "worker",
					sessionName: "worker: apply the fixes",
					workflowKey: "fix",
					status: "running",
					startedAt: 42_000,
				},
			],
		});
		writeRun(runsDir, "par-1", {
			mode: "parallel",
			steps: ["scout", "reviewer", "worker", "oracle"].map((agent, index) => ({
				agent,
				sessionName: `${agent}: lane ${index}`,
				workflowKey: `lane-${index}`,
				status: "pending",
			})),
		});
		writeRun(runsDir, "wf-1", {
			mode: "workflow",
			workflowName: "review-and-fix",
			steps: [
				{ agent: "reviewer", sessionName: "reviewer: check the diff", status: "running" },
				{ agent: "worker", sessionName: "worker: apply the fixes", status: "pending" },
			],
		});
		writeRun(runsDir, "nested-1", {
			parentWorkflowRunId: "wf-1",
			workflowKey: "orphan",
			steps: [{ agent: "worker", sessionName: "worker: leftover", status: "running" }],
		});
		const events = bus();
		fakeSubagents(events, () => [
			{ id: "chain-1", label: "scout → worker", state: "running", startedAt: 4 },
			{ id: "par-1", label: "scout, reviewer, worker, oracle", state: "running", startedAt: 3 },
			{ id: "wf-1", label: "review-and-fix", state: "running", startedAt: 2 },
			{ id: "nested-1", label: "worker", state: "running", startedAt: 5 },
		]);
		const bridge = subagentBridge(events, runsDir);
		bridge.setActive(true);
		await settle();
		try {
			const jobs = events.snapshots[0].jobs;
			assert.deepEqual(
				jobs.map((job) => [job.id, job.title, job.parentId]),
				[
					["chain-1", "Chain: scout → worker", undefined],
					["chain-1#0", "scout: map the auth code", "chain-1"],
					["chain-1#1", "worker: apply the fixes", "chain-1"],
					["par-1", "Parallel: scout, reviewer, worker +1", undefined],
					["par-1#0", "scout: lane 0", "par-1"],
					["par-1#1", "reviewer: lane 1", "par-1"],
					["par-1#2", "worker: lane 2", "par-1"],
					["par-1#3", "oracle: lane 3", "par-1"],
					["wf-1", "Workflow: review-and-fix", undefined],
					["wf-1#0", "reviewer: check the diff", "wf-1"],
					["wf-1#1", "worker: apply the fixes", "wf-1"],
					["nested-1", "worker: leftover", "wf-1"],
				],
			);
			assert.equal(events.snapshots[0].jobs[0].badge, "Running · 1/2");
		} finally {
			bridge.setActive(false);
		}
	});

	it("answers output with a parent overview, a step transcript, or the step log", async () => {
		const runsDir = mkdtempSync(join(tmpdir(), "runs-"));
		const sessionFile = join(runsDir, "session.jsonl");
		writeFileSync(
			sessionFile,
			JSON.stringify({
				type: "message",
				message: { role: "assistant", content: [{ type: "text", text: "**hi**" }] },
			}),
		);
		writeRun(runsDir, "run-1", {
			steps: [
				{
					agent: "scout",
					sessionName: "scout: map",
					status: "completed",
					startedAt: 10,
					endedAt: 41_010,
				},
				{ agent: "worker", sessionName: "worker: fix", status: "running", sessionFile },
			],
		});
		writeRun(runsDir, "run-2", {
			steps: [{ agent: "researcher", sessionName: "researcher: cats" }],
		});
		writeFileSync(join(runsDir, "run-2", "output-0.log"), "thinking…\nfound 3 cats\n");
		const events = bus();
		fakeSubagents(events, () => [
			{ id: "run-1", label: "scout → worker", state: "running", startedAt: 2 },
			{ id: "run-2", label: "researcher", state: "running", startedAt: 1 },
		]);
		const bridge = subagentBridge(events, runsDir);
		bridge.setActive(true);
		await settle();
		try {
			const overview = await action(events, "run-1");
			assert.equal(overview?.ok, true);
			assert.deepEqual(overview?.output, {
				heading: "Workflow: scout → worker",
				text: "- **scout**: scout: map · Done · 41s\n- **worker**: worker: fix · Running",
				format: "markdown",
			});
			const transcript = await action(events, "run-1#1");
			assert.deepEqual(transcript?.output, {
				heading: "worker: fix",
				text: "**hi**",
				format: "markdown",
			});
			const log = await action(events, "run-2");
			assert.deepEqual(log?.output, {
				heading: "researcher: cats",
				text: "thinking…\nfound 3 cats\n",
			});
			const missing = await action(events, "no-such-run");
			assert.equal(missing?.ok, false);
			assert.equal(missing?.error, "no subagent run no-such-run");
			const open = await action(events, "run-1", "open");
			assert.equal(open?.ok, false);
			assert.equal(open?.error, "a subagent run has no open action");
		} finally {
			bridge.setActive(false);
		}
	});

	it("stops a step through its child id and falls back to the whole run", async () => {
		const runsDir = mkdtempSync(join(tmpdir(), "runs-"));
		writeRun(runsDir, "run-1", {
			steps: [
				{ agent: "scout", sessionName: "scout: map", workflowKey: "map", status: "running" },
				{ agent: "worker", sessionName: "worker: fix", workflowKey: "gone", status: "running" },
			],
		});
		const events = bus();
		fakeSubagents(events, () => [{ id: "run-1", label: "scout → worker", state: "running" }], {
			failChildStop: "gone",
		});
		const bridge = subagentBridge(events, runsDir);
		bridge.setActive(true);
		await settle();
		try {
			const childStop = await action(events, "run-1#1", "stop");
			assert.equal(childStop?.ok, true);
			assert.deepEqual(
				events.requests
					.filter((request) => request.method === "stop")
					.map((request) => request.params),
				[{ id: "run-1", childId: "gone" }, { id: "run-1" }],
			);
			const runStop = await action(events, "run-1", "stop");
			assert.equal(runStop?.ok, true);
			assert.deepEqual(events.requests.filter((r) => r.method === "stop").at(-1)?.params, {
				id: "run-1",
			});
		} finally {
			bridge.setActive(false);
		}
	});

	it("publishes nothing without pi-subagents, and nothing while disabled", async () => {
		const events = bus();
		const bridge = subagentBridge(events, tmpdir(), 20);
		bridge.setActive(true);
		await settle(60);
		try {
			assert.equal(events.snapshots.length, 0);
			assert.equal(events.removals.length, 0);
		} finally {
			bridge.setActive(false);
		}
		// A bridge whose panel is not active never polls: a fresh one stays silent even with runs.
		const runsDir = mkdtempSync(join(tmpdir(), "runs-"));
		writeRun(runsDir, "run-1", { steps: [{ agent: "scout", sessionName: "scout: map" }] });
		const quiet = bus();
		fakeSubagents(quiet, () => [{ id: "run-1", label: "scout", state: "running" }]);
		const idle = subagentBridge(quiet, runsDir);
		await idle.poll();
		assert.equal(quiet.snapshots.length, 0);
	});

	it("withdraws its tab when the runs end or the bridge turns off", async () => {
		const runsDir = mkdtempSync(join(tmpdir(), "runs-"));
		writeRun(runsDir, "run-1", { steps: [{ agent: "scout", sessionName: "scout: map" }] });
		const events = bus();
		let runs: unknown[] = [{ id: "run-1", label: "scout", state: "running" }];
		fakeSubagents(events, () => runs);
		const bridge = subagentBridge(events, runsDir);
		bridge.setActive(true);
		await settle();
		try {
			assert.equal(events.snapshots.length, 1);
			runs = [];
			await bridge.poll();
			// An empty list withdraws the source, not an empty tab.
			assert.deepEqual(events.removals, ["pi-subagents"]);
		} finally {
			bridge.setActive(false);
		}
		// Turning the bridge off withdraws a published tab immediately.
		const events2 = bus();
		fakeSubagents(events2, () => [{ id: "run-1", label: "scout", state: "running" }]);
		const bridge2 = subagentBridge(events2, runsDir);
		bridge2.setActive(true);
		await settle();
		bridge2.setActive(false);
		assert.deepEqual(events2.removals, ["pi-subagents"]);
	});
});

const MANAGER_KEY = "__piInteractiveShellSessionManagerV1";

interface FakeManager {
	list(): unknown[];
	onChange(listener: () => void): () => void;
	listeners: Set<() => void>;
}

function fakeManager(sessions: unknown[]): FakeManager {
	const listeners = new Set<() => void>();
	const manager = {
		listeners,
		list: () => sessions,
		onChange: (listener: () => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	(globalThis as Record<string, unknown>)[MANAGER_KEY] = manager;
	return manager;
}

function clearManager(): void {
	delete (globalThis as Record<string, unknown>)[MANAGER_KEY];
}

describe("pi-interactive-shell bridge", () => {
	it("publishes the manager's sessions and answers kill, attach and output", async () => {
		const killed: string[] = [];
		const attached: string[] = [];
		const session = (id: string, command: string, exited: boolean, exitCode?: number) => ({
			id,
			command,
			startedAt: new Date(1000),
			session: {
				exited,
				exitCode,
				kill: () => killed.push(id),
				getTailLines: () => ({ lines: [`${command} output`] }),
			},
		});
		const sessions: unknown[] = [session("calm-reef", "watch -n 2 date", false)];
		const manager = fakeManager(sessions);
		const events = bus();
		const bridge = new PiInteractiveShellBridge(events, {
			pollMs: 50,
			attach: (id) => {
				attached.push(id);
			},
		});
		bridge.setActive(true);
		try {
			assert.equal(events.snapshots.length, 1);
			const snapshot = events.snapshots[0];
			assert.equal(snapshot.source, PI_INTERACTIVE_SHELL_SOURCE);
			assert.deepEqual(snapshot.tab, {
				id: "terminals",
				label: "Terminals",
				noun: ["terminal", "terminals"],
				order: 30,
			});
			assert.deepEqual(
				snapshot.jobs.map((job) => [job.id, job.title, job.status, job.actions]),
				[
					[
						"calm-reef",
						"watch -n 2 date",
						"running",
						{ stop: "kill", open: "attach", output: true },
					],
				],
			);
			sessions.push(session("keen-dune", "make", true, 2));
			for (const listener of manager.listeners) listener();
			assert.equal(events.snapshots.length, 2);
			const second = events.snapshots[1].jobs[1];
			assert.equal(second?.id, "keen-dune");
			assert.equal(second?.status, "failed");

			const output = await action(events, "calm-reef", "output", "pi-interactive-shell");
			assert.equal(output?.ok, true);
			assert.match(output?.output?.heading ?? "", /^watch -n 2 date  \(read-only/);
			assert.equal(output?.output?.text, "watch -n 2 date output");

			const stop = await action(events, "calm-reef", "stop", "pi-interactive-shell");
			assert.equal(stop?.ok, true);
			assert.deepEqual(killed, ["calm-reef"]);

			const open = await action(events, "keen-dune", "open", "pi-interactive-shell");
			assert.equal(open?.ok, true);
			assert.deepEqual(attached, ["keen-dune"]);

			const missing = await action(events, "no-such", "stop", "pi-interactive-shell");
			assert.equal(missing?.ok, false);
			assert.equal(missing?.error, "no terminal no-such");
		} finally {
			bridge.setActive(false);
			clearManager();
		}
		assert.equal(manager.listeners.size, 0);
	});

	it("replies with the attach error when attaching fails", async () => {
		const sessions = [
			{
				id: "calm-reef",
				command: "htop",
				startedAt: new Date(1000),
				session: { exited: false, kill: () => {}, getTailLines: () => ({ lines: [] }) },
			},
		];
		fakeManager(sessions);
		const events = bus();
		const bridge = new PiInteractiveShellBridge(events, {
			pollMs: 50,
			attach: () => {
				throw new Error("no active session");
			},
		});
		bridge.setActive(true);
		try {
			const open = await action(events, "calm-reef", "open", "pi-interactive-shell");
			assert.equal(open?.ok, false);
			assert.equal(open?.error, "no active session");
		} finally {
			bridge.setActive(false);
			clearManager();
		}
	});

	it("publishes nothing without pi-interactive-shell, and ignores other sources' actions", async () => {
		const events = bus();
		const bridge = new PiInteractiveShellBridge(events, { pollMs: 50 });
		bridge.setActive(true);
		try {
			assert.equal(events.snapshots.length, 0);
			const foreign = await action(events, "calm-reef", "stop", "another-source");
			assert.equal(foreign, undefined);
		} finally {
			bridge.setActive(false);
		}
	});
});

/** Sends one action request on the bus and resolves the bridge's reply, if it answers. */
function action(
	events: Bus,
	jobId: string,
	kind: "stop" | "open" | "output" = "output",
	source = "pi-subagents",
	timeoutMs = 500,
) {
	const requestId = `test-${actionCount++}`;
	const reply = new Promise<ReturnType<typeof backgroundJobsActionReply> | undefined>((resolve) => {
		const off = events.on(BACKGROUND_JOBS_ACTION_REPLY_EVENT, (raw) => {
			const parsed = backgroundJobsActionReply(raw);
			if (parsed?.requestId !== requestId) return;
			off();
			resolve(parsed);
		});
		setTimeout(() => {
			off();
			resolve(undefined);
		}, timeoutMs).unref?.();
	});
	events.emit(BACKGROUND_JOBS_ACTION_EVENT, {
		version: 1,
		requestId,
		source,
		jobId,
		action: kind,
	});
	return reply;
}

let actionCount = 0;

describe("publisher bounds", () => {
	it("clamps titles and output to the protocol's bounds", async () => {
		const runsDir = mkdtempSync(join(tmpdir(), "runs-"));
		const long = "x".repeat(600);
		const sessionFile = join(runsDir, "session.jsonl");
		writeFileSync(
			sessionFile,
			JSON.stringify({
				type: "message",
				message: { role: "assistant", content: [{ type: "text", text: "y".repeat(300 * 1024) }] },
			}),
		);
		writeRun(runsDir, "run-1", { steps: [{ agent: "scout", sessionName: long, sessionFile }] });
		const events = bus();
		fakeSubagents(events, () => [{ id: "run-1", label: "scout", state: "running" }]);
		const bridge = subagentBridge(events, runsDir);
		bridge.setActive(true);
		await settle();
		try {
			const title = events.snapshots[0].jobs[0].title;
			assert.equal(title.length, 512);
			assert.equal(title.endsWith("…"), true);
			const reply = await action(events, "run-1");
			assert.equal(reply?.ok, true);
			assert.ok((reply?.output?.text ?? "").length <= 256 * 1024);
			assert.equal(reply?.output?.text.endsWith("*… truncated*"), true);
		} finally {
			bridge.setActive(false);
		}
	});

	it("ignores action requests for another version or a malformed source", async () => {
		const sessions = [
			{
				id: "calm-reef",
				command: "htop",
				startedAt: new Date(1000),
				session: { exited: false, kill: () => {}, getTailLines: () => ({ lines: [] }) },
			},
		];
		fakeManager(sessions);
		const events = bus();
		const bridge = new PiInteractiveShellBridge(events, { pollMs: 50 });
		bridge.setActive(true);
		try {
			const seen: string[] = [];
			events.on(BACKGROUND_JOBS_ACTION_REPLY_EVENT, () => seen.push("reply"));
			events.emit(BACKGROUND_JOBS_ACTION_EVENT, {
				version: 2,
				requestId: "other",
				source: PI_INTERACTIVE_SHELL_SOURCE,
				jobId: "calm-reef",
				action: "stop",
			});
			events.emit(BACKGROUND_JOBS_ACTION_EVENT, { version: 1, requestId: "other" });
			assert.equal(seen.length, 0);
		} finally {
			bridge.setActive(false);
			clearManager();
		}
	});
});
