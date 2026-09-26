import test from "node:test";
import assert from "node:assert/strict";
import tasksExtension from "../index.ts";
import { registerTodoTool } from "../src/tool/register.ts";

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

test("todo definition maps actions to arguments and keeps tracking-only safety in context", () => {
	let tool: any;
	registerTodoTool({ registerTool(value: any) { tool = value; } } as any);
	for (const mapping of [
		"create requires subject",
		"update requires id and fields to change",
		"get/delete require id",
		"batch requires operations",
		"list optionally filters status (includeDeleted to show deleted)",
		"clear removes all tasks",
	]) assert.ok(tool.description.includes(mapping), mapping);
	assert.match(tool.description, /not execution or agent launches/);
	assert.match(tool.description, /owner\/metadata are inert/);
	assert.equal(tool.promptSnippet, "Track session tasks");
	assert.match(tool.parameters.properties.expectedRevision.description, /Mutations only; must match current revision/);

	const guidance = tool.promptGuidelines.join("\n");
	for (const rule of [
		"multi-step work or user checklists, not trivial actions",
		"concise imperative subjects",
		"optional activeForm is present-continuous",
		"in_progress before work, completed only after verification",
		"At most one in_progress task, with all dependencies completed",
		"existing IDs without cycles",
		"blockedBy on create, addBlockedBy/removeBlockedBy on update",
		"Updates preserve omitted fields; null clears description/activeForm/owner",
		"metadata merges; null values delete keys",
		"atomic but validates each operation in order",
		"refs name preceding creates",
		"todo create has no status field; status changes require update",
		"use the returned task ID",
	]) assert.ok(guidance.includes(rule), rule);

	const definition = JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters });
	const renderedGuidance = [`- ${tool.name}: ${tool.promptSnippet}`, ...tool.promptGuidelines.map((rule: string) => `- ${rule}`)].join("\n");
	// Full-surface budget including batch grammar and examples (original baseline: 4485 bytes).
	assert.ok(Buffer.byteLength(`${definition}\n${renderedGuidance}`) < 3300);
});
