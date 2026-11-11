/**
 * What the model and the user read about background tasks, and the guard against sleeping in the foreground.
 */
import type { Task } from "./tasks.ts";

/** A foreground `sleep` at least this long is refused: background tasks report back on their own. */
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
			(line.split("\r").filter(Boolean).at(-1) ?? "")
				.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
				.trimEnd(),
		);
	while (lines.length > 0 && lines.at(-1) === "") lines.pop();
	while (lines.length > 0 && lines[0] === "") lines.shift();
	return lines.slice(-maxLines).join("\n");
}

export function quote(label: string, max = 80): string {
	const oneLine = label.replace(/\s*\n\s*/g, " ⏎ ");
	return `\`${oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine}\``;
}

/** The task's description if the model gave one, otherwise its command. */
export function title(task: Task, max = 80): string {
	if (!task.description) return quote(task.label, max);
	return task.description.length > max
		? `${task.description.slice(0, max - 1)}…`
		: task.description;
}

/** Claude Code's task states: running, then completed, failed or killed. */
export type TaskStatus = "running" | "completed" | "failed" | "killed";

export function status(task: Task): TaskStatus {
	if (task.running) return "running";
	if (task.end === "stopped" || task.end === "timeout" || task.end === "shutdown") return "killed";
	return failed(task) ? "failed" : "completed";
}

/** How the task ended, e.g. `exited with code 0 after 2m 13s`. */
export function endSummary(task: Task): string {
	const ran = formatDuration((task.endedAt ?? Date.now()) - task.startedAt);
	if (task.end === "timeout") return `was killed after its ${task.timeoutSeconds}s timeout`;
	if (task.end === "stopped") return `was stopped after ${ran}`;
	if (task.spawnError) return `failed to start: ${task.spawnError.message}`;
	if (task.reason === "leftover") return `has no processes left after ${ran}`;
	if (task.exitSignal) return `was killed by ${task.exitSignal} after ${ran}`;
	return `exited with code ${task.exitStatus()} after ${ran}`;
}

export function failed(task: Task): boolean {
	if (task.running) return false;
	// Stopping a task on purpose (SIGTERM, so exit 143) is not a failure.
	if (task.end === "stopped") return false;
	if (task.end === "timeout" || task.spawnError || task.exitSignal) return true;
	return task.reason !== "leftover" && task.exitStatus() !== 0;
}

/** The final result of a task: how it ended, its last output and where the rest is. */
export function endReport(task: Task): string {
	const output = cleanOutput(task.tail());
	return [
		`Background task ${task.id} ${title(task)} ${endSummary(task)}.`,
		task.description ? `Command: ${quote(task.label, 500)}` : undefined,
		output ? `Last output:\n${output}` : "It printed nothing.",
		`Full output: ${task.logPath}`,
	]
		.filter((line) => line !== undefined)
		.join("\n");
}

/** A running task and what it printed since the model last looked. */
export function progressReport(task: Task): string {
	const { text, skipped } = task.unread();
	const output = cleanOutput(text, 100);
	return [
		`Task ${task.id} ${title(task)} is still running (for ${formatDuration(Date.now() - task.startedAt)}).`,
		output
			? `${skipped > 0 ? `New output (the last part; ${skipped} earlier bytes are in the log):` : "New output:"}\n${output}`
			: "No new output since you last saw its output.",
		`Full output: ${task.logPath}`,
	].join("\n");
}

/** Appended to a bash result whose command now runs in the background. */
export function backgroundNotice(
	task: Task,
	waitSeconds: number,
	oneShot: boolean,
	interrupted = false,
): string {
	const id = task.id;
	const lines = [
		task.reason === "leftover"
			? `The command exited, but processes it started are still running, as background task ${id} (process group ${task.pid}).`
			: interrupted
				? `Moved to the background early, as task ${id} (pid ${task.pid}), to handle an incoming message; the command keeps running.`
				: task.reason === "requested"
					? `Command running in the background as task ${id} (pid ${task.pid}).`
					: `Still running after ${waitSeconds}s, so it continues in the background as task ${id} (pid ${task.pid}).`,
		`You get a message when it exits; keep working meanwhile. \`tasks output ${id}\` shows its new output, \`tasks wait ${id}\` waits for it, \`tasks stop ${id}\` stops it. Full output: ${task.logPath}`,
	];
	if (oneShot)
		lines.push(
			`This run ends when you finish and stops tasks still running then: run \`tasks wait ${id}\` if you need its result.`,
		);
	return lines.join("\n");
}

export function listTasks(tasks: Task[]): string {
	if (tasks.length === 0) return "No background tasks.";
	return tasks
		.map((task) => {
			const state = task.running
				? `running for ${formatDuration(Date.now() - task.startedAt)}`
				: endSummary(task);
			return `${task.id}  ${title(task, 60)}  ${state}  (pid ${task.pid}, output ${task.logPath})`;
		})
		.join("\n");
}

/** Several tasks that ended close together, in one message. */
export function batchReport(tasks: Task[]): string {
	if (tasks.length === 1) return endReport(tasks[0]);
	const failures = tasks.filter(failed).length;
	return [
		`${tasks.length} background tasks ended${failures > 0 ? ` (${failures} failed)` : ""}.`,
		...tasks.map(endReport),
	].join("\n\n");
}
