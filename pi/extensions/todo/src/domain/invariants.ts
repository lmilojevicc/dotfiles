import { findCycle } from "./graph.js";
import type { TaskSnapshot, TaskStatus } from "./types.js";

export const MAX_SUBJECT_LENGTH = 500;
export const MAX_DESCRIPTION_LENGTH = 20_000;
export const MAX_ACTIVE_FORM_LENGTH = 500;
export const MAX_OWNER_LENGTH = 200;
export const MAX_METADATA_BYTES = 65_536;
export const MAX_METADATA_DEPTH = 8;
export const MAX_METADATA_KEYS = 50;

export function isTransitionAllowed(from: TaskStatus, to: TaskStatus): boolean {
	if (from === to) return true;
	if (from === "pending") return to === "in_progress" || to === "completed" || to === "deleted";
	if (from === "in_progress") return to === "pending" || to === "completed" || to === "deleted";
	if (from === "completed") return to === "deleted";
	return false;
}

function characterLength(value: string): number {
	return Array.from(value).length;
}

export function validateBoundedString(value: unknown, label: string, maximum: number): string | undefined {
	if (typeof value !== "string") return `${label} must be a string`;
	if (characterLength(value) > maximum) return `${label} must be at most ${maximum} characters`;
	return undefined;
}

function inspectJson(value: unknown, depth: number, seen: Set<object>, keyCount: { value: number }): string | undefined {
	if (depth > MAX_METADATA_DEPTH) return `metadata exceeds maximum depth ${MAX_METADATA_DEPTH}`;
	if (value === null || typeof value === "string" || typeof value === "boolean") return undefined;
	if (typeof value === "number") return Number.isFinite(value) ? undefined : "metadata numbers must be finite";
	if (typeof value !== "object") return "metadata must contain JSON values only";
	if (seen.has(value)) return "metadata must not contain cycles";
	seen.add(value);
	if (Array.isArray(value)) {
		for (const item of value) {
			const error = inspectJson(item, depth + 1, seen, keyCount);
			if (error) return error;
		}
	} else {
		const proto = Object.getPrototypeOf(value);
		if (proto !== Object.prototype && proto !== null) return "metadata must contain plain JSON objects only";
		const entries = Object.entries(value as Record<string, unknown>);
		keyCount.value += entries.length;
		if (keyCount.value > MAX_METADATA_KEYS) return `metadata may have at most ${MAX_METADATA_KEYS} keys`;
		for (const [, item] of entries) {
			const error = inspectJson(item, depth + 1, seen, keyCount);
			if (error) return error;
		}
	}
	seen.delete(value);
	return undefined;
}

export function validateMetadata(value: unknown): string | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return "metadata must be a JSON object";
	const error = inspectJson(value, 0, new Set(), { value: 0 });
	if (error) return error;
	let encoded: string;
	try {
		encoded = JSON.stringify(value);
	} catch {
		return "metadata must be JSON-serializable";
	}
	if (Buffer.byteLength(encoded, "utf8") > MAX_METADATA_BYTES) {
		return `metadata exceeds ${MAX_METADATA_BYTES} bytes`;
	}
	return undefined;
}

export function validateSnapshot(snapshot: TaskSnapshot): string | undefined {
	if (snapshot.kind !== "pi.tasks.snapshot" || snapshot.schemaVersion !== 1) return "invalid snapshot discriminator";
	if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) return "invalid revision";
	if (!Number.isSafeInteger(snapshot.nextId) || snapshot.nextId < 1) return "invalid nextId";
	if (!Array.isArray(snapshot.tasks)) return "tasks must be an array";
	const ids = new Set<number>();
	let active = 0;
	let maxId = 0;
	for (const task of snapshot.tasks) {
		if (!task || typeof task !== "object") return "tasks must contain task objects";
		if (!Number.isSafeInteger(task.id) || task.id < 1 || ids.has(task.id)) return "task ids must be unique positive integers";
		ids.add(task.id);
		maxId = Math.max(maxId, task.id);
		const subjectError = validateBoundedString(task.subject, "subject", MAX_SUBJECT_LENGTH);
		if (subjectError) return `#${task.id} ${subjectError}`;
		if (!task.subject.trim()) return `#${task.id} subject must not be empty`;
		if (task.description !== undefined) {
			const error = validateBoundedString(task.description, "description", MAX_DESCRIPTION_LENGTH);
			if (error) return `#${task.id} ${error}`;
		}
		if (task.activeForm !== undefined) {
			const error = validateBoundedString(task.activeForm, "activeForm", MAX_ACTIVE_FORM_LENGTH);
			if (error) return `#${task.id} ${error}`;
		}
		if (task.owner !== undefined) {
			const error = validateBoundedString(task.owner, "owner", MAX_OWNER_LENGTH);
			if (error) return `#${task.id} ${error}`;
		}
		if (!["pending", "in_progress", "completed", "deleted"].includes(task.status)) return `#${task.id} has invalid status`;
		if (task.status === "in_progress" && ++active > 1) return "at most one task may be in_progress";
		if (!Number.isFinite(task.createdAt) || !Number.isFinite(task.updatedAt)) return `#${task.id} has invalid timestamps`;
		if (!Array.isArray(task.blockedBy) || task.blockedBy.some((id) => !Number.isSafeInteger(id) || id < 1)) {
			return `#${task.id} dependencies must be positive integer ids`;
		}
		if (new Set(task.blockedBy).size !== task.blockedBy.length) return `#${task.id} has duplicate dependencies`;
		if (task.blockedBy.includes(task.id)) return `#${task.id} cannot depend on itself`;
		const metadataError = validateMetadata(task.metadata);
		if (metadataError) return `#${task.id}: ${metadataError}`;
	}
	if (snapshot.nextId <= maxId) return "nextId must exceed every allocated id";
	const byId = new Map(snapshot.tasks.map((task) => [task.id, task]));
	for (const task of snapshot.tasks) {
		for (const dependency of task.blockedBy) {
			const target = byId.get(dependency);
			if (!target) return `#${task.id} dependency #${dependency} does not exist`;
			if (target.status === "deleted") return `#${task.id} dependency #${dependency} is deleted`;
			if (task.status === "in_progress" && target.status !== "completed") {
				return `#${task.id} is in_progress but dependency #${dependency} is not completed`;
			}
		}
	}
	const cycle = findCycle(snapshot.tasks);
	if (cycle) return `dependency cycle: ${cycle.map((id) => `#${id}`).join(" → ")}`;
	return undefined;
}
