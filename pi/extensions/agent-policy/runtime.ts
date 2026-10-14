import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { registerRequiredChildExtensions, RequiredChildExtensionRegistration } from "pi-subagents/required-child-extensions";
import { appendPolicy, selectAgentName, selectProfile } from "./child-profile.ts";
import { composeSources, readConfigSnapshot } from "./config.ts";
import type { BBPolicySignal } from "./bb-profile.ts";

export const POLICY_ID = "dotfiles.agent-policy";
export type PolicyRuntimeOptions = {
	policyDir: string;
	extensionPath: string;
	register: typeof registerRequiredChildExtensions;
	backgroundChild: boolean;
	bbSignal?: BBPolicySignal;
};

export function installAgentPolicy(pi: ExtensionAPI, options: PolicyRuntimeOptions): void {
	// Like native APPEND_SYSTEM.md, snapshot at runtime creation, not first use.
	const config = readConfigSnapshot(options.policyDir);
	const bbWorkflowWorker = options.bbSignal?.workflowWorker ?? false;
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
		ctx.ui.notify(message, "error");
		if (!ctx.hasUI) console.error(message);
		throw new Error(message, { cause: error });
	}

	function ensureRegistration(ctx: ExtensionContext): void {
		if (!diagnosticReported) {
			diagnosticReported = true;
			for (const warning of [...config.warnings, ...(bbDiagnostic ? [bbDiagnostic] : [])]) {
				if (ctx.hasUI) ctx.ui.notify(warning, "warning");
				else console.error(warning);
			}
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
			// Pi starts each hook chain from its base prompt; reapply the cached text each run.
			const policy = profile === "main"
				? composeSources(config.common, config.main)
				: composeSources(config.common, config.child, agentName === undefined ? [] : config.agents.get(agentName) ?? []);
			return { systemPrompt: appendPolicy(event.systemPrompt, profile, policy) };
		} catch (error) {
			report(error, ctx);
		}
	});
}
