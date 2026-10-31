/**
 * What the model and the user read about jobs, and the guard against sleeping in the foreground.
 */
import type { Job } from "./jobs.ts";

/** A foreground `sleep` at least this long is refused: background jobs report back on their own. */
export const MIN_REFUSED_SLEEP_SECONDS = 5;

/**
 * Seconds of a `sleep` that starts the command or is the whole command (`sleep 30`, `sleep 10 && curl …`,
 * `sleep 1m; tail log`), so the call can be refused instead of holding the agent to poll. A sleep
 * inside a loop or after other work is left alone: the loop moves to the background like any long command.
 */
export function leadingSleepSeconds(command: string): number | undefined {
	const match = /^\s*sleep\s+(\d+(?:\.\d+)?)([smh]?)\s*(?:$|;|&&|\|\||\n)/.exec(command);
	if (!match) return undefined;
	const unit = { "": 1, s: 1, m: 60, h: 3600 }[match[2] as "" | "s" | "m" | "h"];
	return Number(match[1]) * unit;
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
		`${noun} ${job.id} ${quote(job.label)} ${endSummary(job)}.`,
		output ? `Last output:\n${output}` : "It printed nothing.",
		`Full output: ${job.logPath}`,
	].join("\n");
}

/** A running job and what it printed since the model last looked. */
export function progressReport(job: Job): string {
	const { text, skipped } = job.unread();
	const output = cleanOutput(text, 100);
	return [
		`Job ${job.id} ${quote(job.label)} is still running (for ${formatDuration(Date.now() - job.startedAt)}).`,
		output
			? `${skipped > 0 ? `New output (the last part; ${skipped} earlier bytes are in the log):` : "New output:"}\n${output}`
			: "No new output since you last looked.",
		`Full output: ${job.logPath}`,
	].join("\n");
}

/** Appended to a bash result whose command now runs in the background. */
export function backgroundNotice(job: Job, waitSeconds: number, oneShot: boolean): string {
	const n = job.id;
	const lines = [
		job.reason === "leftover"
			? `The command exited, but processes it started are still running, as job ${n} (process group ${job.pid}).`
			: job.reason === "requested"
				? `Started in the background as job ${n} (pid ${job.pid}).`
				: `Still running after ${waitSeconds}s, so it continues in the background as job ${n} (pid ${job.pid}).`,
		`You get a message when it exits; keep working meanwhile. The jobs tool shows its new output (action "output", id ${n}), waits for it ("wait") or stops it ("kill"). Full output: ${job.logPath}`,
	];
	if (oneShot) lines.push(`This run ends when you finish and stops jobs still running then: wait for job ${n} if you need its result.`);
	return lines.join("\n");
}

export function listJobs(jobs: Job[]): string {
	if (jobs.length === 0) return "No background jobs.";
	return jobs
		.map((job) => {
			const state = job.running ? `running for ${formatDuration(Date.now() - job.startedAt)}` : endSummary(job);
			return `${job.id}  ${quote(job.label, 60)}  ${state}  (pid ${job.pid}, output ${job.logPath})`;
		})
		.join("\n");
}
