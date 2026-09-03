import { dependentsOf, unresolvedDependencies } from "./graph.js";
import {
	isTransitionAllowed,
	MAX_ACTIVE_FORM_LENGTH,
	MAX_DESCRIPTION_LENGTH,
	MAX_OWNER_LENGTH,
	MAX_SUBJECT_LENGTH,
	validateBoundedString,
	validateMetadata,
	validateSnapshot,
} from "./invariants.js";
import {
	cloneSnapshot,
	type BatchOperation,
	type BatchTarget,
	type OperationResult,
	type ReduceResult,
	type Task,
	type TaskError,
	type TaskSnapshot,
	type TodoInput,
} from "./types.js";

const ACTION_FIELDS: Record<TodoInput["action"], Set<string>> = {
	create: new Set(["action", "expectedRevision", "subject", "description", "activeForm", "blockedBy", "owner", "metadata"]),
	update: new Set([
		"action", "expectedRevision", "id", "subject", "description", "activeForm", "status", "addBlockedBy", "removeBlockedBy", "owner", "metadata",
	]),
	batch: new Set(["action", "expectedRevision", "operations"]),
	list: new Set(["action", "status", "includeDeleted"]),
	get: new Set(["action", "id"]),
	delete: new Set(["action", "expectedRevision", "id"]),
	clear: new Set(["action", "expectedRevision"]),
};

function fail(state: TaskSnapshot, code: string, message: string, operationIndex?: number): ReduceResult {
	const error: TaskError = { code, message, ...(operationIndex === undefined ? {} : { operationIndex }) };
	return { state, committed: false, error };
}

function changedTask(a: Task, b: Task): boolean {
	return JSON.stringify(a) !== JSON.stringify(b);
}

function validateFields(input: TodoInput): string | undefined {
	const allowed = ACTION_FIELDS[input.action];
	if (!allowed) return `unknown action ${String(input.action)}`;
	for (const [key, value] of Object.entries(input)) {
		if (value !== undefined && !allowed.has(key)) return `${key} is not valid for ${input.action}`;
	}
	return undefined;
}

function uniqueNumbers(values: readonly number[], label: string): string | undefined {
	if (values.some((value) => !Number.isSafeInteger(value) || value < 1)) return `${label} must contain positive integer ids`;
	if (new Set(values).size !== values.length) return `${label} contains duplicate ids`;
	return undefined;
}

interface SingleResult {
	state: TaskSnapshot;
	changed: boolean;
	id?: number;
	error?: TaskError;
}

function validateInputStrings(input: TodoInput): TaskError | undefined {
	const fields: Array<[unknown, string, number, string]> = [
		[input.subject, "subject", MAX_SUBJECT_LENGTH, "invalid_subject"],
		[input.description, "description", MAX_DESCRIPTION_LENGTH, "invalid_description"],
		[input.activeForm, "activeForm", MAX_ACTIVE_FORM_LENGTH, "invalid_active_form"],
		[input.owner, "owner", MAX_OWNER_LENGTH, "invalid_owner"],
	];
	for (const [value, label, maximum, code] of fields) {
		if (value === undefined || value === null) continue;
		const message = validateBoundedString(value, label, maximum);
		if (message) return { code, message };
	}
	return undefined;
}

function applySingle(state: TaskSnapshot, input: TodoInput, now: number): SingleResult {
	const stringError = validateInputStrings(input);
	if (stringError) return { state, changed: false, error: stringError };
	if (input.action === "create") {
		if (typeof input.subject !== "string" || !input.subject.trim()) return { state, changed: false, error: { code: "invalid_subject", message: "subject is required" } };
		const blockedBy = input.blockedBy ?? [];
		const idsError = uniqueNumbers(blockedBy, "blockedBy");
		if (idsError) return { state, changed: false, error: { code: "invalid_dependencies", message: idsError } };
		for (const id of blockedBy) {
			const target = state.tasks.find((task) => task.id === id);
			if (!target || target.status === "deleted") {
				return { state, changed: false, error: { code: "invalid_dependency", message: `dependency #${id} does not exist or is deleted` } };
			}
		}
		const metadata = input.metadata ?? {};
		const metadataError = validateMetadata(metadata);
		if (metadataError) return { state, changed: false, error: { code: "invalid_metadata", message: metadataError } };
		const task: Task = {
			id: state.nextId,
			subject: input.subject.trim(),
			status: "pending",
			blockedBy: [...blockedBy],
			metadata: JSON.parse(JSON.stringify(metadata)) as Record<string, unknown>,
			createdAt: now,
			updatedAt: now,
		};
		if (input.description !== undefined && input.description !== null) task.description = input.description;
		if (input.activeForm !== undefined && input.activeForm !== null) task.activeForm = input.activeForm;
		if (input.owner !== undefined && input.owner !== null) task.owner = input.owner;
		const next = { ...state, nextId: state.nextId + 1, tasks: [...state.tasks, task] };
		const error = validateSnapshot(next);
		return error
			? { state, changed: false, error: { code: "invariant_violation", message: error } }
			: { state: next, changed: true, id: task.id };
	}

	if (input.action === "update") {
		if (!Number.isSafeInteger(input.id) || (input.id ?? 0) < 1) {
			return { state, changed: false, error: { code: "invalid_id", message: "id is required for update" } };
		}
		const index = state.tasks.findIndex((task) => task.id === input.id);
		if (index < 0) return { state, changed: false, error: { code: "not_found", message: `#${input.id} not found` } };
		const current = state.tasks[index]!;
		if (current.status === "deleted") return { state, changed: false, error: { code: "deleted", message: `#${current.id} is deleted` } };
		const mutable = ["subject", "description", "activeForm", "status", "owner", "metadata", "addBlockedBy", "removeBlockedBy"] as const;
		if (!mutable.some((key) => input[key] !== undefined)) {
			return { state, changed: false, error: { code: "empty_update", message: "update requires at least one mutable field" } };
		}
		if (input.subject !== undefined && !input.subject.trim()) {
			return { state, changed: false, error: { code: "invalid_subject", message: "subject must not be empty" } };
		}
		if (input.status !== undefined && !isTransitionAllowed(current.status, input.status)) {
			return { state, changed: false, error: { code: "illegal_transition", message: `illegal transition ${current.status} → ${input.status}` } };
		}
		const add = input.addBlockedBy ?? [];
		const remove = input.removeBlockedBy ?? [];
		const addError = uniqueNumbers(add, "addBlockedBy") ?? uniqueNumbers(remove, "removeBlockedBy");
		if (addError) return { state, changed: false, error: { code: "invalid_dependencies", message: addError } };
		if (add.some((id) => current.blockedBy.includes(id))) {
			return { state, changed: false, error: { code: "duplicate_dependency", message: "dependency already exists" } };
		}
		for (const id of add) {
			if (id === current.id) return { state, changed: false, error: { code: "self_dependency", message: `#${id} cannot depend on itself` } };
			const target = state.tasks.find((task) => task.id === id);
			if (!target || target.status === "deleted") {
				return { state, changed: false, error: { code: "invalid_dependency", message: `dependency #${id} does not exist or is deleted` } };
			}
		}
		const removed = new Set(remove);
		const blockedBy = current.blockedBy.filter((id) => !removed.has(id)).concat(add);
		const metadata = { ...current.metadata };
		if (input.metadata !== undefined) {
			const patchError = validateMetadata(input.metadata);
			if (patchError) return { state, changed: false, error: { code: "invalid_metadata", message: patchError } };
			for (const [key, value] of Object.entries(input.metadata)) {
				if (value === null) delete metadata[key];
				else metadata[key] = value;
			}
		}
		const metadataError = validateMetadata(metadata);
		if (metadataError) return { state, changed: false, error: { code: "invalid_metadata", message: metadataError } };
		const updated: Task = {
			...current,
			subject: input.subject === undefined ? current.subject : input.subject.trim(),
			status: input.status ?? current.status,
			blockedBy,
			metadata: JSON.parse(JSON.stringify(metadata)) as Record<string, unknown>,
		};
		if (input.description === null) delete updated.description;
		else if (input.description !== undefined) updated.description = input.description;
		if (input.activeForm === null) delete updated.activeForm;
		else if (input.activeForm !== undefined) updated.activeForm = input.activeForm;
		if (input.owner === null) delete updated.owner;
		else if (input.owner !== undefined) updated.owner = input.owner;
		if (updated.status === "deleted") updated.blockedBy = [];
		if (updated.status === "in_progress") {
			const blocked = unresolvedDependencies(updated, state.tasks);
			if (blocked.length) return { state, changed: false, error: { code: "blocked", message: `#${updated.id} is blocked by ${blocked.map((id) => `#${id}`).join(", ")}` } };
		}
		if (updated.status === "deleted") {
			const dependents = dependentsOf(updated.id, state.tasks);
			if (dependents.length) return { state, changed: false, error: { code: "has_dependents", message: `#${updated.id} is required by ${dependents.map((task) => `#${task.id}`).join(", ")}` } };
		}
		const didChange = changedTask(current, updated);
		if (!didChange) return { state, changed: false, id: current.id };
		updated.updatedAt = now;
		const tasks = [...state.tasks];
		tasks[index] = updated;
		const next = { ...state, tasks };
		const error = validateSnapshot(next);
		return error
			? { state, changed: false, error: { code: "invariant_violation", message: error } }
			: { state: next, changed: true, id: updated.id };
	}

	if (input.action === "delete") {
		if (!Number.isSafeInteger(input.id) || (input.id ?? 0) < 1) return { state, changed: false, error: { code: "invalid_id", message: "id is required for delete" } };
		const task = state.tasks.find((candidate) => candidate.id === input.id);
		if (!task) return { state, changed: false, error: { code: "not_found", message: `#${input.id} not found` } };
		if (task.status === "deleted") return { state, changed: false, id: task.id };
		return applySingle(state, { action: "update", id: task.id, status: "deleted" }, now);
	}

	if (input.action === "clear") {
		if (state.tasks.length === 0) return { state, changed: false };
		return { state: { ...state, tasks: [] }, changed: true };
	}

	return { state, changed: false };
}

function resolveTarget(target: BatchTarget, refs: Map<string, number>): number | undefined {
	return typeof target === "number" ? target : refs.get(target.ref);
}

function resolveTargets(targets: BatchTarget[] | undefined, refs: Map<string, number>): number[] | undefined {
	if (!targets) return undefined;
	const values: number[] = [];
	for (const target of targets) {
		const id = resolveTarget(target, refs);
		if (id === undefined) return undefined;
		values.push(id);
	}
	return values;
}

function applyBatch(state: TaskSnapshot, operations: BatchOperation[], now: number): ReduceResult {
	if (operations.length < 1 || operations.length > 50) return fail(state, "invalid_batch", "batch requires 1 to 50 operations");
	let draft = cloneSnapshot(state);
	const refs = new Map<string, number>();
	const results: OperationResult[] = [];
	for (let index = 0; index < operations.length; index++) {
		const operation = operations[index]!;
		let input: TodoInput;
		if (operation.op === "create") {
			if (operation.ref !== undefined && (!operation.ref.trim() || refs.has(operation.ref))) return fail(state, "invalid_ref", `ref '${operation.ref}' is empty or duplicated`, index);
			const blockedBy = resolveTargets(operation.blockedBy, refs);
			if (operation.blockedBy && !blockedBy) return fail(state, "unknown_ref", "reference must name a preceding create", index);
			input = {
				action: "create",
				subject: operation.subject,
				...(operation.description === undefined ? {} : { description: operation.description }),
				...(operation.activeForm === undefined ? {} : { activeForm: operation.activeForm }),
				...(blockedBy === undefined ? {} : { blockedBy }),
				...(operation.owner === undefined ? {} : { owner: operation.owner }),
				...(operation.metadata === undefined ? {} : { metadata: operation.metadata }),
			};
		} else {
			const id = resolveTarget(operation.target, refs);
			if (id === undefined) return fail(state, "unknown_ref", "reference must name a preceding create", index);
			if (operation.op === "delete") input = { action: "delete", id };
			else {
				const addBlockedBy = resolveTargets(operation.addBlockedBy, refs);
				const removeBlockedBy = resolveTargets(operation.removeBlockedBy, refs);
				if ((operation.addBlockedBy && !addBlockedBy) || (operation.removeBlockedBy && !removeBlockedBy)) return fail(state, "unknown_ref", "reference must name a preceding create", index);
				input = {
					action: "update", id,
					...(operation.subject === undefined ? {} : { subject: operation.subject }),
					...(operation.description === undefined ? {} : { description: operation.description }),
					...(operation.activeForm === undefined ? {} : { activeForm: operation.activeForm }),
					...(operation.status === undefined ? {} : { status: operation.status }),
					...(addBlockedBy === undefined ? {} : { addBlockedBy }),
					...(removeBlockedBy === undefined ? {} : { removeBlockedBy }),
					...(operation.owner === undefined ? {} : { owner: operation.owner }),
					...(operation.metadata === undefined ? {} : { metadata: operation.metadata }),
				};
			}
		}
		const applied = applySingle(draft, input, now);
		if (applied.error) return fail(state, applied.error.code, applied.error.message, index);
		draft = applied.state;
		const id = applied.id;
		if (id !== undefined) {
			results.push({ index, op: operation.op, id });
			if (operation.op === "create" && operation.ref) refs.set(operation.ref, id);
		}
	}
	const finalError = validateSnapshot(draft);
	if (finalError) return fail(state, "invariant_violation", finalError, operations.length - 1);
	const changed = JSON.stringify(draft) !== JSON.stringify(state);
	if (!changed) return { state, committed: false, operationResults: results };
	if (state.revision === Number.MAX_SAFE_INTEGER) {
		return fail(state, "revision_exhausted", "revision cannot exceed Number.MAX_SAFE_INTEGER");
	}
	const committed = { ...draft, revision: state.revision + 1 };
	const committedError = validateSnapshot(committed);
	if (committedError) return fail(state, "invariant_violation", committedError, operations.length - 1);
	return { state: committed, committed: true, operationResults: results };
}

export function reduceTasks(state: TaskSnapshot, input: TodoInput, now = Date.now()): ReduceResult {
	const fieldsError = validateFields(input);
	if (fieldsError) return fail(state, "invalid_fields", fieldsError);
	if (input.expectedRevision !== undefined && input.expectedRevision !== state.revision) {
		return fail(state, "stale_revision", `expected revision ${input.expectedRevision}, current revision is ${state.revision}`);
	}
	if (input.action === "batch") return applyBatch(state, input.operations ?? [], now);
	if (input.action === "get") {
		if (!Number.isSafeInteger(input.id) || (input.id ?? 0) < 1) return fail(state, "invalid_id", "id is required for get");
		if (!state.tasks.some((task) => task.id === input.id)) return fail(state, "not_found", `#${input.id} not found`);
		return { state, committed: false };
	}
	if (input.action === "list") return { state, committed: false };
	const applied = applySingle(state, input, now);
	if (applied.error) return { state, committed: false, error: applied.error };
	if (!applied.changed) return { state, committed: false, operationResults: applied.id === undefined ? undefined : [{ index: 0, op: input.action as "update" | "delete", id: applied.id }] };
	if (state.revision === Number.MAX_SAFE_INTEGER) {
		return fail(state, "revision_exhausted", "revision cannot exceed Number.MAX_SAFE_INTEGER");
	}
	const committed = { ...applied.state, revision: state.revision + 1 };
	const committedError = validateSnapshot(committed);
	if (committedError) return fail(state, "invariant_violation", committedError);
	return {
		state: committed,
		committed: true,
		...(applied.id === undefined ? {} : { operationResults: [{ index: 0, op: input.action as "create" | "update" | "delete", id: applied.id }] }),
	};
}
