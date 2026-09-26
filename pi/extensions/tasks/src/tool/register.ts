import { validateToolArguments } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TodoInput } from "../domain/types.js";
import { reduceTasks } from "../domain/reducer.js";
import { taskActivity } from "../state/activity.js";
import { commitSnapshot, foregroundSnapshot, getSnapshot, sessionId } from "../state/store.js";
import { TodoParameters, TodoRuntimeParameters } from "./schema.js";
import { resultDetails, resultText } from "./result.js";

export const TOOL_NAME = "todo";

export const PROMPT_GUIDELINES = [
	"Use todo for multi-step work or user checklists, not trivial actions. Use concise imperative subjects; optional activeForm is present-continuous.",
	"Set in_progress before work, completed only after verification. At most one in_progress task, with all dependencies completed.",
	"Dependencies use existing IDs without cycles: blockedBy on create, addBlockedBy/removeBlockedBy on update.",
	"Updates preserve omitted fields; null clears description/activeForm/owner. metadata merges; null values delete keys.",
	"Batch is atomic but validates each operation in order; refs name preceding creates.",
	'todo create has no status field; status changes require update. Create example: `{"action":"create","subject":"Fix bug"}`.',
	'todo update example (use the returned task ID; if create returned #1): `{"action":"update","id":1,"status":"in_progress"}`.',
	'todo batch alternative to those two calls, create and start atomically: `{"action":"batch","operations":[{"op":"create","ref":"fix","subject":"Fix bug"},{"op":"update","target":{"ref":"fix"},"status":"in_progress"}]}`.',
];

export function registerTodoTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: TOOL_NAME,
		label: "Tasks",
		description: "Track session tasks, not execution or agent launches. create requires subject; update requires id and fields to change; get/delete require id; batch requires operations; list optionally filters status (includeDeleted to show deleted); clear removes all tasks. owner/metadata are inert.",
		promptSnippet: "Track session tasks",
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: TodoParameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const input = validateToolArguments(
				{ name: TOOL_NAME, description: "", parameters: TodoRuntimeParameters },
				{ type: "toolCall", id: _toolCallId, name: TOOL_NAME, arguments: params },
			) as TodoInput;
			const id = sessionId(ctx);
			const result = reduceTasks(getSnapshot(id), input);
			if (result.committed) {
				commitSnapshot(id, result.state);
				taskActivity.reconcile(id, result.state);
			}
			const details = resultDetails(input.action, result);
			return {
				content: [{ type: "text" as const, text: resultText(input, details) }],
				details,
				isError: Boolean(result.error),
			};
		},
	});
}

export { foregroundSnapshot };
