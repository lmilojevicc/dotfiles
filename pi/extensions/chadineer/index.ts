import type {
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";

export const CHADINEER_STATE_ENTRY = "dotfiles.chadineer";
export const CHADINEER_STATUS_KEY = "chadineer";
export const CHADINEER_USAGE = "Usage: /chadineer [on|off|status]";

export const CHADINEER_PROMPT = `## Chadineer development guidelines

Prefer the simplest adequate solution. Efficiency must not compromise correctness, security, accessibility, maintainability, or the requested outcome. Follow higher-priority instructions and applicable acceptance criteria.

### Before coding

- State material assumptions explicitly. If uncertainty affects the approach, ask.
- If materially different interpretations exist, present them rather than choosing silently.
- When a materially simpler option meets the same outcome, surface it before implementing a more complex approach.
- Understand the relevant behavior before choosing an implementation; investigate in proportion to the change's scope and risk.
- For bug fixes, identify the root cause and inspect relevant callers and sibling paths. Fix the narrowest correct ownership point.

### Priority ladder

Stop at the first option that adequately meets the requirements and repository constraints:

1. Does this need to be built at all? Apply YAGNI.
2. Does a suitable implementation already exist in the codebase? Reuse it when it meets current requirements and repository standards.
3. Does the standard library already provide it? Prefer that.
4. Does a native platform feature cover it? Prefer that.
5. Does an already-installed dependency adequately solve it? Prefer that.
6. Only then, write the minimum code that works.

### Change discipline

- Avoid speculative abstractions; introduce one only when current requirements or repeated behavior justify it.
- Avoid a new dependency when a suitable existing option is available.
- Add error handling for plausible failure modes, especially at trust boundaries and where failure could lose data.
- Prefer deletion and boring, localized, self-contained changes over clever additions without compromising separation of concerns or verification.
- Touch only what the task requires. Match the repository's style, avoid unrelated cleanup, and remove imports or code made unused by your change.
- Accept a deliberate limitation only when it meets current requirements and risk. Document a material, non-obvious ceiling and its revisit trigger using repository conventions.

### Safety and domain boundaries

- Validate untrusted input at trust boundaries.
- Do not compromise security, accessibility, or data-loss prevention for brevity.
- For hardware-facing code, account for calibration, drift, tolerances, and sensor error.

### Verification

Define explicit success criteria before changing code. For multi-step work, state a brief plan with the check for each step.

Verify in proportion to risk. For material behavior changes, add or update maintained regression coverage that would fail without the change and pass with it, using the repository's existing test infrastructure where practical. Run the strongest relevant checks and report failures, skipped checks, or remaining verification gaps.`;

type ChadineerState = {
	enabled: boolean;
};

export type ChadineerCommand =
	| { kind: "toggle" }
	| { kind: "set"; enabled: boolean }
	| { kind: "status" }
	| { kind: "invalid" };

export function parseChadineerCommand(args: string): ChadineerCommand {
	const value = args.trim().toLowerCase();
	if (value === "") return { kind: "toggle" };
	if (value === "on") return { kind: "set", enabled: true };
	if (value === "off") return { kind: "set", enabled: false };
	if (value === "status") return { kind: "status" };
	return { kind: "invalid" };
}

function parseStoredState(data: unknown): boolean | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const enabled = (data as Partial<ChadineerState>).enabled;
	return typeof enabled === "boolean" ? enabled : undefined;
}

export function restoreChadineerState(entries: readonly SessionEntry[]): boolean {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== CHADINEER_STATE_ENTRY) continue;
		const enabled = parseStoredState(entry.data);
		if (enabled !== undefined) return enabled;
	}
	return false;
}

export default function chadineerExtension(pi: ExtensionAPI): void {
	let enabled = false;

	function render(ctx: ExtensionContext): void {
		ctx.ui.setStatus(CHADINEER_STATUS_KEY, enabled ? "chadineer" : undefined);
	}

	function describe(prefix = "Chadineer is"): string {
		return `${prefix} ${enabled ? "on" : "off"}`;
	}

	function restore(ctx: ExtensionContext): void {
		enabled = restoreChadineerState(ctx.sessionManager.getBranch());
		render(ctx);
	}

	function transition(next: boolean, ctx: ExtensionContext): void {
		if (next === enabled) {
			ctx.ui.notify(describe("Chadineer is already"), "info");
			return;
		}
		enabled = next;
		pi.appendEntry<ChadineerState>(CHADINEER_STATE_ENTRY, { enabled });
		render(ctx);
		ctx.ui.notify(describe(), "info");
	}

	pi.registerCommand("chadineer", {
		description: "Toggle concise development guidelines",
		handler: (args, ctx) => {
			const command = parseChadineerCommand(args);
			switch (command.kind) {
				case "toggle":
					transition(!enabled, ctx);
					return;
				case "set":
					transition(command.enabled, ctx);
					return;
				case "status":
					ctx.ui.notify(describe(), "info");
					return;
				case "invalid":
					ctx.ui.notify(CHADINEER_USAGE, "warning");
			}
		},
	});

	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("before_agent_start", (event) => {
		if (!enabled) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${CHADINEER_PROMPT}` };
	});
}
