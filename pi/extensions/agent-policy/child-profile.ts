/** Local-native pi-subagents prompt-runtime boundary; revalidate after upgrades. */
export const CHILD_PREFIXES = [
	"You are a child subagent, not the parent orchestrator.",
	"You are a child subagent with explicit fanout responsibility for this assigned task.",
] as const;

// Complete generated native SYSTEM suffixes, not loose matches for quoted prefix lines.
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
	// Retain the older complete-boundary contract, including blank/whitespace role bodies.
	const tag = /^(<active_agent name="[^"<>\r\n]*"\/>)\n\n/;
	const replaceTag = base.match(tag)?.[1];
	if (replaceTag) return replaceTag;
	const addendum = base.indexOf("\n\n<addendum>\n");
	if (addendum === -1) return undefined;
	const content = base.slice(addendum + "\n\n<addendum>\n".length);
	return content.includes("\n</addendum>") ? content.match(tag)?.[1] : undefined;
}

/** 0.77.0 filters first, runs ordinary extensions next, and adds the boundary last.
 * Exact generated launch headers route before that boundary. A deliberately constructed
 * root SYSTEM lookalike is indistinguishable here: this is not authentication.
 */
function generatedLaunchTag(systemPrompt: string): string | undefined {
	const base = systemPrompt.trimStart();
	const tag = /^(<active_agent name="[^"<>\x00-\x1f]+"\/>)\n\n(?=\S)/;
	const replaceTag = base.match(tag)?.[1];
	if (replaceTag && tagName(replaceTag) !== undefined) return replaceTag;
	const addendum = base.indexOf("\n\n<addendum>\n");
	if (addendum === -1) return undefined;
	const content = base.slice(addendum + "\n\n<addendum>\n".length);
	const close = /\n<\/addendum>(?=\n\n|$)/.exec(content)?.index;
	if (close === undefined) return undefined;
	const appendTag = content.slice(0, close).match(tag)?.[1];
	return appendTag && tagName(appendTag) !== undefined ? appendTag : undefined;
}

function tagName(tag: string): string | undefined {
	const encoded = tag.match(/^<active_agent name="([^"<>\x00-\x1f]+)"\/>$/)?.[1];
	if (!encoded) return undefined;
	// Reverse only the native launcher's four XML escapes, never aliases or fuzzy names.
	if (/&(?!amp;|quot;|lt;|gt;)/.test(encoded)) return undefined;
	return encoded.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

export type PolicyProfile = "main" | "subagent";

export function selectProfile(systemPrompt: string, backgroundChild: boolean, bbWorkflowWorker = false): PolicyProfile {
	return backgroundChild || bbWorkflowWorker || CHILD_PREFIXES.some((prefix) => systemPrompt.trimStart().startsWith(prefix))
		|| appendedNativeLaunchTag(systemPrompt) !== undefined || generatedLaunchTag(systemPrompt) !== undefined
		? "subagent"
		: "main";
}

/** Exact configured-name routing; no role fallback. Call with native profile only. */
export function selectAgentName(systemPrompt: string, profile: PolicyProfile): string | undefined {
	if (profile !== "subagent") return undefined;
	const tag = appendedNativeLaunchTag(systemPrompt) ?? generatedLaunchTag(systemPrompt)
		?? systemPrompt.match(/^<active_agent\b[^\r\n]*$/m)?.[0];
	return tag ? tagName(tag) : undefined;
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
