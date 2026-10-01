import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { registerRequiredChildExtensions, RequiredChildExtensionRegistration } from "pi-subagents/required-child-extensions";
import { appendPolicy, selectProfile, selectRole } from "./child-profile.ts";

export const POLICY_ID = "dotfiles.agent-policy";
export type PolicyRuntimeOptions = {
	policyDir: string;
	extensionPath: string;
	register: typeof registerRequiredChildExtensions;
	backgroundChild: boolean;
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
			const profile = selectProfile(event.systemPrompt, options.backgroundChild);
			const role = selectRole(event.systemPrompt, profile);
			// Pi starts each hook chain from its base prompt; reapply the cached text each run.
			const texts = [common, profile === "main" ? main : child];
			if (role) texts.push(roles[role]);
			const policy = texts.filter((text) => text.trim()).join("\n\n");
			return { systemPrompt: appendPolicy(event.systemPrompt, profile, policy) };
		} catch (error) {
			report(error, ctx);
		}
	});
}
