import type { TaskSnapshot } from "../domain/types.js";

export interface TaskMetrics {
	startedAt: number;
	inputTokens: number;
	outputTokens: number;
}

export interface SessionActivity {
	activeTaskId?: number;
	metrics?: TaskMetrics;
}

function activeId(snapshot: TaskSnapshot): number | undefined {
	return snapshot.tasks.find((task) => task.status === "in_progress")?.id;
}

function tokenDelta(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Ephemeral parent-session activity. It never enters task snapshots. */
export class TaskActivityStore {
	private readonly sessions = new Map<string, SessionActivity>();

	reset(sessionId: string, snapshot: TaskSnapshot, now = Date.now()): SessionActivity {
		const id = activeId(snapshot);
		const activity: SessionActivity = id === undefined
			? {}
			: { activeTaskId: id, metrics: { startedAt: now, inputTokens: 0, outputTokens: 0 } };
		this.sessions.set(sessionId, activity);
		return activity;
	}

	reconcile(sessionId: string, snapshot: TaskSnapshot, now = Date.now()): SessionActivity {
		const id = activeId(snapshot);
		const current = this.sessions.get(sessionId);
		if (id === undefined) {
			const empty: SessionActivity = {};
			this.sessions.set(sessionId, empty);
			return empty;
		}
		if (current?.activeTaskId === id && current.metrics) return current;
		return this.reset(sessionId, snapshot, now);
	}

	addTurnUsage(sessionId: string, snapshot: TaskSnapshot, input: unknown, output: unknown, now = Date.now()): SessionActivity {
		const activity = this.reconcile(sessionId, snapshot, now);
		if (activity.metrics) {
			activity.metrics.inputTokens += tokenDelta(input);
			activity.metrics.outputTokens += tokenDelta(output);
		}
		return activity;
	}

	get(sessionId: string): SessionActivity | undefined {
		return this.sessions.get(sessionId);
	}

	evict(sessionId: string): void {
		this.sessions.delete(sessionId);
	}

	clear(): void {
		this.sessions.clear();
	}
}

export const taskActivity = new TaskActivityStore();
