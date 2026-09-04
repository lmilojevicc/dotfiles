import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadTasksConfig, type TaskDisplayConfig } from "../config/tasks-config.js";
import { validateSnapshot } from "../domain/invariants.js";
import { reduceTasks } from "../domain/reducer.js";
import type { ReduceResult, Task, TaskSnapshot, TodoInput } from "../domain/types.js";
import { taskActivity } from "../state/activity.js";
import { STATE_ENTRY } from "../state/replay.js";
import { commitSnapshot, getSnapshot, sessionId } from "../state/store.js";
import { sanitizeTerminalText } from "./sanitize.js";
import { openSettingsMenu } from "./settings-menu.js";
import { resolveTaskGlyphs } from "./task-glyphs.js";

export interface HumanMutationResult { changed: boolean; error?: string }

export function applyHumanMutation(pi: ExtensionAPI, ctx: ExtensionCommandContext, input: TodoInput): HumanMutationResult {
	const id = sessionId(ctx);
	const current = getSnapshot(id);
	const result = reduceTasks(current, { ...input, expectedRevision: input.expectedRevision ?? current.revision });
	if (result.error) return { changed: false, error: result.error.message };
	if (!result.committed) return { changed: false };
	commitSnapshot(id, result.state, true);
	taskActivity.reconcile(id, result.state);
	pi.appendEntry(STATE_ENTRY, result.state);
	return { changed: true };
}

/** One unbounded atomic controller commit; refuses dangling dependencies. */
export function reduceClearCompleted(state: TaskSnapshot): ReduceResult {
	const completed = new Set(state.tasks.filter((task) => task.status === "completed").map((task) => task.id));
	if (!completed.size) return { state, committed: false };
	const dependent = state.tasks.find((task) => task.status !== "deleted" && task.status !== "completed" && task.blockedBy.some((id) => completed.has(id)));
	if (dependent) {
		const dependencies = dependent.blockedBy.filter((id) => completed.has(id)).map((id) => `#${id}`).join(", ");
		return { state, committed: false, error: { code: "has_dependents", message: `${dependencies} is required by #${dependent.id}` } };
	}
	if (state.revision === Number.MAX_SAFE_INTEGER) {
		return { state, committed: false, error: { code: "revision_exhausted", message: "revision cannot exceed Number.MAX_SAFE_INTEGER" } };
	}
	const next: TaskSnapshot = { ...state, revision: state.revision + 1, tasks: state.tasks.filter((task) => !completed.has(task.id)) };
	const error = validateSnapshot(next);
	return error
		? { state, committed: false, error: { code: "invariant_violation", message: error } }
		: { state: next, committed: true };
}

function commitControllerResult(pi: ExtensionAPI, ctx: ExtensionCommandContext, result: ReduceResult): HumanMutationResult {
	if (result.error) return { changed: false, error: result.error.message };
	if (!result.committed) return { changed: false };
	const id = sessionId(ctx);
	commitSnapshot(id, result.state, true);
	taskActivity.reconcile(id, result.state);
	pi.appendEntry(STATE_ENTRY, result.state);
	return { changed: true };
}

function taskById(ctx: ExtensionCommandContext, id: number): Task | undefined {
	return getSnapshot(sessionId(ctx)).tasks.find((task) => task.id === id && task.status !== "deleted");
}

export interface TaskManagerHooks {
	refresh(): void;
	getConfig?(): TaskDisplayConfig;
	setConfig?(config: TaskDisplayConfig): void;
}

function hooksFrom(value: TaskManagerHooks | (() => void)): TaskManagerHooks {
	return typeof value === "function" ? { refresh: value } : value;
}

export async function openTaskManager(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	hookValue: TaskManagerHooks | (() => void) = () => {},
): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/tasks requires TUI mode; task tracking remains available through the todo tool.", "error");
		return;
	}
	const hooks = hooksFrom(hookValue);
	let config = hooks.getConfig?.() ?? loadTasksConfig(ctx.cwd ?? process.cwd());
	const mutate = (input: TodoInput) => {
		const result = applyHumanMutation(pi, ctx, input);
		if (result.error) ctx.ui.notify(result.error, "error");
		if (result.changed) hooks.refresh();
		return result;
	};

	const createTask = async (): Promise<void> => {
		const subject = await ctx.ui.input("Task subject");
		if (!subject) return;
		const description = await ctx.ui.input("Task description");
		if (!description) return;
		mutate({ action: "create", subject, description });
	};

	const detail = async (id: number): Promise<void> => {
		const task = taskById(ctx, id);
		if (!task) {
			ctx.ui.notify(`Task #${id} no longer exists.`, "warning");
			return;
		}
		const actions = task.status === "pending"
			? ["▸ Start (in_progress)", "✗ Delete", "← Back"]
			: task.status === "in_progress"
				? ["✓ Complete", "✗ Delete", "← Back"]
				: ["✗ Delete", "← Back"];
		const title = `#${task.id} [${task.status}] ${sanitizeTerminalText(task.subject)}\n${sanitizeTerminalText(task.description ?? "")}`;
		const action = await ctx.ui.select(title, actions);
		if (action === "▸ Start (in_progress)") mutate({ action: "update", id, status: "in_progress" });
		else if (action === "✓ Complete") mutate({ action: "update", id, status: "completed" });
		else if (action === "✗ Delete") {
			if (await ctx.ui.confirm("Delete task", `Delete #${id} ${sanitizeTerminalText(task.subject)}?`)) mutate({ action: "delete", id });
		}
	};

	const viewTasks = async (): Promise<void> => {
		while (true) {
			const tasks = getSnapshot(sessionId(ctx)).tasks.filter((task) => task.status !== "deleted").sort((a, b) => a.id - b.id);
			if (!tasks.length) {
				await ctx.ui.select("No tasks", ["← Back"]);
				return;
			}
			const glyphs = resolveTaskGlyphs(config.glyphs);
			const records = tasks.map((task) => ({
				id: task.id,
				label: `${task.status === "completed" ? glyphs.completed : task.status === "in_progress" ? glyphs.inProgress : glyphs.pending} #${task.id} [${task.status}] ${sanitizeTerminalText(task.subject)}`,
			}));
			const back = "← Back";
			const selected = await ctx.ui.select("Tasks", [...records.map((record) => record.label), back]);
			if (!selected || selected === back) return;
			const record = records.find((candidate) => candidate.label === selected);
			if (record) await detail(record.id);
		}
	};

	while (true) {
		const tasks = getSnapshot(sessionId(ctx)).tasks.filter((task) => task.status !== "deleted");
		const completed = tasks.filter((task) => task.status === "completed").length;
		const choices = [`View all tasks (${tasks.length})`, "Create task"];
		if (completed) choices.push(`Clear completed (${completed})`);
		if (tasks.length) choices.push(`Clear all (${tasks.length})`);
		choices.push("Settings");
		const choice = await ctx.ui.select("Tasks", choices);
		if (!choice) return;
		if (choice === choices[0]) await viewTasks();
		else if (choice === "Create task") await createTask();
		else if (choice.startsWith("Clear completed")) {
			const result = commitControllerResult(pi, ctx, reduceClearCompleted(getSnapshot(sessionId(ctx))));
			if (result.error) ctx.ui.notify(result.error, "error");
			if (result.changed) hooks.refresh();
		} else if (choice.startsWith("Clear all")) {
			if (await ctx.ui.confirm("Clear all tasks", `Delete all ${tasks.length} tasks?`)) mutate({ action: "clear" });
		} else if (choice === "Settings") {
			await openSettingsMenu(ctx.ui, config, ctx.cwd ?? process.cwd(), (updated) => {
				config = updated;
				if (hooks.setConfig) hooks.setConfig(updated);
				else hooks.refresh();
			});
		}
	}
}
