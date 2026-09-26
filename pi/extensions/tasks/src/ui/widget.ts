import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { DEFAULT_TASKS_CONFIG, type TaskDisplayConfig } from "../config/tasks-config.js";
import type { Task, TaskSnapshot } from "../domain/types.js";
import { taskActivity, type SessionActivity } from "../state/activity.js";
import { getForeground } from "../state/store.js";
import { foregroundSnapshot } from "../tool/register.js";
import { sanitizeTerminalText } from "./sanitize.js";
import { resolveTaskGlyphs, type TaskGlyphs } from "./task-glyphs.js";
import { sortTasks } from "./task-sort.js";

export const WIDGET_KEY = "tasks";
export const SPINNER_INTERVAL_MS = 150;

export function formatDuration(milliseconds: number): string {
	const totalSeconds = Math.floor(Math.max(0, milliseconds) / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

export function formatTokens(value: number): string {
	if (value < 1000) return String(value);
	return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}

function renderTask(task: Task, tasks: readonly Task[], theme: Theme, frame: number, glyphs: TaskGlyphs): string {
	const subject = sanitizeTerminalText(task.subject);
	if (task.status === "completed") {
		return `${theme.fg("success", glyphs.completed)} ${theme.fg("dim", theme.strikethrough(subject))}`;
	}
	if (task.status === "in_progress") {
		const action = sanitizeTerminalText(task.activeForm);
		const suffix = action && action !== subject ? theme.fg("dim", ` (${action})`) : "";
		return `${theme.fg("warning", glyphs.spinner[frame % glyphs.spinner.length]!)} ${theme.fg("text", subject)}${suffix}`;
	}

	let suffix = "";
	if (task.status === "pending") {
		const blockers = task.blockedBy.filter((blockedId) => {
			const blocker = tasks.find((candidate) => candidate.id === blockedId);
			return blocker !== undefined && blocker.status !== "completed" && blocker.status !== "deleted";
		});
		if (blockers.length) suffix = theme.fg("dim", ` ${glyphs.blocked} blocked by ${blockers.map((id) => `#${id}`).join(", ")}`);
	}
	return `${theme.fg("dim", glyphs.pending)} ${theme.fg("text", subject)}${suffix}`;
}

/** Pure checklist renderer; activity inputs are retained for caller compatibility. */
export function renderWidget(
	snapshot: TaskSnapshot,
	activity: SessionActivity | undefined,
	config: TaskDisplayConfig,
	theme: Theme,
	width: number,
	frame = 0,
	toggleShowAll = false,
	now = Date.now(),
): string[] {
	try {
		if (width < 1) return [];
		const tasks = sortTasks(snapshot.tasks.filter((task) => task.status !== "deleted"), config.sortOrder);
		if (!tasks.length) return [];
		const glyphs = resolveTaskGlyphs(config.glyphs);
		const completed = tasks.filter((task) => task.status === "completed");
		const clip = (line: string) => truncateToWidth(line, width, glyphs.truncation);
		const lines = [clip(theme.fg("accent", `${glyphs.header} Tasks (${completed.length}/${tasks.length})`))];
		const listed = config.collapseCompleted ? tasks.filter((task) => task.status !== "completed") : tasks;
		const showAll = toggleShowAll ? !config.showAll : config.showAll;
		const limit = Number.isSafeInteger(config.maxVisible) && config.maxVisible > 0 ? config.maxVisible : 10;
		const visible = showAll ? listed : config.hiddenAt === "top" ? listed.slice(-limit) : listed.slice(0, limit);
		const hidden = listed.length - visible.length;
		const rows: string[] = [];
		const overflow = hidden ? theme.fg("dim", `${glyphs.overflow} and ${hidden} more`) : undefined;
		if (overflow && config.hiddenAt === "top") rows.push(overflow);
		for (const task of visible) rows.push(renderTask(task, tasks, theme, frame, glyphs));
		if (overflow && config.hiddenAt !== "top") rows.push(overflow);
		if (config.collapseCompleted && completed.length) {
			rows.push(`${theme.fg("success", glyphs.completedSummary)} ${theme.fg("dim", `${completed.length} completed`)}`);
		}
		for (const [index, row] of rows.entries()) {
			lines.push(clip(`${theme.fg("dim", index === rows.length - 1 ? "└─" : "├─")} ${row}`));
		}
		// A single quiet spacer keeps adjacent above-editor telemetry from reading as
		// part of the Tasks hierarchy. It is presentation-only, not a visible row.
		lines.push("");
		return lines;
	} catch {
		return [];
	}
}

export class TaskWidget {
	private ui?: ExtensionUIContext;
	private tui?: TUI;
	private registered = false;
	private toggleShowAllOverride = false;
	private frame = 0;
	private interval?: ReturnType<typeof setInterval>;
	private config: TaskDisplayConfig;

	constructor(config: TaskDisplayConfig = DEFAULT_TASKS_CONFIG) {
		this.config = config;
	}

	bind(ui: ExtensionUIContext): void {
		if (this.ui === ui) return;
		this.stopTimer();
		if (this.registered && this.ui) {
			try { this.ui.setWidget(WIDGET_KEY, undefined); } catch {}
		}
		this.ui = ui;
		this.tui = undefined;
		this.registered = false;
		this.toggleShowAllOverride = false;
		this.frame = 0;
	}

	setConfig(config: TaskDisplayConfig): void {
		this.config = config;
		this.refresh();
	}

	getConfig(): TaskDisplayConfig {
		return this.config;
	}

	private needsAnimation(): boolean {
		return resolveTaskGlyphs(this.config.glyphs).spinner.length > 1
			&& foregroundSnapshot().tasks.some((task) => task.status === "in_progress");
	}

	private startTimer(): void {
		if (this.interval || !this.tui || !this.needsAnimation()) return;
		this.interval = setInterval(() => {
			this.frame++;
			this.tui?.requestRender();
		}, SPINNER_INTERVAL_MS);
		(this.interval as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.();
	}

	private stopTimer(): void {
		if (this.interval) clearInterval(this.interval);
		this.interval = undefined;
	}

	private syncTimer(): void {
		if (this.registered && this.needsAnimation()) this.startTimer();
		else this.stopTimer();
	}

	refresh(reset = false): void {
		if (!this.ui) return;
		if (reset) {
			this.toggleShowAllOverride = false;
			this.frame = 0;
		}
		const hasTasks = foregroundSnapshot().tasks.some((task) => task.status !== "deleted");
		if (!hasTasks) {
			this.stopTimer();
			if (this.registered) this.ui.setWidget(WIDGET_KEY, undefined);
			this.registered = false;
			this.tui = undefined;
			return;
		}
		if (!this.registered) {
			this.ui.setWidget(WIDGET_KEY, (tui, theme) => {
				this.tui = tui;
				this.startTimer();
				return {
					render: (width: number) => renderWidget(
						foregroundSnapshot(), taskActivity.get(getForeground()), this.config,
						this.ui?.theme ?? theme, width, this.frame, this.toggleShowAllOverride,
					),
					invalidate() {},
					dispose: () => {
						if (this.tui === tui) this.tui = undefined;
						this.stopTimer();
					},
				};
			}, { placement: "aboveEditor" });
			this.registered = true;
		} else {
			this.syncTimer();
			this.tui?.requestRender(true);
		}
	}

	redraw(): void {
		this.tui?.requestRender();
	}

	toggle(): void {
		if (!this.registered) return;
		this.toggleShowAllOverride = !this.toggleShowAllOverride;
		this.tui?.requestRender(true);
	}

	dispose(): void {
		this.stopTimer();
		try {
			if (this.registered && this.ui) this.ui.setWidget(WIDGET_KEY, undefined);
		} finally {
			this.ui = undefined;
			this.tui = undefined;
			this.registered = false;
			this.toggleShowAllOverride = false;
			this.frame = 0;
		}
	}
}
