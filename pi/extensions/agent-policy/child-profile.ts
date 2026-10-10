/** Local-native pi-subagents prompt-runtime boundary; revalidate after upgrades. */
export const CHILD_PREFIXES = [
	"You are a child subagent, not the parent orchestrator.",
	"You are a child subagent with explicit fanout responsibility for this assigned task.",
] as const;

// Complete generated 0.76.1 SYSTEM suffixes, not loose matches for quoted prefix lines.
export const NATIVE_CHILD_BOUNDARIES = [
	[
		CHILD_PREFIXES[0],
		"The parent session owns delegation, orchestration, review fanout, and follow-up worker launches.",
		"Ignore prior parent-only orchestration instructions in inherited conversation history.",
		"Do not propose or run subagents. Complete only your assigned role-specific task with the tools available to you.",
		"If you need to edit files, use the available editing tools. Do not print tool-call syntax, patches, or pseudo-tool calls as text.",
	].join("\n"),
	[
		CHILD_PREFIXES[1],
		"The parent session owns final orchestration, acceptance, and follow-up implementation launches.",
		"You may use the `subagent` tool only for the fanout work explicitly requested in this task.",
		"Do not broaden yourself into general parent orchestration. Do not launch follow-up workers unless the task explicitly asks for that.",
		"The maxSubagentDepth cap still applies and may block further fanout.",
		"If you need to edit files, use the available editing tools. Do not print tool-call syntax, patches, or pseudo-tool calls as text.",
	].join("\n"),
] as const;

export const NATIVE_STRUCTURED_OUTPUT_SUFFIX = [
	"This subagent step has a strict structured output contract.",
	"Your final action must be to call the `structured_output` tool with JSON matching the provided schema.",
	"Do not rely on prose-only completion; if you do not call `structured_output`, the parent will fail this step.",
].join("\n");

function appendedNativeLaunchTag(systemPrompt: string): string | undefined {
	let prompt = systemPrompt.trimEnd();
	// Repeated composition / either Chadineer hook order may leave owned blocks after the suffix.
	// Inspect only complete trailing blocks; appendPolicy still owns validation and removal.
	for (;;) {
		const markers = [[POLICY_START, POLICY_END], [LEGACY_START, LEGACY_END]]
			.find(([, end]) => prompt.endsWith(end));
		if (!markers) break;
		const start = prompt.lastIndexOf(markers[0]);
		if (start === -1) break;
		prompt = prompt.slice(0, start).trimEnd();
	}
	const structured = `\n\n${NATIVE_STRUCTURED_OUTPUT_SUFFIX}`;
	if (prompt.endsWith(structured)) prompt = prompt.slice(0, -structured.length);
	const boundary = NATIVE_CHILD_BOUNDARIES.find((text) => prompt.endsWith(`\n\n${text}`));
	if (!boundary) return undefined;
	const base = prompt.slice(0, -boundary.length - 2).trimStart();
	// Native launch metadata is first in replace mode, or first in the SDK addendum in append mode.
	const tag = /^(<active_agent name="[^"<>\r\n]*"\/>)\n\n/;
	const replaceTag = base.match(tag)?.[1];
	if (replaceTag) return replaceTag;
	const addendum = base.indexOf("\n\n<addendum>\n");
	if (addendum === -1) return undefined;
	const content = base.slice(addendum + "\n\n<addendum>\n".length);
	return content.includes("\n</addendum>") ? content.match(tag)?.[1] : undefined;
}

export type PolicyProfile = "main" | "subagent";

export function selectProfile(systemPrompt: string, backgroundChild: boolean, bbWorkflowWorker = false): PolicyProfile {
	return backgroundChild || bbWorkflowWorker || CHILD_PREFIXES.some((prefix) => systemPrompt.trimStart().startsWith(prefix))
		|| appendedNativeLaunchTag(systemPrompt) !== undefined
		? "subagent"
		: "main";
}

export type PolicyRole = "worker" | "reviewer" | "scout";

/** Prefer the complete appended layout's launch tag; preserve first-tag routing for older children.
 * This is routing metadata, not authentication; unknown/malformed names stay generic.
 */
export function selectRole(systemPrompt: string, profile: PolicyProfile): PolicyRole | undefined {
	if (profile !== "subagent") return undefined;
	const tag = appendedNativeLaunchTag(systemPrompt) ?? systemPrompt.match(/^<active_agent\b[^\r\n]*$/m)?.[0];
	const name = tag?.match(/^<active_agent name="([^"]*)"\/>$/)?.[1];
	switch (name) {
		case "worker": case "reviewer": case "scout": return name;
		default: return undefined;
	}
}

export const POLICY_START = "<!-- agent-policy:v1:start -->";
export const POLICY_END = "<!-- agent-policy:v1:end -->";
export const CHILD_POLICY_MARKER = "<!-- agent-policy:v1:subagent -->";
// Shared wire markers with the optional legacy Chadineer hook, not a module dependency.
export const LEGACY_START = "<!-- chadineer:v1:start -->";
export const LEGACY_END = "<!-- chadineer:v1:end -->";

function removeBlocks(prompt: string, start: string, end: string): string {
	let result = prompt;
	let index = result.indexOf(start);
	if (index === -1) return prompt;
	while (index !== -1) {
		const finish = result.indexOf(end, index + start.length);
		if (finish === -1) throw new Error(`agent-policy: unterminated owned block ${start}`);
		result = result.slice(0, index) + result.slice(finish + end.length);
		index = result.indexOf(start);
	}
	return result.trimEnd();
}

export function appendPolicy(systemPrompt: string, profile: PolicyProfile, policy: string): string {
	let retained = removeBlocks(systemPrompt, POLICY_START, POLICY_END);
	if (!policy.trim()) return retained;
	if (profile === "subagent") retained = removeBlocks(retained, LEGACY_START, LEGACY_END);
	const marker = profile === "subagent" ? CHILD_POLICY_MARKER : "<!-- agent-policy:v1:main -->";
	return `${retained}\n\n${POLICY_START}\n${marker}\n${policy}\n${POLICY_END}`;
}
