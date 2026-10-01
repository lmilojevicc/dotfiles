/** Local-native pi-subagents prompt-runtime boundary; revalidate after upgrades. */
export const CHILD_PREFIXES = [
	"You are a child subagent, not the parent orchestrator.",
	"You are a child subagent with explicit fanout responsibility for this assigned task.",
] as const;

export type PolicyProfile = "main" | "subagent";

export function selectProfile(systemPrompt: string, backgroundChild: boolean): PolicyProfile {
	return backgroundChild || CHILD_PREFIXES.some((prefix) => systemPrompt.trimStart().startsWith(prefix))
		? "subagent"
		: "main";
}

export type PolicyRole = "worker" | "reviewer" | "scout";

/** The launch puts the canonical tag before the role body, even in append mode.
 * This is routing metadata, not authentication; unknown/malformed names stay generic.
 */
export function selectRole(systemPrompt: string, profile: PolicyProfile): PolicyRole | undefined {
	if (profile !== "subagent") return undefined;
	const tag = systemPrompt.match(/^<active_agent\b[^\r\n]*$/m)?.[0];
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
