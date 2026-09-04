import test from "node:test";
import assert from "node:assert/strict";
import tasksExtension from "../index.ts";

test("registers exactly one todo tool, management commands, inspection-first board, and collapse shortcut", () => {
	const tools: any[] = [];
	const commands: Array<{ name: string; options: any }> = [];
	const shortcuts: string[] = [];
	const events: string[] = [];
	const pi = {
		registerTool(tool: any) { tools.push(tool); },
		registerCommand(name: string, options: any) { commands.push({ name, options }); },
		registerShortcut(name: string) { shortcuts.push(name); },
		on(name: string) { events.push(name); },
	} as any;
	tasksExtension(pi);
	assert.equal(tools.length, 1);
	assert.equal(tools[0].name, "todo");
	assert.deepEqual(commands.map(({ name }) => name), ["tasks", "todos", "tasks-board"]);
	assert.equal(commands[2]?.options.description, "Inspect tasks and confirm deletions in a live board");
	assert.deepEqual(shortcuts, ["ctrl+shift+t"]);
	assert.deepEqual(events, ["session_start", "session_tree", "session_compact", "session_shutdown", "before_agent_start", "tool_execution_end", "turn_end"]);
	assert.equal("renderCall" in tools[0], false);
	assert.equal("renderResult" in tools[0], false);
});
