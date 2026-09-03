import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TodoInput } from "../domain/types.js";
import { reduceTasks } from "../domain/reducer.js";
import { taskActivity } from "../state/activity.js";
import { commitSnapshot, foregroundSnapshot, getSnapshot, sessionId } from "../state/store.js";
import { TodoParameters } from "./schema.js";
import { resultDetails, resultText } from "./result.js";

export const TOOL_NAME = "todo";

export const PROMPT_GUIDELINES = [
	"Use todo for multi-step work and user-provided checklists; skip it for one trivial action.",
	"Create concise imperative subjects. Set activeForm to a present-continuous label when useful.",
	"Mark a task in_progress before work and completed only after verification. At most one task may be in_progress.",
	"A blocked task cannot start. Dependencies must be existing task IDs and the graph must remain acyclic.",
	"Use expectedRevision for optimistic writes. Use batch for 1–50 related operations that must commit atomically; refs may address preceding creates.",
	"Owner and metadata are inert tracking fields. This tool tracks work; it does not execute tasks or launch agents.",
];

export function registerTodoTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: TOOL_NAME,
		label: "Tasks",
		description: "Track session tasks with stable IDs, dependencies, optimistic revisions, and atomic batches. Actions: create, update, batch, list, get, delete, clear. Tracking only; does not execute tasks.",
		promptSnippet: "Track multi-step work with session-native tasks",
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: TodoParameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const input = params as TodoInput;
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
