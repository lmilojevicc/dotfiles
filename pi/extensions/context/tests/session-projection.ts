/**
 * Stand-in for Pi's `SessionManager.buildSessionProjection()` over a fixture entry list.
 *
 * `/context` counts what the provider receives, which is the projection and not the raw branch.
 * These fixtures have no `context_edit` and at most one compaction, so the projection is the entry
 * list with each entry's own model-visible messages; tests that need edits mock the projection
 * themselves.
 */
export function projectionOf(entries: any[]): { entries: any[]; messages: any[] } {
	const projected = entries.map((sourceEntry) => ({ sourceEntry, messages: contextMessagesOf(sourceEntry) }));
	return { entries: projected, messages: projected.flatMap((entry) => entry.messages) };
}

function contextMessagesOf(entry: any): any[] {
	if (entry.type === "message") return [entry.message];
	if (entry.type === "custom_message") {
		return [
			{
				role: "custom",
				customType: entry.customType,
				content: entry.content,
				display: entry.display ?? true,
				timestamp: entry.timestamp ?? 0,
			},
		];
	}
	if (entry.type === "branch_summary") {
		return [{ role: "branchSummary", summary: entry.summary, fromId: entry.fromId ?? null, timestamp: entry.timestamp ?? 0 }];
	}
	if (entry.type === "compaction") {
		return [{ role: "compactionSummary", summary: entry.summary, tokensBefore: entry.tokensBefore ?? 0, timestamp: entry.timestamp ?? 0 }];
	}
	// State-only entries (labels, model/thinking changes, custom data) contribute no model context.
	return [];
}
