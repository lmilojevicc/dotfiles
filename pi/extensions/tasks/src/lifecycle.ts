import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadGlobalTasksConfig, type TaskDisplayConfig } from "./config/tasks-config.js";
import { progress } from "./ui/format.js";
import { taskActivity } from "./state/activity.js";
import { replayBranch, SYNC_MESSAGE } from "./state/replay.js";
import {
	clearForeground,
	evictSlot,
	getForeground,
	getSlot,
	getSnapshot,
	markAnnounced,
	restoreSlot,
	sessionId,
	setForeground,
	takeMigrationWarning,
} from "./state/store.js";

export function isStaleContextError(error: unknown): boolean {
	return /stale after session replacement/.test(String(error));
}

export function restoreContext(ctx: ExtensionContext): string {
	const id = sessionId(ctx);
	restoreSlot(id, replayBranch(ctx.sessionManager.getBranch()));
	return id;
}

export function synchronizationMessage(id: string) {
	const slot = getSlot(id);
	const revision = slot.pendingHumanRevision;
	if (revision === undefined || revision <= slot.announcedRevision) return undefined;
	const visible = slot.snapshot.tasks.filter((task) => task.status !== "deleted" && task.status !== "completed");
	const active = visible.find((task) => task.status === "in_progress");
	const open = visible.filter((task) => task.status === "pending").slice(0, 8);
	const summary = [
		`The user edited Tasks in the interactive manager (revision ${revision}).`,
		active ? `Active: #${active.id} ${active.activeForm || active.subject}.` : "No task is active.",
		open.length ? `Open: ${open.map((task) => `#${task.id} ${task.subject}`).join("; ")}.` : "No open tasks.",
		"Use the todo tool for subsequent task changes; do not recreate deleted tasks.",
	].join(" ");
	markAnnounced(id, revision);
	return { customType: SYNC_MESSAGE, content: summary, display: false, details: { revision } };
}

export interface LifecycleUI {
	bind?(ui: ExtensionContext["ui"]): void;
	setConfig?(config: TaskDisplayConfig): void;
	refresh(reset?: boolean): void;
	redraw?(): void;
	dispose(): void;
}

export function registerLifecycle(pi: ExtensionAPI, ui: LifecycleUI): void {
	const replay = async (ctx: ExtensionContext, preserveActivity: boolean) => {
		try {
			const id = restoreContext(ctx);
			if (preserveActivity) taskActivity.reconcile(id, getSnapshot(id));
			else taskActivity.reset(id, getSnapshot(id));
			if (id === getForeground()) ui.refresh(!preserveActivity);
		} catch (error) {
			if (!isStaleContextError(error)) throw error;
		}
	};
	pi.on("session_start", async (_event, ctx) => {
		let id: string;
		try {
			id = restoreContext(ctx);
		} catch (error) {
			if (isStaleContextError(error)) return;
			throw error;
		}
		taskActivity.reset(id, getSnapshot(id));
		if (ctx.mode === "tui") setForeground(id);
		if (id !== getForeground()) return;
		ui.bind?.(ctx.ui);
		ui.setConfig?.(loadGlobalTasksConfig());
		ui.refresh(true);
		const warning = takeMigrationWarning(id);
		if (warning) ctx.ui.notify(warning, "warning");
	});
	pi.on("session_tree", async (_event, ctx) => replay(ctx, false));
	pi.on("session_compact", async (_event, ctx) => replay(ctx, true));
	pi.on("session_shutdown", async (_event, ctx) => {
		let id = getForeground();
		try {
			id = sessionId(ctx);
		} catch (error) {
			if (!isStaleContextError(error)) throw error;
		}
		if (id) {
			evictSlot(id);
			taskActivity.evict(id);
		}
		if (id && id === getForeground()) {
			try {
				ui.dispose();
			} catch (error) {
				if (!isStaleContextError(error)) throw error;
			} finally {
				clearForeground();
			}
		}
	});
	pi.on("before_agent_start", async (_event, ctx) => {
		const message = synchronizationMessage(sessionId(ctx));
		return message ? { message } : undefined;
	});
	pi.on("tool_execution_end", async (event, ctx) => {
		if (event.toolName !== "todo" || event.isError) return;
		const id = sessionId(ctx);
		taskActivity.reconcile(id, getSnapshot(id));
		if (id === getForeground()) ui.refresh();
	});
	pi.on("turn_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const id = sessionId(ctx);
		const usage = "usage" in event.message ? event.message.usage : undefined;
		taskActivity.addTurnUsage(id, getSnapshot(id), usage?.input, usage?.output);
		if (id === getForeground()) {
			if (ui.redraw) ui.redraw();
			else ui.refresh();
		}
	});
}

export function syncSummary(ctx: ExtensionContext): string {
	const snapshot = getSlot(sessionId(ctx)).snapshot;
	const counts = progress(snapshot);
	return `${counts.done}/${counts.total} done at revision ${snapshot.revision}`;
}
