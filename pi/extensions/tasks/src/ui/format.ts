import type { Task, TaskSnapshot } from "../domain/types.js";
import { sanitizeTerminalText } from "./sanitize.js";

export function progress(snapshot: TaskSnapshot): { total: number; done: number; active: number; open: number } {
	const visible = snapshot.tasks.filter((task) => task.status !== "deleted");
	const done = visible.filter((task) => task.status === "completed").length;
	const active = visible.filter((task) => task.status === "in_progress").length;
	return { total: visible.length, done, active, open: visible.length - done - active };
}

export function taskLabel(task: Task): string {
	return sanitizeTerminalText(task.status === "in_progress" && task.activeForm ? task.activeForm : task.subject);
}

export function plainTaskLine(task: Task): string {
	const glyph = task.status === "deleted" ? "[deleted]" : task.status === "completed" ? "[done]" : task.status === "in_progress" ? "[active]" : "[open]";
	const blocked = task.blockedBy.length ? `; blocked by ${task.blockedBy.map((id) => `#${id}`).join(", ")}` : "";
	return `${glyph} #${task.id} ${taskLabel(task)}${blocked}`;
}
