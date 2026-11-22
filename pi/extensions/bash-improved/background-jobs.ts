/**
 * Background tasks as a provider for the dotfiles background-panel extension (the ↓ panel), so
 * they appear in its Shell tab. The protocol is `background-jobs:v1`: plain data on `pi.events`,
 * documented in ../background-panel/README.md. Its names and shapes are copied here on purpose, so
 * this extension does not import the background-panel extension.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { failed } from "./format.ts";
import type { Task } from "./tasks.ts";

const VERSION = 1;
const CAPABILITY_EVENT = "background-jobs:v1:capability";
const SNAPSHOT_EVENT = "background-jobs:v1:snapshot";
const ACTION_EVENT = "background-jobs:v1:action";
const REPLY_EVENT = "background-jobs:v1:action-reply";
const SOURCE = "bash-improved";
const TAB = { id: "shell", label: "Shell", noun: ["shell", "shells"], order: 20 };
// The protocol's bounds: titles and headings up to 512 code units, output up to 256 KiB, 200 jobs.
const MAX_TEXT = 512;
const MAX_OUTPUT = 256 * 1024;
const MAX_JOBS = 200;
const OUTPUT_BYTES = 64 * 1024;

export interface BackgroundJob {
	id: string;
	title: string;
	status: "running" | "done" | "failed" | "stopped";
	startedAt?: number;
	endedAt?: number;
	actions: { stop?: string; output: true };
}

function clamp(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** The tail end of the output when it is longer than the protocol allows. */
function clampTail(text: string, max: number): string {
	return text.length <= max ? text : text.slice(text.length - max);
}

export function jobStatus(task: Task): BackgroundJob["status"] {
	if (task.running) return "running";
	if (task.end === "stopped" || task.end === "timeout" || task.end === "shutdown") return "stopped";
	return failed(task) ? "failed" : "done";
}

export function toJob(task: Task): BackgroundJob {
	// The panel row shows the command, like OpenCode; the description is a fallback for a blank one.
	const title = task.label.split("\n", 1)[0].trim() || task.description || `task ${task.id}`;
	return {
		id: String(task.id),
		title: clamp(title, MAX_TEXT),
		status: jobStatus(task),
		startedAt: task.startedAt,
		...(task.endedAt ? { endedAt: task.endedAt } : {}),
		actions: task.running ? { stop: "kill", output: true } : { output: true },
	};
}

export interface JobsSource {
	tasks(): Task[];
	get(id: number): Task | undefined;
	/** The user stopped a task from the panel. */
	stop(task: Task): Promise<void>;
}

interface ActionRequest {
	version: number;
	requestId: string;
	source: string;
	jobId: string;
	action: string;
}

function actionRequest(value: unknown): ActionRequest | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const request = value as Partial<ActionRequest>;
	if (request.version !== VERSION || request.source !== SOURCE) return undefined;
	if (typeof request.requestId !== "string" || typeof request.jobId !== "string") return undefined;
	if (typeof request.action !== "string") return undefined;
	return request as ActionRequest;
}

/** Publish the tasks; returns `changed` (call when the list changes) and `dispose`. */
export function publishJobs(
	pi: ExtensionAPI,
	source: JobsSource,
): { changed: () => void; dispose: () => void } {
	// Snapshots sent while the panel is off are dropped, so always send the whole list; Zentui
	// re-announces the capability when the panel turns on, and the list goes out again then.
	const publish = () =>
		pi.events.emit(SNAPSHOT_EVENT, {
			version: VERSION,
			source: SOURCE,
			tab: TAB,
			jobs: source.tasks().slice(-MAX_JOBS).map(toJob),
		});

	const reply = (requestId: string, body: Record<string, unknown>) =>
		pi.events.emit(REPLY_EVENT, { requestId, ...body });

	const offCapability = pi.events.on(CAPABILITY_EVENT, (value) => {
		if ((value as { active?: unknown } | null)?.active === true) publish();
	});
	const offAction = pi.events.on(ACTION_EVENT, async (value) => {
		const request = actionRequest(value);
		if (!request) return;
		const task = source.get(Number(request.jobId));
		if (!task) return reply(request.requestId, { ok: false, error: `No task ${request.jobId}` });
		if (request.action === "output") {
			const heading = task.description ? `${task.description}\n$ ${task.label}` : `$ ${task.label}`;
			return reply(request.requestId, {
				ok: true,
				output: {
					heading: clamp(heading, MAX_TEXT),
					text: clampTail(task.tail(OUTPUT_BYTES), MAX_OUTPUT),
				},
			});
		}
		if (request.action === "stop") {
			try {
				if (task.running) await source.stop(task);
				return reply(request.requestId, { ok: true });
			} catch (error) {
				return reply(request.requestId, {
					ok: false,
					error: clamp(error instanceof Error ? error.message : String(error), MAX_TEXT),
				});
			}
		}
		return reply(request.requestId, { ok: false, error: `Unsupported action ${request.action}` });
	});
	publish();
	return {
		changed: publish,
		dispose: () => {
			offCapability();
			offAction();
			pi.events.emit(SNAPSHOT_EVENT, { version: VERSION, source: SOURCE, remove: true });
		},
	};
}
