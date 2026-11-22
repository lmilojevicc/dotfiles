/**
 * The panel the open key opens in place of the editor, after OpenCode v2's composer: tabs on top,
 * up to five rows, key hints below. ↑ on the first row or Esc closes it, ←/→ switch tabs, Enter
 * opens the selected job's output (or takes the job over when its source offers `open`, with the
 * output on Ctrl+O), Ctrl+D stops it and Ctrl+A switches between running and finished jobs. A job
 * with a `parentId` is listed under its parent, drawn as a tree (`├─`/`└─`); the filter applies to
 * top-level jobs, children follow their parent. Framed like pi-interactive-shell's popups: rounded
 * corners in the theme's border color, no fill. Colors come from Pi's theme tokens (`border`,
 * `text`, `muted`, `dim`, `warning`, `error`, `selectedBg`). Actions are delegated, not executed
 * here: the controller routes them through the background-jobs protocol.
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

/** What the panel asks its host to do; the controller sends the protocol actions. */
export interface PanelActions {
	/** Send the `stop` action for the job; resolves when the provider answers or the request times out. */
	stop(job: TabJob): Promise<{ ok: boolean; error?: string }>;
}

const ROWS = 5;
const SELECTED = "selectedBg";

const STATUS_TEXT: Record<TabJob["status"], string> = {
	running: "Running",
	done: "Done",
	failed: "Failed",
	stopped: "Stopped",
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

	constructor(
		registry: BackgroundJobsRegistry,
		tabOrder: () => Record<string, number>,
		theme: PanelTheme,
		state: PanelState,
		actions: PanelActions,
		done: (result: PanelResult) => void,
		requestRender: () => void = () => {},
	) {
		this.registry = registry;
		this.tabOrder = tabOrder;
		this.theme = theme;
		this.state = state;
		this.actions = actions;
		this.done = done;
		this.requestRender = requestRender;
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

	render(width: number): string[] {
		const { theme } = this;
		const tabs = this.tabs();
		const tab = this.currentTab(tabs);
		const jobs = this.visibleJobs(tab);
		const { job: selected, index } = this.selection(jobs);
		const frame = Math.max(14, width);
		const inner = frame - 4;
		const border = (text: string) => theme.fg("border", text);
		const rule = (left: string, right: string) => border(`${left}${"─".repeat(frame - 2)}${right}`);

		const line = (content: string, rowBg?: string): string => {
			const text = truncateToWidth(content, inner, "…");
			const body = `${text}${" ".repeat(Math.max(0, inner - visibleWidth(text)))}`;
			return `${border("│ ")}${rowBg ? theme.bg(rowBg, body) : body}${border(" │")}`;
		};
		const spread = (left: string, right: string): string =>
			`${left}${" ".repeat(Math.max(1, inner - visibleWidth(left) - visibleWidth(right)))}${right}`;

		const header =
			tabs.length > 1
				? tabs
						.map((entry) =>
							entry === tab
								? theme.bold(theme.fg("text", entry.label))
								: theme.fg("muted", entry.label),
						)
						.join("  ")
				: theme.bold(theme.fg("text", tab?.label ?? "Background"));
		const lines = [rule("╭", "╮"), line(spread(header, theme.fg("dim", "esc"))), rule("├", "┤")];

		// The window of five rows that keeps the selection in view.
		const start = Math.min(Math.max(0, index - ROWS + 1), Math.max(0, jobs.length - ROWS));
		if (jobs.length === 0) {
			const noun = tab?.noun[1] ?? "jobs";
			lines.push(
				line(theme.fg("muted", `No ${this.state.showInactive ? "finished" : "running"} ${noun}`)),
			);
		}
		for (const job of jobs.slice(start, start + ROWS)) {
			const active = job === selected;
			const status =
				job.badge ?? (job.status === "running" ? STATUS_TEXT.running : statusWithTime(job));
			const statusColor = job.status === "failed" ? "error" : active ? "text" : "muted";
			const title = job.title.split("\n", 1)[0];
			// A child row is drawn under its parent with a muted tree prefix.
			const prefix = job.depth === 1 ? theme.fg("muted", `${job.last ? "└─" : "├─"} `) : "";
			const left = active
				? `${prefix}${theme.bold(theme.fg("text", title))}`
				: `${prefix}${theme.fg("text", title)}`;
			const right = theme.fg(statusColor, status);
			const available = inner - visibleWidth(status) - 2;
			lines.push(
				line(
					spread(truncateToWidth(left, Math.max(5, available), "…"), right),
					active ? SELECTED : undefined,
				),
			);
		}
		for (let i = Math.max(1, Math.min(ROWS, jobs.length)); i < ROWS; i++) lines.push(line(""));
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

function statusWithTime(job: TabJob): string {
	const text = STATUS_TEXT[job.status];
	return job.startedAt !== undefined && job.endedAt !== undefined
		? `${text} · ${formatDuration(job.endedAt - job.startedAt)}`
		: text;
}
