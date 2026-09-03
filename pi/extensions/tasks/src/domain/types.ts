export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";
export type TaskAction = "create" | "update" | "batch" | "list" | "get" | "delete" | "clear";

export interface Task {
	id: number;
	subject: string;
	description?: string;
	activeForm?: string;
	status: TaskStatus;
	blockedBy: number[];
	owner?: string;
	metadata: Record<string, unknown>;
	createdAt: number;
	updatedAt: number;
}

export interface TaskSnapshot {
	kind: "pi.tasks.snapshot";
	schemaVersion: 1;
	revision: number;
	nextId: number;
	tasks: Task[];
}

export type BatchTarget = number | { ref: string };

export type BatchOperation =
	| {
			op: "create";
			ref?: string;
			subject: string;
			description?: string;
			activeForm?: string;
			blockedBy?: BatchTarget[];
			owner?: string;
			metadata?: Record<string, unknown>;
	  }
	| {
			op: "update";
			target: BatchTarget;
			subject?: string;
			description?: string | null;
			activeForm?: string | null;
			status?: TaskStatus;
			addBlockedBy?: BatchTarget[];
			removeBlockedBy?: BatchTarget[];
			owner?: string | null;
			metadata?: Record<string, unknown | null>;
	  }
	| { op: "delete"; target: BatchTarget };

export interface TodoInput {
	action: TaskAction;
	expectedRevision?: number;
	id?: number;
	subject?: string;
	description?: string | null;
	activeForm?: string | null;
	status?: TaskStatus;
	blockedBy?: number[];
	addBlockedBy?: number[];
	removeBlockedBy?: number[];
	owner?: string | null;
	metadata?: Record<string, unknown | null>;
	includeDeleted?: boolean;
	operations?: BatchOperation[];
}

export interface OperationResult {
	index: number;
	op: "create" | "update" | "delete";
	id: number;
}

export interface TaskError {
	code: string;
	message: string;
	operationIndex?: number;
}

export interface TaskResultDetails extends TaskSnapshot {
	action: TaskAction;
	committed: boolean;
	operationResults?: OperationResult[];
	error?: TaskError;
}

export interface ReduceResult {
	state: TaskSnapshot;
	committed: boolean;
	operationResults?: OperationResult[];
	error?: TaskError;
}

export const EMPTY_SNAPSHOT: TaskSnapshot = {
	kind: "pi.tasks.snapshot",
	schemaVersion: 1,
	revision: 0,
	nextId: 1,
	tasks: [],
};

export function cloneSnapshot(snapshot: TaskSnapshot): TaskSnapshot {
	return {
		kind: "pi.tasks.snapshot",
		schemaVersion: 1,
		revision: snapshot.revision,
		nextId: snapshot.nextId,
		tasks: snapshot.tasks.map((task) => ({
			...task,
			blockedBy: [...task.blockedBy],
			metadata: JSON.parse(JSON.stringify(task.metadata)) as Record<string, unknown>,
		})),
	};
}
