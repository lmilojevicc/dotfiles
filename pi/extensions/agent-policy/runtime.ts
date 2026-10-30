import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { registerRequiredChildExtensions, RequiredChildExtensionRegistration } from "pi-subagents/required-child-extensions";
import { POLICY_SECTION, policySection, type PolicyProfile, selectAgentName, selectProfile, stripOwnedBlocks } from "./child-profile.ts";
import { composeSources, readConfigSnapshot } from "./config.ts";
import type { BBPolicySignal } from "./bb-profile.ts";

export const POLICY_ID = "dotfiles.agent-policy";
export type PolicyRuntimeOptions = {
	policyDir: string;
	extensionPath: string;
	register: typeof registerRequiredChildExtensions;
	backgroundChild: boolean;
	bbSignal?: BBPolicySignal;
	bbOrigin?: boolean;
};

export function installAgentPolicy(pi: ExtensionAPI, options: PolicyRuntimeOptions): void {
	// Like native APPEND_SYSTEM.md, snapshot at runtime creation, not first use.
	const config = readConfigSnapshot(options.policyDir);
	const bbWorkflowWorker = options.bbSignal?.workflowWorker ?? false;
	const bbOrigin = options.bbOrigin ?? false;
	const bbDiagnostic = options.bbSignal?.diagnostic;
	let diagnosticReported = false;
	let identity: string | undefined;
	let registration: RequiredChildExtensionRegistration | undefined;

	function dispose(): void {
		registration?.dispose();
		registration = undefined;
		identity = undefined;
	}

	function report(error: unknown, ctx: ExtensionContext): never {
		const message = `agent-policy: ${error instanceof Error ? error.message : String(error)}`;
		// BB drops notify in RPC mode, so a non-TUI host also gets stderr even when it has a UI.
		if (ctx.hasUI) ctx.ui.notify(message, "error");
		if (ctx.mode !== "tui") console.error(message);
		throw new Error(message, { cause: error });
	}

	function ensureRegistration(ctx: ExtensionContext): void {
		if (!diagnosticReported) {
			for (const warning of [...config.warnings, ...(bbDiagnostic ? [bbDiagnostic] : [])]) {
				if (ctx.hasUI) ctx.ui.notify(warning, "warning");
				if (ctx.mode !== "tui") console.error(warning);
			}
			// Only once every diagnostic was emitted; a throwing notify retries on the next run.
			diagnosticReported = true;
		}
		// Native executor required-extension lookups use the Pi ID, not the file path.
		const next = ctx.sessionManager.getSessionId();
		if (registration && identity === next) return;
		dispose();
		try {
			registration = options.register({
				sessionId: next,
				extensions: [{ id: POLICY_ID, path: options.extensionPath }],
			});
			identity = next;
		} catch (error) {
			report(error, ctx);
		}
	}

	// Register before any child launch; inherited required snapshots remain owned by pi-subagents.
	pi.on("session_start", (_event, ctx) => {
		dispose();
		ensureRegistration(ctx);
	});
	pi.on("session_shutdown", () => dispose());
	pi.on("before_agent_start", (event, ctx) => {
		ensureRegistration(ctx);
		try {
			const nativeProfile = selectProfile(event.systemPrompt, options.backgroundChild);
			const profile = selectProfile(event.systemPrompt, options.backgroundChild, bbWorkflowWorker);
			// BB has no name contract: only native classification admits named sources.
			const agentName = selectAgentName(event.systemPrompt, nativeProfile);
			// A BB-origin root replaces the main layer; child routing is unaffected either way.
			const layer: PolicyProfile = profile === "main" && bbOrigin ? "main-bb" : profile;
			const policy = profile === "main"
				? composeSources(config.common, bbOrigin ? config.mainBb : config.main)
				: composeSources(config.common, config.child, agentName === undefined ? [] : config.agents.get(agentName) ?? []);
			// Mutate the section instead of returning systemPrompt: a returned prompt forces the whole
			// text for that run and silently drops every section later handlers add.
			const section = policySection(layer, policy);
			// Pi renders a fresh base prompt each run; drop owned blocks inherited as text (fork/child role bodies).
			for (const key of ["customPrompt", "appendSystemPrompt"] as const) {
				const text = event.systemPromptOptions[key];
				if (text) event.systemPromptOptions[key] = stripOwnedBlocks(text, layer, section !== undefined && layer === "subagent");
			}
			if (section === undefined) delete event.systemPromptOptions.sections[POLICY_SECTION];
			else event.systemPromptOptions.sections[POLICY_SECTION] = section;
		} catch (error) {
			report(error, ctx);
		}
	});
}
