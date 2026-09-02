export function getAgentDir() {
	return process.env.PI_CODING_AGENT_DIR ?? process.cwd();
}

export function sessionEntryToContextMessages(entry) {
	if (entry.type === "message") return [entry.message];
	if (entry.type === "custom_message") {
		return [{
			role: "custom",
			customType: entry.customType,
			content: entry.content ?? [],
			display: entry.display,
			details: entry.details,
			timestamp: Date.parse(entry.timestamp),
		}];
	}
	if (entry.type === "branch_summary" && entry.summary) {
		return [{ role: "branchSummary", summary: entry.summary, fromId: entry.fromId, timestamp: Date.parse(entry.timestamp) }];
	}
	if (entry.type === "compaction") {
		return [{ role: "compactionSummary", summary: entry.summary, tokensBefore: entry.tokensBefore, timestamp: Date.parse(entry.timestamp) }];
	}
	return [];
}

export function convertToLlm(messages) {
	return messages.flatMap((message) => {
		if (message.role === "bashExecution") {
			if (message.excludeFromContext) return [];
			const output = message.output ? `\n\`\`\`\n${message.output}\n\`\`\`` : "\n(no output)";
			return [{ role: "user", content: [{ type: "text", text: `Ran \`${message.command}\`${output}` }], timestamp: message.timestamp }];
		}
		if (message.role === "custom") {
			return [{ role: "user", content: typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content, timestamp: message.timestamp }];
		}
		if (message.role === "branchSummary") {
			return [{ role: "user", content: [{ type: "text", text: `The following is a summary of a branch that this conversation came back from:\n\n<summary>\n${message.summary}</summary>` }], timestamp: message.timestamp }];
		}
		if (message.role === "compactionSummary") {
			return [{ role: "user", content: [{ type: "text", text: `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${message.summary}\n</summary>` }], timestamp: message.timestamp }];
		}
		return [message];
	});
}
