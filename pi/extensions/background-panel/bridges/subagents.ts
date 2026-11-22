/**
 * The Subagents tab: a reference provider for pi-subagents' async runs, built as a bridge (config
 * `bridges.piSubagents` in `background-panel.json`). It polls pi-subagents' `status` RPC about once
 * a second while the panel is active, and reads each run's `status.json` under its async-runs
 * directory for titles and steps; the workflow tree (a parent per multi-step run with `├─`/`└─`
 * children) travels as plain `parentId`/`order` fields. `stop` goes back through the RPC (one
 * step's `childId`, falling back to the whole run); `output` shows the step's own Pi session
 * (`sessionFile`) as markdown, its `output-<i>.log` as plain text, and a parent's markdown
 * overview. Depends on pi-subagents internals (the RPC channel and its runs layout); those can
 * change.
 */
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { EventBus } from "@earendil-works/pi-coding-agent";
import type {
	BackgroundJob,
	BackgroundJobOutput,
	BackgroundJobStatus,
	BackgroundJobsTab,
} from "../protocol.ts";
import { transcriptMarkdown } from "../transcript.ts";
import { boundedOutput, boundedText, BridgePublisher, BRIDGE_POLL_MS } from "./common.ts";

const REQUEST_EVENT = "subagents:rpc:v1:request";
const REPLY_PREFIX = "subagents:rpc:v1:reply:";
const RPC_TIMEOUT_MS = 3000;
const OUTPUT_BYTES = 64 * 1024;

export const PI_SUBAGENTS_SOURCE = "pi-subagents";
export const PI_SUBAGENTS_TAB: BackgroundJobsTab = {
	id: "subagents",
	label: "Subagents",
	noun: ["subagent", "subagents"],
	order: 10,
};

/** Where pi-subagents keeps async runs (its `ASYNC_DIR`). */
export function asyncRunsDir(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env.PI_SUBAGENTS_TEMP_ROOT?.trim();
	const scope =
		typeof process.getuid === "function"
			? `uid-${process.getuid()}`
			: `user-${env.USER ?? "shared"}`;
	return join(
		configured ? resolve(configured) : join(tmpdir(), `pi-subagents-${scope}`),
		"async-subagent-runs",
	);
}

interface SnapshotNode {
	id: string;
	label: string;
	state: string;
	startedAt?: number;
	endedAt?: number;
}

interface StatusStep {
	agent?: string;
	sessionName?: string;
	label?: string;
	status?: string;
	startedAt?: number;
	endedAt?: number;
	durationMs?: number;
	/** pi-subagents' identity for `stop` with a `childId`. */
	childId?: string;
	workflowKey?: string;
	runId?: string;
	recentOutput?: string[];
	/** The child's Pi session, written as it runs. */
	sessionFile?: string;
}

/** A run's `status.json`, the fields the bridge reads. */
interface RunStatusFile {
	mode?: string;
	/** The run this one is a child of (a workflow step that became its own run). */
	parentWorkflowRunId?: string;
	workflowKey?: string;
	/** A workflow's own name, when pi-subagents carries one. */
	workflowName?: string;
	name?: string;
	steps: StatusStep[];
}

function jobStatus(state: string | undefined): { status: BackgroundJobStatus; badge?: string } {
	switch (state) {
		case "running":
			return { status: "running" };
		case "queued":
		case "pending":
			return { status: "running", badge: "Queued" };
		case "paused":
			return { status: "running", badge: "Paused" };
		case "complete":
		case "completed":
			return { status: "done" };
		case "stopped":
		case "interrupted":
			return { status: "stopped" };
		default:
			return { status: "failed" };
	}
}

/** The row text for a job status, such as `Done` or `Queued`. */
function statusText(status: BackgroundJobStatus, badge?: string): string {
	return (
		badge ??
		({ running: "Running", done: "Done", failed: "Failed", stopped: "Stopped" } as const)[status]
	);
}

/** A step's duration if it is known from the run's own data. */
function stepDuration(step: StatusStep): number | undefined {
	if (typeof step.durationMs === "number" && step.durationMs >= 0) return step.durationMs;
	if (step.endedAt !== undefined && step.startedAt !== undefined)
		return step.endedAt - step.startedAt;
	return undefined;
}

const formatSeconds = (ms: number): string => {
	const seconds = Math.max(1, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

/** A multi-step run's header: the workflow's own name, or its shape (`Chain: scout → worker`). */
function headerTitle(run: SnapshotNode, status: RunStatusFile): string {
	const agents = [
		...new Set(status.steps.map((step) => step.agent).filter((a): a is string => !!a)),
	];
	if (status.mode === "chain") return `Chain: ${agents.join(" → ")}`;
	if (status.mode === "parallel")
		return `Parallel: ${agents.slice(0, 3).join(", ")}${agents.length > 3 ? ` +${agents.length - 3}` : ""}`;
	const name = [status.workflowName, status.name].find(
		(value): value is string => typeof value === "string" && value.trim().length > 0,
	);
	return `Workflow: ${name ?? run.label}`;
}

/** A running parent's badge, such as `Running · 1/3`: how many steps have finished. */
function parentBadge(state: string | undefined, steps: readonly StatusStep[]): string | undefined {
	const { status, badge } = jobStatus(state);
	if (status !== "running") return undefined;
	const done = steps.filter((step) => jobStatus(step.status).status !== "running").length;
	return `${statusText(status, badge)} · ${done}/${steps.length}`;
}

/** pi-subagents' identity for `stop` with a `childId` (see its `asyncStatusChildIdentity`). */
function stepChildId(step: StatusStep | undefined, index: number): string {
	return step?.childId ?? step?.workflowKey ?? step?.runId ?? `step:${index}`;
}

function readTail(path: string, bytes: number): string | undefined {
	let fd: number | undefined;
	try {
		const size = statSync(path).size;
		const start = Math.max(0, size - bytes);
		const buffer = Buffer.alloc(size - start);
		fd = openSync(path, "r");
		readSync(fd, buffer, 0, buffer.length, start);
		const text = buffer.toString("utf8");
		// Drop the partial first line a cut in the middle leaves.
		return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** Every job the bridge publishes carries the panel's stop and output actions. */
const ACTIONS = { stop: "stop", output: true } as const;

export interface PiSubagentsBridgeOptions {
	/** Overrides the runs directory (tests inject a temporary one). */
	runsDir?: string;
	/** Overrides the RPC timeout. */
	timeoutMs?: number;
	/** Overrides the poll interval. */
	pollMs?: number;
}

/**
 * Publishes pi-subagents' async runs while the panel is active; without pi-subagents loaded (its RPC
 * never answers) it publishes nothing, so no empty tab appears.
 */
export class PiSubagentsBridge {
	private readonly events: EventBus | undefined;
	private readonly publisher: BridgePublisher;
	private readonly runsDir: string;
	private readonly timeoutMs: number;
	private readonly pollMs: number;
	private runs: SnapshotNode[] = [];
	private answered = false;
	private inFlight = false;
	private active = false;
	private next = 0;
	private timer: ReturnType<typeof setInterval> | undefined;
	/** Each run's `status.json` by run id, reread when its mtime changes. */
	private readonly statusCache = new Map<string, { mtimeMs: number; status: RunStatusFile }>();
	/** A session file as markdown, rebuilt only when the file changes. */
	private readonly transcripts = new Map<
		string,
		{ mtimeMs: number; size: number; markdown: string }
	>();

	constructor(events: EventBus | undefined, options: PiSubagentsBridgeOptions = {}) {
		this.events = events;
		this.runsDir = options.runsDir ?? asyncRunsDir();
		this.timeoutMs = options.timeoutMs ?? RPC_TIMEOUT_MS;
		this.pollMs = options.pollMs ?? BRIDGE_POLL_MS;
		this.publisher = new BridgePublisher(events, PI_SUBAGENTS_SOURCE, PI_SUBAGENTS_TAB);
		this.publisher.onAction((request) => void this.handleAction(request));
	}

	/** Whether the panel wants this bridge's tab; the extension wiring drives this from its config. */
	setActive(active: boolean): void {
		if (active === this.active) return;
		this.active = active;
		if (active) {
			void this.poll();
			this.timer = setInterval(() => void this.poll(), this.pollMs);
			this.timer.unref?.();
		} else {
			if (this.timer !== undefined) clearInterval(this.timer);
			this.timer = undefined;
			this.publisher.remove();
		}
	}

	/** Rereads the runs; public for the immediate refresh after a stop and for tests. */
	async poll(): Promise<void> {
		if (this.inFlight || !this.active) return;
		this.inFlight = true;
		try {
			const data = (await this.rpc("status")) as { asyncSnapshot?: { runs?: SnapshotNode[] } };
			this.answered = true;
			this.runs = Array.isArray(data?.asyncSnapshot?.runs) ? data.asyncSnapshot.runs : [];
		} catch {
			// pi-subagents is not loaded, or not answering yet: keep the last list.
		} finally {
			this.inFlight = false;
		}
		this.publish();
	}

	private rpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
		const events = this.events;
		if (!events) return Promise.reject(new Error("no event bus"));
		const requestId = `background-jobs-${process.pid}-${++this.next}`;
		return new Promise((resolvePromise, reject) => {
			const timer = setTimeout(() => {
				off();
				reject(new Error(`pi-subagents did not answer ${method}`));
			}, this.timeoutMs);
			timer.unref?.();
			const off = events.on(`${REPLY_PREFIX}${requestId}`, (raw) => {
				clearTimeout(timer);
				off();
				const reply = raw as { success?: boolean; data?: unknown; error?: { message?: string } };
				if (reply?.success) resolvePromise(reply.data);
				else reject(new Error(reply?.error?.message ?? `pi-subagents ${method} failed`));
			});
			events.emit(REQUEST_EVENT, {
				version: 1,
				requestId,
				method,
				params,
				source: { name: PI_SUBAGENTS_SOURCE },
			});
		});
	}

	private runStatus(runId: string): RunStatusFile {
		const path = join(this.runsDir, runId, "status.json");
		try {
			const { mtimeMs } = statSync(path);
			const cached = this.statusCache.get(runId);
			if (cached && cached.mtimeMs === mtimeMs) return cached.status;
			const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RunStatusFile>;
			const status: RunStatusFile = {
				mode: typeof parsed.mode === "string" ? parsed.mode : undefined,
				parentWorkflowRunId:
					typeof parsed.parentWorkflowRunId === "string" ? parsed.parentWorkflowRunId : undefined,
				workflowKey: typeof parsed.workflowKey === "string" ? parsed.workflowKey : undefined,
				workflowName: typeof parsed.workflowName === "string" ? parsed.workflowName : undefined,
				name: typeof parsed.name === "string" ? parsed.name : undefined,
				steps: Array.isArray(parsed.steps) ? parsed.steps : [],
			};
			this.statusCache.set(runId, { mtimeMs, status });
			return status;
		} catch {
			return this.statusCache.get(runId)?.status ?? { steps: [] };
		}
	}

	private steps(runId: string): StatusStep[] {
		return this.runStatus(runId).steps;
	}

	private readTranscript(path: string): string | undefined {
		try {
			const { mtimeMs, size } = statSync(path);
			const cached = this.transcripts.get(path);
			if (cached?.mtimeMs === mtimeMs && cached.size === size) return cached.markdown;
			const markdown = transcriptMarkdown(readFileSync(path, "utf8"));
			this.transcripts.set(path, { mtimeMs, size, markdown });
			return markdown || undefined;
		} catch {
			return undefined;
		}
	}

	/** One row per step, as children of the run's header row. */
	private stepJobs(run: SnapshotNode, runSteps: readonly StatusStep[]): BackgroundJob[] {
		return runSteps.map((step, index) => {
			const { status, badge } = jobStatus(step.status ?? run.state);
			return {
				id: `${run.id}#${index}`,
				parentId: run.id,
				order: index,
				title: boundedText(
					step.sessionName ?? `${step.agent ?? run.label}: ${step.label ?? `step ${index + 1}`}`,
				),
				status,
				...(badge !== undefined ? { badge } : {}),
				startedAt: step.startedAt ?? run.startedAt,
				...(step.endedAt !== undefined ? { endedAt: step.endedAt } : {}),
				actions: ACTIONS,
			};
		});
	}

	private list(): BackgroundJob[] {
		const jobs: BackgroundJob[] = [];
		const runIds = new Set(this.runs.map((run) => run.id));
		// Runs pi-subagents lists on their own that are children of a listed run: shown under it, not
		// twice.
		const nestedByParent = new Map<string, SnapshotNode[]>();
		const nested = new Set<string>();
		for (const run of this.runs) {
			const parent = this.runStatus(run.id).parentWorkflowRunId;
			if (parent && parent !== run.id && runIds.has(parent)) {
				nested.add(run.id);
				const siblings = nestedByParent.get(parent) ?? [];
				siblings.push(run);
				nestedByParent.set(parent, siblings);
			}
		}
		for (const run of this.runs) {
			if (nested.has(run.id)) continue;
			const runStatusFile = this.runStatus(run.id);
			const runSteps = runStatusFile.steps;
			if (runSteps.length <= 1) {
				const step = runSteps[0];
				const { status, badge } = jobStatus(run.state);
				jobs.push({
					id: run.id,
					title: boundedText(step?.sessionName ?? run.label),
					status,
					...(badge !== undefined ? { badge } : {}),
					startedAt: run.startedAt,
					...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
					actions: ACTIONS,
				});
				continue;
			}
			// A chain, parallel or workflow run: a header row, then one child per step in run order.
			const { status } = jobStatus(run.state);
			const badge = parentBadge(run.state, runSteps);
			jobs.push({
				id: run.id,
				title: boundedText(headerTitle(run, runStatusFile)),
				status,
				...(badge !== undefined ? { badge: boundedText(badge) } : {}),
				startedAt: run.startedAt,
				...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
				actions: ACTIONS,
			});
			jobs.push(...this.stepJobs(run, runSteps));
			// A child run pi-subagents still lists on its own, that no step of ours covers: flattened
			// into this level, its own steps included, so the tab shows at most two levels.
			for (const child of nestedByParent.get(run.id) ?? []) {
				const childStatus = this.runStatus(child.id);
				const covered = runSteps.some(
					(step) =>
						step.runId === child.id ||
						(childStatus.workflowKey !== undefined && step.workflowKey === childStatus.workflowKey),
				);
				if (covered) continue;
				const { status: childJobStatus, badge: childBadge } = jobStatus(child.state);
				jobs.push({
					id: child.id,
					parentId: run.id,
					order: jobs.length,
					title: boundedText(childStatus.steps[0]?.sessionName ?? child.label),
					status: childJobStatus,
					...(childBadge !== undefined ? { badge: childBadge } : {}),
					startedAt: child.startedAt,
					...(child.endedAt !== undefined ? { endedAt: child.endedAt } : {}),
					actions: ACTIONS,
				});
				if (childStatus.steps.length > 1) jobs.push(...this.stepJobs(child, childStatus.steps));
			}
		}
		return jobs;
	}

	private publish(): void {
		if (!this.answered) return;
		this.publisher.publish(this.list());
	}

	private async handleAction(request: {
		requestId: string;
		jobId: string;
		action: "stop" | "open" | "output";
	}): Promise<void> {
		const { requestId, jobId, action } = request;
		if (action === "open") {
			this.publisher.replyError(requestId, "a subagent run has no open action");
			return;
		}
		const { runId, index } = this.split(jobId);
		const run = this.runs.find((candidate) => candidate.id === runId);
		if (!run) {
			this.publisher.replyError(requestId, `no subagent run ${runId}`);
			return;
		}
		if (action === "output") {
			this.publisher.reply(requestId, true, { output: this.output(jobId, run, index) });
			return;
		}
		try {
			if (jobId.includes("#")) {
				// One step: stop the child; if pi-subagents does not know it, stop the whole run.
				try {
					await this.rpc("stop", {
						id: runId,
						childId: stepChildId(this.steps(runId)[index], index),
					});
				} catch {
					await this.rpc("stop", { id: runId });
				}
			} else {
				// The run's own row: stop the whole run.
				await this.rpc("stop", { id: runId });
			}
			this.publisher.reply(requestId, true);
		} catch (error) {
			this.publisher.replyError(
				requestId,
				error instanceof Error ? error.message : "pi-subagents did not stop the run",
			);
		}
		void this.poll();
	}

	private output(jobId: string, run: SnapshotNode, index: number): BackgroundJobOutput {
		const runSteps = this.steps(run.id);
		if (!jobId.includes("#") && runSteps.length > 1) {
			// The run's own row: a markdown overview, one line per step.
			const overview = runSteps
				.map((step, i) => {
					const { status, badge } = jobStatus(step.status ?? run.state);
					const duration = stepDuration(step);
					return `- **${step.agent ?? "agent"}**: ${step.sessionName ?? step.label ?? `step ${i + 1}`} · ${statusText(status, badge)}${duration !== undefined ? ` · ${formatSeconds(duration)}` : ""}`;
				})
				.join("\n");
			return {
				heading: boundedText(headerTitle(run, this.runStatus(run.id))),
				text: boundedOutput(overview),
				format: "markdown",
			};
		}
		const step = runSteps[index];
		const transcript = step?.sessionFile ? this.readTranscript(step.sessionFile) : undefined;
		if (transcript)
			return {
				heading: boundedText(step?.sessionName ?? run.id),
				text: boundedOutput(transcript),
				format: "markdown",
			};
		const text =
			readTail(join(this.runsDir, run.id, `output-${index}.log`), OUTPUT_BYTES) ??
			step?.recentOutput?.join("\n") ??
			"";
		return { heading: boundedText(step?.sessionName ?? run.id), text: boundedOutput(text) };
	}

	private split(id: string): { runId: string; index: number } {
		const [runId, index] = id.split("#");
		return { runId, index: Number(index ?? 0) || 0 };
	}
}
