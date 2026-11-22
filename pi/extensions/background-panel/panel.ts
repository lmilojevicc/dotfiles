/**
 * The panel the open key opens in place of the editor, after OpenCode v2's composer: tabs on top,
 * up to five rows, key hints below. ↑ on the first row or Esc closes it, ←/→ switch tabs, Enter
 * opens the selected job's output (or takes the job over when its source offers `open`, with the
 * output on Ctrl+O), Ctrl+D stops it and Ctrl+A switches between running and finished jobs. A job
 * with a `parentId` is listed under its parent, drawn as a tree (`├─`/`└─`); the filter applies to
 * top-level jobs, children follow their parent. Framed like pi-interactive-shell's popups: rounded
 * corners in the theme's border color, no fill. Colors come from Pi's theme tokens (`border`,
 * `text`, `muted`, `dim`, `warning`, `error`, `success`, `accent`, `selectedBg`). Actions are
 * delegated, not executed here: the controller routes them through the background-jobs protocol.
 *
 * While anything runs the panel is alive, in pi-subagents' widget style: every row leads with a
 * state glyph (a braille spinner frame for running, ✓/✗/■ when finished), running rows recompute
 * their elapsed time on every clock tick, tab labels carry a dot and their visible count, running
 * workflow parents show a step progress bar.
 */
import { isKeyRelease, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { BackgroundJobsRegistry, Tab, TabJob } from "./registry.ts";

export interface PanelTheme {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
}

export type PanelResult =
	| { kind: "close" }
	| { kind: "output"; job: TabJob; tabId: string }
	| { kind: "open"; job: TabJob };

export interface PanelState {
	tabId?: string;
	showInactive: boolean;
}

/** The animation clock the controller drives: the spinner frame and the wall clock. */
export interface PanelClock {
	frame(): number;
	now(): number;
}

/** What the panel asks its host to do; the controller sends the protocol actions. */
export interface PanelActions {
	/** Send the `stop` action for the job; resolves when the provider answers or the request times out. */
	stop(job: TabJob): Promise<{ ok: boolean; error?: string }>;
}

/** The braille spinner frames, as pi-subagents' widget animates them (500 ms per frame). */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** The theme token each status word and glyph uses. */
export const STATUS_COLOR: Record<TabJob["status"], string> = {
	running: "accent",
	done: "success",
	failed: "error",
	stopped: "warning",
};

/** The leading glyph of a row: the spinner frame while running, ✓/✗/■ once finished. */
export function statusGlyph(
	status: TabJob["status"],
	frame: number,
): { glyph: string; color: string } {
	if (status === "running")
		return { glyph: SPINNER_FRAMES[frame % SPINNER_FRAMES.length], color: STATUS_COLOR.running };
	if (status === "done") return { glyph: "✓", color: STATUS_COLOR.done };
	if (status === "failed") return { glyph: "✗", color: STATUS_COLOR.failed };
	return { glyph: "■", color: STATUS_COLOR.stopped };
}

/**
 * A running job whose badge starts with `quiet ` is waiting for input (pi-interactive-shell's
 * bridge publishes it); the panel marks it with ◆ in the warning color instead of the spinner.
 */
export function isQuietBadge(badge: string | undefined): boolean {
	return badge !== undefined && badge.startsWith("quiet ");
}

const ROWS = 5;
const SELECTED = "selectedBg";

export const STATUS_TEXT: Record<TabJob["status"], string> = {
	running: "running",
	done: "done",
	failed: "failed",
	stopped: "stopped",
};

export class Panel {
	private selectedKey: string | undefined;
	private selectedIndex = 0;
	private notice: string | undefined;

	private readonly registry: BackgroundJobsRegistry;
	private readonly tabOrder: () => Record<string, number>;
	private readonly theme: PanelTheme;
	private readonly actions: PanelActions;
	readonly state: PanelState;
	private readonly done: (result: PanelResult) => void;
	private readonly requestRender: () => void;
	private readonly clock: PanelClock;

	constructor(
		registry: BackgroundJobsRegistry,
		tabOrder: () => Record<string, number>,
		theme: PanelTheme,
		state: PanelState,
		actions: PanelActions,
		done: (result: PanelResult) => void,
		requestRender: () => void = () => {},
		clock: PanelClock = { frame: () => 0, now: () => Date.now() },
	) {
		this.registry = registry;
		this.tabOrder = tabOrder;
		this.theme = theme;
		this.state = state;
		this.actions = actions;
		this.done = done;
		this.requestRender = requestRender;
		this.clock = clock;
		const tabs = registry.tabs(tabOrder());
		if (!tabs.some((tab) => tab.id === state.tabId))
			state.tabId = (
				tabs.find((tab) => tab.jobs.some((job) => job.status === "running")) ?? tabs[0]
			)?.id;
	}

	private tabs(): Tab[] {
		return this.registry.tabs(this.tabOrder());
	}

	private currentTab(tabs: Tab[]): Tab | undefined {
		return tabs.find((tab) => tab.id === this.state.tabId) ?? tabs[0];
	}

	private visibleJobs(tab: Tab | undefined): TabJob[] {
		if (!tab) return [];
		// The filter applies to top-level jobs; children always follow their parent.
		const visible: TabJob[] = [];
		let parentVisible = false;
		for (const job of tab.jobs) {
			if (job.depth === 0) {
				parentVisible = (job.status === "running") !== this.state.showInactive;
				if (parentVisible) visible.push(job);
			} else if (parentVisible) visible.push(job);
		}
		return visible;
	}

	/** The selected job, kept by key so a list that changes under the cursor does not move it. */
	private selection(jobs: TabJob[]): { job: TabJob | undefined; index: number } {
		let index = jobs.findIndex((job) => job.key === this.selectedKey);
		if (index < 0) index = Math.min(this.selectedIndex, jobs.length - 1);
		const job = jobs[index];
		this.selectedIndex = Math.max(0, index);
		this.selectedKey = job?.key;
		return { job, index: Math.max(0, index) };
	}

	private select(jobs: TabJob[], index: number): void {
		this.selectedIndex = index;
		this.selectedKey = jobs[index]?.key;
		this.notice = undefined;
	}

	handleInput(data: string): void {
		if (isKeyRelease(data)) return;
		const tabs = this.tabs();
		const tab = this.currentTab(tabs);
		const jobs = this.visibleJobs(tab);
		const { job, index } = this.selection(jobs);

		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c"))
			return this.done({ kind: "close" });
		if (matchesKey(data, "up")) {
			if (index === 0) return this.done({ kind: "close" });
			this.select(jobs, index - 1);
		} else if (matchesKey(data, "down")) {
			if (jobs.length > 0) this.select(jobs, (index + 1) % jobs.length);
		} else if (matchesKey(data, "left") || matchesKey(data, "right")) {
			if (tabs.length > 1 && tab) {
				const at = tabs.indexOf(tab);
				const next = tabs[(at + (matchesKey(data, "left") ? -1 : 1) + tabs.length) % tabs.length];
				this.state.tabId = next.id;
				this.select([], 0);
			}
		} else if (matchesKey(data, "ctrl+a")) {
			this.state.showInactive = !this.state.showInactive;
			this.select([], 0);
		} else if (matchesKey(data, "enter")) {
			if (job?.actions?.open !== undefined) return this.done({ kind: "open", job });
			if (job?.actions?.output === true && tab)
				return this.done({ kind: "output", job, tabId: tab.id });
		} else if (matchesKey(data, "ctrl+o")) {
			if (job?.actions?.output === true && tab)
				return this.done({ kind: "output", job, tabId: tab.id });
		} else if (matchesKey(data, "ctrl+d")) {
			if (job?.status === "running" && job.actions?.stop !== undefined) {
				const label = job.actions.stop;
				this.notice = `${label === "kill" ? "Killing" : "Stopping"} ${job.title.split("\n", 1)[0]}…`;
				void this.actions
					.stop(job)
					.then((result) => {
						this.notice = result.ok
							? undefined
							: `Could not ${label}: ${result.error ?? "no answer"}`;
					})
					.finally(() => {
						this.registry.changed();
						this.requestRender();
					});
			}
		} else {
			return;
		}
		this.requestRender();
	}

	/** A tab's header label: a running dot, the label, and the count of visible jobs. */
	private tabLabel(entry: Tab, active: boolean): string {
		const { theme } = this;
		const count = this.visibleJobs(entry).length;
		const dot = entry.jobs.some((job) => job.status === "running")
			? theme.fg("accent", "● ")
			: entry.jobs.length > 0
				? theme.fg("dim", "○ ")
				: "";
		const label = theme.fg(active ? "text" : "muted", `${entry.label} ${count}`);
		return active ? `${dot}${theme.bold(label)}` : `${dot}${label}`;
	}

	private glyph(job: TabJob, frame: number): string {
		if (job.status === "running" && isQuietBadge(job.badge)) return this.theme.fg("warning", "◆");
		const { glyph, color } = statusGlyph(job.status, frame);
		return this.theme.fg(color, glyph);
	}

	private elapsed(job: TabJob, now: number): string | undefined {
		if (job.startedAt === undefined) return undefined;
		const end = job.status === "running" ? now : job.endedAt;
		if (end === undefined) return undefined;
		return formatDuration(end - job.startedAt);
	}

	/** The right side of a row: the status word or badge, and the live or total time in dim. */
	private statusRight(job: TabJob, tab: Tab | undefined, now: number): string {
		const { theme } = this;
		const color = STATUS_COLOR[job.status];
		const time = this.elapsed(job, now);
		const dim = (text: string) => theme.fg("dim", text);
		if (job.status === "running") {
			// A running parent shows its steps as a progress bar instead of a status word.
			const children = (tab?.jobs ?? []).filter(
				(entry) => entry.source === job.source && entry.parentId === job.id,
			);
			if (children.length > 0) {
				const done = children.filter((entry) => entry.status !== "running").length;
				const bar =
					theme.fg("success", "▰".repeat(done)) +
					theme.fg("dim", "▱".repeat(children.length - done));
				return `${bar} ${dim(`${done}/${children.length}${time !== undefined ? ` · ${time}` : ""}`)}`;
			}
			if (job.badge === undefined)
				return time === undefined
					? theme.fg(color, STATUS_TEXT.running)
					: `${theme.fg(color, STATUS_TEXT.running)} ${dim(time)}`;
			const badge = isQuietBadge(job.badge)
				? theme.fg("warning", job.badge)
				: theme.fg(color, job.badge);
			// A quiet badge that started with the job already says its time (`quiet 10s · 10s`).
			const repeats = time !== undefined && job.badge.endsWith(` ${time}`);
			return time === undefined || repeats ? badge : `${badge} ${dim(`· ${time}`)}`;
		}
		if (job.status === "done" && job.badge === undefined)
			return time === undefined ? theme.fg(color, STATUS_TEXT.done) : dim(time);
		const word = theme.fg(color, job.badge ?? STATUS_TEXT[job.status]);
		return time === undefined ? word : `${word} ${dim(`· ${time}`)}`;
	}

	render(width: number): string[] {
		const { theme } = this;
		const tabs = this.tabs();
		const tab = this.currentTab(tabs);
		const jobs = this.visibleJobs(tab);
		const { job: selected, index } = this.selection(jobs);
		const now = this.clock.now();
		const frame = this.clock.frame();
		const frameWidth = Math.max(14, width);
		const inner = frameWidth - 4;
		const border = (text: string) => theme.fg("border", text);
		const rule = (left: string, right: string) =>
			border(`${left}${"─".repeat(frameWidth - 2)}${right}`);

		const line = (content: string, rowBg?: string): string => {
			const text = truncateToWidth(content, inner, "…");
			const body = `${text}${" ".repeat(Math.max(0, inner - visibleWidth(text)))}`;
			return `${border("│ ")}${rowBg ? theme.bg(rowBg, body) : body}${border(" │")}`;
		};
		const spread = (left: string, right: string): string =>
			`${left}${" ".repeat(Math.max(1, inner - visibleWidth(left) - visibleWidth(right)))}${right}`;

		const header =
			tabs.length > 1
				? tabs.map((entry) => this.tabLabel(entry, entry === tab)).join("  ")
				: tab
					? this.tabLabel(tab, true)
					: theme.bold(theme.fg("text", "Background"));
		const lines = [rule("╭", "╮"), line(spread(header, theme.fg("dim", "esc"))), rule("├", "┤")];

		// The window of five rows that keeps the selection in view.
		const start = Math.min(Math.max(0, index - ROWS + 1), Math.max(0, jobs.length - ROWS));
		let contentRows = 0;
		if (jobs.length === 0) {
			const noun = tab?.noun[1] ?? "jobs";
			lines.push(
				line(theme.fg("muted", `No ${this.state.showInactive ? "finished" : "running"} ${noun}`)),
			);
			contentRows = 1;
		}
		for (const job of jobs.slice(start, start + ROWS)) {
			const active = job === selected;
			const status = this.statusRight(job, tab, now);
			const title = job.title.split("\n", 1)[0];
			// A child row is drawn under its parent with a muted tree prefix, then its own glyph.
			const prefix = job.depth === 1 ? theme.fg("muted", `${job.last ? "└─" : "├─"} `) : "";
			const left = `${prefix}${this.glyph(job, frame)} ${
				active ? theme.bold(theme.fg("text", title)) : theme.fg("text", title)
			}`;
			const available = inner - visibleWidth(status) - 4;
			lines.push(
				line(
					spread(truncateToWidth(left, Math.max(5, available), "…"), status),
					active ? SELECTED : undefined,
				),
			);
			contentRows++;
		}
		for (let i = contentRows; i < ROWS; i++) lines.push(line(""));
		lines.push(rule("├", "┤"));

		const hints: Array<[string, string]> = [];
		if (selected?.actions?.open !== undefined) hints.push([selected.actions.open, "enter"]);
		if (selected?.actions?.output === true)
			hints.push(["output", selected.actions?.open !== undefined ? "ctrl+o" : "enter"]);
		if (selected?.status === "running" && selected.actions?.stop !== undefined)
			hints.push([selected.actions.stop, "ctrl+d"]);
		hints.push([`show ${this.state.showInactive ? "running" : "finished"}`, "ctrl+a"]);
		if (tabs.length > 1) hints.push(["tabs", "←/→"]);
		const hintText = hints
			.map(([label, key]) => `${theme.bold(theme.fg("text", label))} ${theme.fg("muted", key)}`)
			.join("  ");
		lines.push(line(this.notice ? theme.fg("warning", this.notice) : hintText));
		lines.push(rule("╰", "╯"));
		return lines;
	}

	invalidate(): void {}
}

export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
