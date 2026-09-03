import type { ReduceResult, TaskResultDetails, TodoInput } from "../domain/types.js";
import { plainTaskLine, progress } from "../ui/format.js";
import { sanitizeTerminalText } from "../ui/sanitize.js";

export function resultDetails(action: TodoInput["action"], result: ReduceResult): TaskResultDetails {
	return {
		...result.state,
		action,
		committed: result.committed,
		...(result.operationResults ? { operationResults: result.operationResults } : {}),
		...(result.error ? { error: result.error } : {}),
	};
}

export function resultText(input: TodoInput, details: TaskResultDetails): string {
	const counts = progress(details);
	if (details.error) {
		const location = details.error.operationIndex === undefined ? "" : ` at operation ${details.error.operationIndex}`;
		return `todo ${input.action} failed${location}: ${sanitizeTerminalText(details.error.message)}. Revision ${details.revision}; ${counts.done}/${counts.total} done.`;
	}
	if (input.action === "list") {
		const tasks = details.tasks.filter((task) => (input.includeDeleted || task.status !== "deleted") && (!input.status || task.status === input.status));
		return tasks.length ? `${tasks.map(plainTaskLine).join("\n")}\nRevision ${details.revision}; ${counts.done}/${counts.total} done.` : `No matching tasks. Revision ${details.revision}.`;
	}
	if (input.action === "get") {
		const task = details.tasks.find((candidate) => candidate.id === input.id)!;
		return [
			plainTaskLine(task),
			`Subject: ${sanitizeTerminalText(task.subject)}`,
			`Description: ${sanitizeTerminalText(task.description || "—")}`,
			`Active form: ${sanitizeTerminalText(task.activeForm || "—")}`,
			`Owner: ${sanitizeTerminalText(task.owner || "—")}`,
			`Metadata: ${sanitizeTerminalText(JSON.stringify(task.metadata))}`,
			`Created: ${task.createdAt}; updated: ${task.updatedAt}; revision: ${details.revision}.`,
		].join("\n");
	}
	const ids = details.operationResults?.map((operation) => `#${operation.id}`).join(", ");
	const disposition = details.committed ? "committed" : "no change";
	return `todo ${input.action} ${disposition}${ids ? ` (${ids})` : ""}. Revision ${details.revision}; ${counts.done}/${counts.total} done, ${counts.active} active, ${counts.open} open.`;
}
