import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { registerRequiredChildExtensions, RequiredChildExtensionRegistration } from "pi-subagents/required-child-extensions";
import { appendPolicy, selectAgentName, selectProfile, selectRole } from "./child-profile.ts";
import { readInjectionSnapshot } from "./injections.ts";
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
	function readPolicy(filename: string): string {
		try {
			return readFileSync(join(options.policyDir, filename), "utf8");
		} catch (error) {
			throw new Error(`agent-policy: ${filename}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
		}
	}
	// Like native APPEND_SYSTEM.md, snapshot at runtime creation, not first use.
	const common = readPolicy("COMMON_APPEND_SYSTEM.md");
	const main = readPolicy("ORCHESTRATOR_APPEND_SYSTEM.md");
	const child = readPolicy("SUBAGENT_APPEND_SYSTEM.md");
	const roles = {
		worker: readPolicy("roles/worker.md"),
		reviewer: readPolicy("roles/reviewer.md"),
		scout: readPolicy("roles/scout.md"),
	};
	const injections = readInjectionSnapshot(options.policyDir);
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
		if (bbDiagnostic && !diagnosticReported) {
			diagnosticReported = true;
			if (ctx.hasUI) ctx.ui.notify(bbDiagnostic, "warning");
			else console.error(bbDiagnostic);
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
			// BB has no role contract: only native classification admits canonical overlays.
			const role = selectRole(event.systemPrompt, nativeProfile);
			const agentName = selectAgentName(event.systemPrompt, nativeProfile);
			// Pi starts each hook chain from its base prompt; reapply the cached text each run.
			const texts = [common, profile === "main" ? main : child];
			if (role) texts.push(roles[role]);
			texts.push(...(profile === "main" ? injections.main : agentName === undefined ? [] : injections.agents.get(agentName) ?? []));
			const policy = texts.filter((text) => text.trim()).join("\n\n");
			return { systemPrompt: appendPolicy(event.systemPrompt, profile, policy) };
		} catch (error) {
			report(error, ctx);
		}
	});
}
