/** Sorting behavior adapted from @tintinweb/pi-tasks 0.9.0. */
import type { Task, TaskStatus } from "../domain/types.js";

export type SortField = "id" | "status" | "updatedAt";
export type SortDirection = "asc" | "desc";
export interface SortKey { field: SortField; direction?: SortDirection; rank?: TaskStatus[] }
export type SortSpec = SortKey[];
export type BuiltInSortOrder = "id" | "status" | "active" | "recent" | "oldest";
export type TaskSortOrder = BuiltInSortOrder | SortSpec;

const FIELDS: SortField[] = ["id", "status", "updatedAt"];
const STATUSES: TaskStatus[] = ["pending", "in_progress", "completed"];
const DEFAULT_STATUS_RANK: TaskStatus[] = ["completed", "in_progress", "pending"];
const PRESETS: Record<BuiltInSortOrder, SortSpec> = {
	id: [{ field: "id" }],
	status: [{ field: "status", rank: DEFAULT_STATUS_RANK }, { field: "id" }],
	active: [{ field: "status", rank: ["in_progress", "pending", "completed"] }, { field: "id" }],
	recent: [{ field: "updatedAt", direction: "desc" }, { field: "id", direction: "desc" }],
	oldest: [{ field: "updatedAt" }, { field: "id" }],
};
export const BUILT_IN_SORT_ORDERS = Object.keys(PRESETS) as BuiltInSortOrder[];

function isSortKey(value: unknown): value is SortKey {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const { field, direction, rank } = value as Record<string, unknown>;
	if (!FIELDS.includes(field as SortField)) return false;
	if (direction !== undefined && direction !== "asc" && direction !== "desc") return false;
	if (rank !== undefined && (!Array.isArray(rank) || !rank.every((status) => STATUSES.includes(status as TaskStatus)))) return false;
	return true;
}

export function isTaskSortOrder(value: unknown): value is TaskSortOrder {
	return typeof value === "string"
		? Object.hasOwn(PRESETS, value)
		: Array.isArray(value) && value.length > 0 && value.every(isSortKey);
}

function specFor(order: unknown): SortSpec {
	if (typeof order === "string" && Object.hasOwn(PRESETS, order)) return PRESETS[order as BuiltInSortOrder];
	if (Array.isArray(order) && order.length > 0 && order.every(isSortKey)) return order;
	return PRESETS.id;
}

function compare(a: Task, b: Task, key: SortKey): number {
	if (key.field === "status") {
		const rank = key.rank ?? DEFAULT_STATUS_RANK;
		const ai = rank.indexOf(a.status);
		const bi = rank.indexOf(b.status);
		return (ai < 0 ? rank.length : ai) - (bi < 0 ? rank.length : bi);
	}
	return key.field === "id" ? a.id - b.id : a.updatedAt - b.updatedAt;
}

export function sortTasks(tasks: readonly Task[], order: TaskSortOrder = "id"): Task[] {
	const spec = specFor(order);
	return [...tasks].sort((a, b) => {
		for (const key of spec) {
			const delta = compare(a, b, key);
			if (delta) return key.direction === "desc" ? -delta : delta;
		}
		return 0;
	});
}
