/**
 * Bash job control across tool calls (`jobs`, `wait %N`, `kill %N`) and the texts the model sees about jobs.
 */
import { constants as osConstants } from "node:os";
import type { Job } from "./jobs.ts";

export type JobControl =
	| { kind: "jobs" }
	| { kind: "wait"; ids: number[] | "all" }
	| { kind: "kill"; signal: NodeJS.Signals; ids: number[] };

const JOB_SPEC = /^%(\d+)$/;

/**
 * Recognise `jobs`, `wait [%N...]` and `kill [-SIGNAL | -s SIGNAL] %N...` when one of them is the whole
 * command, so the extension can answer with a bounded wait and a full report. Inside larger commands the
 * shell functions from jobs.ts handle them.
 */
export function parseJobControl(command: string): JobControl | undefined {
	const text = command.trim().replace(/;$/, "").trim();
	if (!text || /[\n;&|<>`$()]/.test(text)) return undefined;
	const [name, ...args] = text.split(/\s+/);
	if (name === "jobs") return args.every((arg) => /^-[lprs]+$/.test(arg)) ? { kind: "jobs" } : undefined;
	if (name === "wait") {
		if (args.length === 0) return { kind: "wait", ids: "all" };
		const ids = jobIds(args);
		return ids ? { kind: "wait", ids } : undefined;
	}
	if (name === "kill") {
		let signal: NodeJS.Signals | undefined = "SIGTERM";
		let rest = args;
		if (rest[0] === "-s" || rest[0] === "-n") {
			signal = signalName(rest[1] ?? "");
			rest = rest.slice(2);
		} else if (rest[0]?.startsWith("-") && rest[0] !== "--") {
			signal = signalName(rest[0].slice(1));
			rest = rest.slice(1);
		}
		if (rest[0] === "--") rest = rest.slice(1);
		const ids = jobIds(rest);
		return signal && ids && ids.length > 0 ? { kind: "kill", signal, ids } : undefined;
	}
	return undefined;
}

function jobIds(args: string[]): number[] | undefined {
	const ids: number[] = [];
	for (const arg of args) {
		const match = JOB_SPEC.exec(arg);
		if (!match) return undefined;
		ids.push(Number(match[1]));
	}
	return ids;
}

export function signalName(value: string): NodeJS.Signals | undefined {
	const upper = value.toUpperCase();
	if (/^\d+$/.test(upper)) {
		const number = Number(upper);
		const entry = Object.entries(osConstants.signals).find(([, value]) => value === number);
		return entry?.[0] as NodeJS.Signals | undefined;
	}
	const name = upper.startsWith("SIG") ? upper : `SIG${upper}`;
	return name in osConstants.signals ? (name as NodeJS.Signals) : undefined;
}

export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Log text as a terminal would show it: no escape sequences, carriage-return redraws collapsed, last lines only. */
export function cleanOutput(text: string, maxLines = 30): string {
	const lines = text
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((line) =>
			(line.split("\r").filter(Boolean).at(-1) ?? "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").trimEnd(),
		);
	while (lines.length > 0 && lines.at(-1) === "") lines.pop();
	while (lines.length > 0 && lines[0] === "") lines.shift();
	return lines.slice(-maxLines).join("\n");
}

export function quote(label: string, max = 80): string {
	const oneLine = label.replace(/\s*\n\s*/g, " ⏎ ");
	return `\`${oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine}\``;
}

/** How the job ended, e.g. `exited with code 0 after 2m 13s`. */
export function endSummary(job: Job): string {
	const ran = formatDuration((job.endedAt ?? Date.now()) - job.startedAt);
	if (job.end === "timeout") return `was killed after its ${job.timeoutSeconds}s timeout`;
	if (job.end === "stopped") return `was stopped after ${ran}`;
	if (job.spawnError) return `failed to start: ${job.spawnError.message}`;
	if (job.reason === "leftover") return `has no processes left after ${ran}`;
	if (job.exitSignal) return `was killed by ${job.exitSignal} after ${ran}`;
	return `exited with code ${job.exitStatus()} after ${ran}`;
}

export function failed(job: Job): boolean {
	if (job.running) return false;
	if (job.end === "timeout" || job.spawnError || job.exitSignal) return true;
	return job.reason !== "leftover" && job.end !== "stopped" && job.exitStatus() !== 0;
}

/** The final result of a job: how it ended, its last output and where the rest is. */
export function endReport(job: Job, noun = "Job"): string {
	const output = cleanOutput(job.tail());
	return [
		`${noun} %${job.id} ${quote(job.label)} ${endSummary(job)}.`,
		output ? `Last output:\n${output}` : "It printed nothing.",
		`Full output: ${job.logPath}`,
	].join("\n");
}

/** What a running job has printed lately. */
export function runningReport(job: Job): string {
	const output = cleanOutput(job.tail(), 20);
	return [
		`Job %${job.id} ${quote(job.label)} is still running (for ${formatDuration(Date.now() - job.startedAt)}).`,
		output ? `Last output:\n${output}` : "It has printed nothing yet.",
		`Full output: ${job.logPath}. \`kill %${job.id}\` stops it.`,
	].join("\n");
}

/** Appended to a bash result whose command now runs in the background. */
export function backgroundNotice(job: Job, waitSeconds: number, oneShot: boolean): string {
	const id = `%${job.id}`;
	const lines =
		job.reason === "leftover"
			? [
					`The command exited, but processes it started are still running, as job ${id} (process group ${job.pid}).`,
					`You will get a message when they exit; \`kill ${id}\` stops them.`,
				]
			: [
					job.reason === "requested"
						? `Started in the background as job ${id} (pid ${job.pid}). Its output goes to ${job.logPath}.`
						: `Still running after ${waitSeconds}s, so it now runs in the background as job ${id} (pid ${job.pid}). Its output goes to ${job.logPath}.`,
					`You will get a message when it exits. Meanwhile \`wait ${id}\` waits for it and \`kill ${id}\` stops it. Do not start it again.`,
				];
	if (oneShot) lines.push(`This run ends when you finish, and jobs still running then are stopped: \`wait ${id}\` if you need its result.`);
	return lines.join("\n");
}

/**
 * System prompt section naming the jobs still running, so the model knows about them after many
 * turns or a compaction. It has no running times, so it only changes when the set of jobs does.
 */
export function runningJobsSection(jobs: Job[]): string {
	if (jobs.length === 0) return "";
	return [
		"Background jobs from earlier bash calls are still running:",
		...jobs.map((job) => `%${job.id}  ${quote(job.label, 60)}  (pid ${job.pid}, output ${job.logPath})`),
		"They run until they exit or you `kill %N` them, and you get a message when one exits. Do not start them again.",
	].join("\n");
}

/**
 * Left in the session when Pi ends with jobs still running. They die with the process, and a restart
 * (a new model, thinking level or environment in BB) reads the same session file, so the next process
 * must know that the jobs the transcript still talks about are gone.
 */
export function stoppedJobsReport(jobs: Job[]): string {
	const one = jobs.length === 1;
	return [
		one
			? "This background job was stopped because the Pi process ended:"
			: `These ${jobs.length} background jobs were stopped because the Pi process ended:`,
		...jobs.map((job) => `%${job.id}  ${quote(job.label, 60)}  (pid ${job.pid}, output ${job.logPath})`),
		one
			? 'It is gone, so `wait %N` and `kill %N` answer "no such job"; run the command again if you still need it.'
			: 'They are gone, so `wait %N` and `kill %N` answer "no such job"; run a command again if you still need it.',
	].join("\n");
}

export function listJobs(jobs: Job[]): string {
	if (jobs.length === 0) return "No background jobs.";
	return jobs
		.map((job) => {
			const state = job.running ? `running ${formatDuration(Date.now() - job.startedAt)}` : endSummary(job);
			return `%${job.id}  ${quote(job.label, 60)}  ${state}  (pid ${job.pid}, output ${job.logPath})`;
		})
		.join("\n");
}
