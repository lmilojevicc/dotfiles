import type { Task } from "./types.js";

export function findCycle(tasks: readonly Task[]): number[] | undefined {
	const live = new Map(tasks.filter((task) => task.status !== "deleted").map((task) => [task.id, task]));
	const visiting = new Set<number>();
	const visited = new Set<number>();
	const path: number[] = [];
	const visit = (id: number): number[] | undefined => {
		if (visiting.has(id)) {
			const start = path.indexOf(id);
			return [...path.slice(start), id];
		}
		if (visited.has(id)) return undefined;
		visiting.add(id);
		path.push(id);
		for (const dependency of live.get(id)?.blockedBy ?? []) {
			const cycle = visit(dependency);
			if (cycle) return cycle;
		}
		path.pop();
		visiting.delete(id);
		visited.add(id);
		return undefined;
	};
	for (const id of live.keys()) {
		const cycle = visit(id);
		if (cycle) return cycle;
	}
	return undefined;
}

export function unresolvedDependencies(task: Task, tasks: readonly Task[]): number[] {
	const byId = new Map(tasks.map((candidate) => [candidate.id, candidate]));
	return task.blockedBy.filter((id) => byId.get(id)?.status !== "completed");
}

export function dependentsOf(id: number, tasks: readonly Task[]): Task[] {
	return tasks.filter((task) => task.status !== "deleted" && task.blockedBy.includes(id));
}
