import { readFileSync } from "node:fs";
import { estimateTokens, formatSkillsForPrompt, type BuildSystemPromptOptions, type ExtensionCommandContext, type ToolInfo } from "@earendil-works/pi-coding-agent";

export type Detail = { label: string; tokens: number; source: string; content: string; children?: Detail[] };
export type Category = { label: string; tokens: number; color: "accent" | "success" | "warning" | "customMessageLabel" | "muted" | "dim" | "error"; items: Detail[] };
export const tokenEstimate = (value: unknown): number => {
	if (value === null || value === undefined || value === "") return 0;
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return Math.ceil(text.length / 4);
};

/** Claim only nonoverlapping exact spans in the assembled prompt. A forced/modified prompt may have none. */
export function promptAttribution(prompt: string, candidates: Array<{ category: "Memory" | "Skills"; label: string; text: string; source: string; children?: Detail[] }>): { items: Record<"Memory" | "Skills" | "System prompt", Detail[]> } {
	const occupied: Array<{ start: number; end: number; candidate: (typeof candidates)[number] }> = [];
	for (const candidate of candidates) {
		if (!candidate.text) continue;
		let from = 0;
		while (from <= prompt.length - candidate.text.length) {
			const start = prompt.indexOf(candidate.text, from);
			if (start < 0) break;
			const end = start + candidate.text.length;
			if (!occupied.some((span) => start < span.end && end > span.start)) {
				occupied.push({ start, end, candidate });
				break;
			}
			from = start + 1;
		}
	}
	occupied.sort((a, b) => a.start - b.start);
	const items: Record<"Memory" | "Skills" | "System prompt", Detail[]> = { Memory: [], Skills: [], "System prompt": [] };
	let position = 0;
	let previousTokens = 0;
	const push = (category: keyof typeof items, label: string, source: string, content: string, children?: Detail[]) => {
		const next = Math.ceil(position / 4);
		items[category].push({ label, source, content, tokens: next - previousTokens, children });
		previousTokens = next;
	};
	for (const span of occupied) {
		if (span.start > position) {
			const start = position;
			position = span.start;
			push("System prompt", `Prompt text ${items["System prompt"].length + 1}`, "LOADED — assembled system prompt", prompt.slice(start, position));
		}
		position = span.end;
		push(span.candidate.category, span.candidate.label, span.candidate.source, span.candidate.text, span.candidate.children);
	}
	if (position < prompt.length || !prompt.length) {
		const start = position;
		position = prompt.length;
		push("System prompt", `Prompt text ${items["System prompt"].length + 1}`, "LOADED — assembled system prompt", prompt.slice(start));
	}
	return { items };
}

export function collectDetails(ctx: ExtensionCommandContext, allTools: ToolInfo[]): Category[] {
	const options = (ctx.getSystemPromptOptions?.() ?? {}) as BuildSystemPromptOptions;
	const prompt = ctx.getSystemPrompt?.() ?? "";
	const selected = new Set(options.selectedTools ?? ["read", "bash", "edit", "write"]);
	const candidates: Parameters<typeof promptAttribution>[1] = [];
	for (const file of options.contextFiles ?? []) {
		const text = `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>`;
		candidates.push({ category: "Memory", label: file.path, text, source: "LOADED — project instructions wrapper and content" });
	}
	const readTool = (["read", "bash"] as const).find((name) => selected.has(name));
	if (readTool) {
		const skills = (options.skills ?? []).filter((skill) => !skill.disableModelInvocation);
		const formatted = formatSkillsForPrompt(skills, readTool).trim();
		const matches = [...formatted.matchAll(/  <skill>\n[\s\S]*?  <\/skill>/g)];
		for (const [index, skill] of skills.entries()) {
			const text = matches[index]?.[0];
			if (!text) continue;
			let sourceContent: string;
			try { sourceContent = readFileSync(skill.filePath, "utf8"); }
			catch (error) { sourceContent = `Could not read ${skill.filePath}: ${String(error)}`; }
			candidates.push({ category: "Skills", label: skill.name, text,
				source: "LOADED — XML skill advertisement", children: [{ label: `${skill.filePath} — SOURCE, NOT LOADED`, tokens: 0, source: "SOURCE — NOT LOADED (on-disk SKILL.md)", content: sourceContent }] });
		}
	}
	const attributed = promptAttribution(prompt, candidates).items;
	if (prompt) attributed["System prompt"].push({ label: "Full assembled prompt (reference; already counted)", tokens: 0,
		source: "LOADED — full assembled prompt reference, not additional tokens", content: prompt });
	const category = (label: Category["label"], color: Category["color"], items: Detail[]): Category => ({ label, color, items, tokens: items.reduce((sum, item) => sum + item.tokens, 0) });
	const tools: Detail[] = allTools.filter((tool) => selected.has(tool.name)).map((tool) => {
		const fields = { name: tool.name, description: tool.description, parameters: tool.parameters };
		const content = JSON.stringify(fields, null, 2);
		return { label: tool.name, tokens: tokenEstimate(fields), source: "LOCAL REGISTERED SCHEMA — not provider wire payload", content };
	});
	const results: Detail[] = [];
	const conversation: Detail[] = [];
	// The public projection applies compaction and context edits. Older hosts expose only
	// compaction-aware raw entries; that fallback cannot reflect context edits.
	const projection = ctx.sessionManager.buildSessionProjection?.();
	const projectedMessages = projection
		? projection.entries.flatMap(({ messages }) => messages)
		: ctx.sessionManager.buildContextEntries().flatMap((entry) => {
			if (entry.type === "message") return [entry.message];
			if (entry.type === "compaction" || entry.type === "branch_summary")
				return [{ role: entry.type === "compaction" ? "compactionSummary" : "branchSummary", summary: entry.summary }];
			if (entry.type === "custom_message") return [{ role: "custom", content: entry.content }];
			return [];
		});
	for (const message of projectedMessages) {
		if (message.role === "system") continue; // Assembled system prompt is counted above.
		const item: Detail = {
			label: message.role === "toolResult" ? `Result: ${message.toolName}` : `Message: ${message.role}`,
			source: projection
				? "MODEL-VISIBLE LOCAL SESSION PROJECTION — approximate, not provider payload"
				: "RAW COMPACTION-AWARE SESSION ENTRY — context edits not applied; not necessarily model-visible or provider payload",
			content: JSON.stringify(message, null, 2),
			tokens: estimateTokens(message as Parameters<typeof estimateTokens>[0]),
		};
		if (message.role === "toolResult" || message.role === "bashExecution") results.push(item);
		else conversation.push(item);
	}

	return [category("System prompt", "accent", attributed["System prompt"]), category("Memory", "error", attributed.Memory), category("Skills", "warning", attributed.Skills), category("Tools definition", "success", tools), category("Tool results", "customMessageLabel", results), category("Context", "warning", conversation)];
}
