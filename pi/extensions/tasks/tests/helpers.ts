import type { Task, TaskSnapshot } from "../src/domain/types.js";

export function snapshot(tasks: Task[] = [], revision = 0, nextId?: number): TaskSnapshot {
	return {
		kind: "pi.tasks.snapshot",
		schemaVersion: 1,
		revision,
		nextId: nextId ?? tasks.reduce((max, task) => Math.max(max, task.id + 1), 1),
		tasks,
	};
}

export function task(id: number, status: Task["status"] = "pending", blockedBy: number[] = [], subject = `Task ${id}`): Task {
	return { id, subject, status, blockedBy, metadata: {}, createdAt: id, updatedAt: id };
}

export const plainTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
	inverse: (text: string) => `>${text}<`,
	strikethrough: (text: string) => `~${text}~`,
} as any;
