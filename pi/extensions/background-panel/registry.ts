/**
 * The validated `background-jobs:v1:snapshot` messages the panel knows, grouped into tabs. Jobs with
 * a `parentId` are arranged as a two-level tree: top-level jobs newest first, each followed by its
 * children in run order, drawn with `├─`/`└─` rows. A `parentId` that names no job of the same
 * source, or a loop, keeps the job top-level; a child of a child flattens into its top-level
 * ancestor's block. Nothing here reads files, calls providers, or touches the UI.
 */
import {
	type BackgroundJob,
	MAX_BACKGROUND_JOBS_SOURCES,
	type BackgroundJobsTab,
} from "./protocol.ts";

export interface TabJob extends BackgroundJob {
	/** The source that published the job. */
	source: string;
	/** `source:id`, unique across the tab. */
	key: string;
	/** 0 for a top-level job, 1 for a child listed under its parent. */
	depth: 0 | 1;
	/** Whether this job is the last row of its parent's block, drawn with a `└─` prefix. */
	last: boolean;
	/** How many jobs list this one as their parent. */
	childCount: number;
}

export interface Tab extends Omit<BackgroundJobsTab, "order"> {
	order: number;
	jobs: TabJob[];
}

interface SourceJobs {
	tab: BackgroundJobsTab;
	jobs: BackgroundJob[];
}

export class BackgroundJobsRegistry {
	private readonly sources = new Map<string, SourceJobs>();
	private readonly listeners = new Set<() => void>();

	/** Replaces the source's snapshot; a message from an unknown source beyond the cap is ignored. */
	update(source: string, tab: BackgroundJobsTab, jobs: readonly BackgroundJob[]): void {
		if (!this.sources.has(source) && this.sources.size >= MAX_BACKGROUND_JOBS_SOURCES) return;
		this.sources.set(source, { tab, jobs: [...jobs] });
		this.changed();
	}

	remove(source: string): void {
		if (this.sources.delete(source)) this.changed();
	}

	has(source: string): boolean {
		return this.sources.has(source);
	}

	clear(): void {
		if (this.sources.size === 0) return;
		this.sources.clear();
		this.changed();
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	changed(): void {
		for (const listener of this.listeners) listener();
	}

	/** The latest snapshot of the job with this key, or undefined when it is gone. */
	job(key: string): TabJob | undefined {
		return this.tabs()
			.flatMap((tab) => tab.jobs)
			.find((entry) => entry.key === key);
	}

	/** Whether any job exists, for the open key that opens the panel. */
	hasJobs(): boolean {
		for (const source of this.sources.values()) if (source.jobs.length > 0) return true;
		return false;
	}

	/** Every tab with at least one source, in order, with each source's jobs arranged as trees. */
	tabs(tabOrder: Record<string, number> = {}): Tab[] {
		const tabs = new Map<string, Tab>();
		for (const [source, snapshot] of this.sources) {
			let tab = tabs.get(snapshot.tab.id);
			if (!tab) {
				tab = {
					id: snapshot.tab.id,
					label: snapshot.tab.label,
					noun: [...snapshot.tab.noun] as [string, string],
					order: tabOrder[snapshot.tab.id] ?? snapshot.tab.order ?? 100,
					jobs: [],
				};
				tabs.set(tab.id, tab);
			} else {
				tab.order = Math.min(tab.order, tabOrder[snapshot.tab.id] ?? snapshot.tab.order ?? 100);
			}
			tab.jobs.push(
				...snapshot.jobs.map((entry) => ({
					...entry,
					source,
					key: `${source}:${entry.id}`,
					depth: 0 as const,
					last: false,
					childCount: 0,
				})),
			);
		}
		for (const tab of tabs.values()) tab.jobs = treeJobs(tab.jobs);
		return [...tabs.values()].sort(
			(left, right) => left.order - right.order || left.label.localeCompare(right.label),
		);
	}
}

/**
 * Jobs arranged as trees: top-level jobs newest first, each followed by its children sorted by
 * `order` (then `startedAt`). The filter in the panel applies to top-level jobs; children always
 * follow their parent.
 */
function treeJobs(jobs: TabJob[]): TabJob[] {
	const bySource = new Map<string, Map<string, TabJob>>();
	for (const job of jobs) {
		let ids = bySource.get(job.source);
		if (!ids) {
			ids = new Map();
			bySource.set(job.source, ids);
		}
		ids.set(job.id, job);
	}
	const childrenOf = new Map<string, TabJob[]>();
	const roots: TabJob[] = [];
	for (const job of jobs) {
		const parent =
			job.parentId !== undefined ? bySource.get(job.source)?.get(job.parentId) : undefined;
		if (parent && parent !== job) {
			const siblings = childrenOf.get(parent.key) ?? [];
			siblings.push(job);
			childrenOf.set(parent.key, siblings);
		} else {
			roots.push(job);
		}
	}
	const byOrder = (left: TabJob, right: TabJob) =>
		(left.order ?? 0) - (right.order ?? 0) || (left.startedAt ?? 0) - (right.startedAt ?? 0);
	const byNewest = (left: TabJob, right: TabJob) => (right.startedAt ?? 0) - (left.startedAt ?? 0);
	const emitted: TabJob[] = [];
	const reached = new Set<TabJob>();
	const flatten = (entry: TabJob): void => {
		for (const child of (childrenOf.get(entry.key) ?? []).sort(byOrder)) {
			emitted.push(child);
			reached.add(child);
			flatten(child);
		}
	};
	for (const root of roots.sort(byNewest)) {
		root.depth = 0;
		root.last = false;
		emitted.push(root);
		reached.add(root);
		const blockStart = emitted.length;
		flatten(root);
		for (const job of emitted.slice(blockStart)) job.depth = 1;
		if (emitted.length > blockStart) emitted[emitted.length - 1].last = true;
	}
	// Jobs whose parent chain loops never reached a root; they stay visible at the top level.
	for (const job of jobs) {
		if (reached.has(job)) continue;
		job.depth = 0;
		job.last = false;
		emitted.push(job);
	}
	for (const job of emitted) job.childCount = childrenOf.get(job.key)?.length ?? 0;
	return emitted;
}

/** `↓ 1 workflow · 3 subagents · 2 shells`, or undefined when nothing runs. */
export function backgroundJobsSummary(tabs: readonly Tab[]): string | undefined {
	const parts: string[] = [];
	for (const tab of tabs) {
		const runningParents = tab.jobs.filter(
			(job) => job.status === "running" && job.childCount > 0,
		).length;
		const runningLeaves = tab.jobs.filter(
			(job) => job.status === "running" && job.childCount === 0,
		).length;
		if (runningParents > 0)
			parts.push(`${runningParents} workflow${runningParents === 1 ? "" : "s"}`);
		if (runningLeaves > 0)
			parts.push(`${runningLeaves} ${runningLeaves === 1 ? tab.noun[0] : tab.noun[1]}`);
	}
	return parts.length > 0 ? `↓ ${parts.join(" · ")}` : undefined;
}
