import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerLifecycle } from "./src/lifecycle.js";
import { registerTodoTool } from "./src/tool/register.js";
import { openTaskManager } from "./src/ui/controller.js";
import { disposeTasksBoard, openTasksBoard } from "./src/ui/tasks-board.js";
import { TaskWidget } from "./src/ui/widget.js";

export default function tasksExtension(pi: ExtensionAPI): void {
	const widget = new TaskWidget();
	registerTodoTool(pi);
	const handler = async (_args: string, ctx: Parameters<typeof openTaskManager>[1]) => openTaskManager(pi, ctx, {
		refresh: () => widget.refresh(),
		getConfig: () => widget.getConfig(),
		setConfig: (config) => widget.setConfig(config),
	});
	pi.registerCommand("tasks", { description: "Manage tasks — view, create, clear completed", handler });
	pi.registerCommand("todos", { description: "Manage tasks — view, create, clear completed (alias for /tasks)", handler });
	pi.registerCommand("tasks-board", {
		description: "Inspect tasks in a live read-only board",
		handler: async (_args, ctx) => openTasksBoard(ctx, () => widget.getConfig()),
	});
	pi.registerShortcut("ctrl+shift+t", {
		description: "Toggle the Tasks widget between compact and expanded",
		handler: () => widget.toggle(),
	});
	registerLifecycle(pi, {
		bind: (ui) => widget.bind(ui),
		setConfig: (config) => widget.setConfig(config),
		refresh: (reset) => widget.refresh(reset),
		redraw: () => widget.redraw(),
		dispose: () => {
			disposeTasksBoard();
			widget.dispose();
		},
	});
}
