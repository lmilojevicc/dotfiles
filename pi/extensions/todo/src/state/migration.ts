import { findCycle, unresolvedDependencies } from "../domain/graph.js";
import { validateSnapshot } from "../domain/invariants.js";
import { type Task, type TaskSnapshot } from "../domain/types.js";

export interface MigrationResult {
	snapshot: TaskSnapshot;
	warning?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Decode the installed rpiv-todo `{tasks,nextId}` result details into schema v1. */
export function migrateLegacySnapshot(value: unknown): MigrationResult | undefined {
	const source = record(value);
	if (!source || !Array.isArray(source.tasks) || !Number.isSafeInteger(source.nextId)) return undefined;
	const rawTasks = source.tasks.map(record);
	if (rawTasks.some((task) => !task)) return undefined;
	const tasks: Task[] = [];
	for (const raw of rawTasks as Record<string, unknown>[]) {
		if (!Number.isSafeInteger(raw.id) || typeof raw.subject !== "string") return undefined;
		if (!["pending", "in_progress", "completed", "deleted"].includes(String(raw.status))) return undefined;
		const blockedBy = raw.blockedBy === undefined ? [] : raw.blockedBy;
		if (!Array.isArray(blockedBy) || blockedBy.some((id) => !Number.isSafeInteger(id))) return undefined;
		const metadata = raw.metadata === undefined ? {} : record(raw.metadata);
		if (!metadata) return undefined;
		const task: Task = {
			id: raw.id as number,
			subject: raw.subject,
			status: raw.status as Task["status"],
			blockedBy: [...(blockedBy as number[])],
			metadata,
			createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0,
			updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
		};
		if (typeof raw.description === "string") task.description = raw.description;
		if (typeof raw.activeForm === "string") task.activeForm = raw.activeForm;
		if (typeof raw.owner === "string") task.owner = raw.owner;
		tasks.push(task);
	}

	const liveIds = new Set(tasks.filter((task) => task.status !== "deleted").map((task) => task.id));
	const rawEdges = tasks.map((task) => task.blockedBy);
	for (const task of tasks) task.blockedBy = [];
	let repairedDependencies = 0;
	for (let index = 0; index < tasks.length; index++) {
		const task = tasks[index]!;
		for (const dependency of task.status === "deleted" ? [] : rawEdges[index]!) {
			if (dependency === task.id || !liveIds.has(dependency) || task.blockedBy.includes(dependency)) {
				repairedDependencies++;
				continue;
			}
			task.blockedBy.push(dependency);
			if (findCycle(tasks)) {
				task.blockedBy.pop();
				repairedDependencies++;
			}
		}
	}

	let keptActive = false;
	let demoted = 0;
	for (const task of tasks) {
		if (task.status !== "in_progress") continue;
		if (keptActive || unresolvedDependencies(task, tasks).length > 0) {
			task.status = "pending";
			demoted++;
		} else {
			keptActive = true;
		}
	}

	const maxId = tasks.reduce((maximum, task) => Math.max(maximum, task.id), 0);
	const snapshot: TaskSnapshot = {
		kind: "pi.tasks.snapshot",
		schemaVersion: 1,
		revision: 0,
		nextId: Math.max(source.nextId as number, maxId + 1),
		tasks,
	};
	if (validateSnapshot(snapshot)) return undefined;
	const repairs = [
		demoted ? `kept the first eligible active task and paused ${demoted} extra active task${demoted === 1 ? "" : "s"}, including blocked tasks` : "",
		repairedDependencies ? `removed ${repairedDependencies} invalid dependency edge${repairedDependencies === 1 ? "" : "s"}` : "",
	].filter(Boolean);
	return { snapshot, ...(repairs.length ? { warning: `Migrated legacy tasks: ${repairs.join("; ")}.` } : {}) };
}
