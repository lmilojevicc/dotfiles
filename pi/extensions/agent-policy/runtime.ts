import type { ExtensionAPI, ExtensionContext, NormalizedBuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import type { registerRequiredChildExtensions, RequiredChildExtensionRegistration } from "pi-subagents/required-child-extensions";
import { join } from "node:path";
import { ADDENDUM_SECTION, POLICY_SECTION, policySection, type PolicyProfile, selectAgentName, selectProfile, stripOwnedBlocks } from "./child-profile.ts";
import { composeSources, readConfigSnapshot } from "./config.ts";
import type { BBPolicySignal } from "./bb-profile.ts";

export const POLICY_ID = "dotfiles.agent-policy";

export type InheritedPrompt =
	| { inherited: true; sections: Record<string, string | null>; tools: string[] }
	| { inherited: false };

/** The parts of a session manager this extension reads; absent methods mean an older host. */
type SessionPromptSource = {
	getHeader?: () => { parentSession?: string; timestamp?: string } | null | undefined;
	buildSessionProjection?: () => { messages?: readonly unknown[] } | undefined;
};

/** One recorded prompt state: a head, or a later patch to named sections and tool declarations. */
type PromptRecord = {
	role?: string;
	timestamp?: number;
	sections?: Record<string, string | null> | null;
	toolsAdded?: readonly { name?: string }[] | null;
	toolsRemoved?: readonly { name?: string }[] | null;
};

/**
 * What a branched session inherited: the prompt records written before the fork, replayed in order.
 * A fork's request must start exactly as its parent's last one did to reuse the parent's prompt
 * cache, so this is the state agent-policy reproduces instead of composing a child layer.
 */
/** Decode the session-manager surface this extension reads; an older host may not provide it. */
function promptSource(manager: unknown): SessionPromptSource | undefined {
	if (typeof manager !== "object" || manager === null) return undefined;
	const candidate = manager as Partial<SessionPromptSource>;
	const { getHeader, buildSessionProjection } = candidate;
	return typeof getHeader === "function" && typeof buildSessionProjection === "function"
		? { getHeader: () => getHeader.call(candidate), buildSessionProjection: () => buildSessionProjection.call(candidate) }
		: undefined;
}

export function readInheritedPrompt(manager: unknown): InheritedPrompt {
	const api = promptSource(manager);
	if (!api) return { inherited: false };
	const header = api.getHeader();
	// A parent link alone is not a prefix: a session branched before its parent recorded a prompt,
	// or one that compacted away every inherited message, has nothing left to reproduce.
	if (!header?.parentSession) return { inherited: false };
	const forkedAt = Date.parse(header.timestamp ?? "");
	if (!Number.isFinite(forkedAt)) return { inherited: false };
	let messages: readonly PromptRecord[];
	try {
		messages = (api.buildSessionProjection()?.messages ?? []) as readonly PromptRecord[];
	} catch {
		return { inherited: false };
	}
	const sections: Record<string, string | null> = {};
	// Declared tools are part of the same prefix and come before the prompt, so dropping one costs
	// every cached token behind it (measured: one fewer tool zeroed a 3,955-token cross-session hit).
	const tools = new Set<string>();
	let recorded = 0;
	for (const message of messages) {
		if (message?.role !== "system" || typeof message.timestamp !== "number" || message.timestamp >= forkedAt) continue;
		recorded += 1;
		for (const [name, value] of Object.entries(message.sections ?? {})) sections[name] = value;
		// Host order: removals first, then additions, as Pi replays a record into its current tool set.
		for (const tool of message.toolsRemoved ?? []) if (tool?.name) tools.delete(tool.name);
		for (const tool of message.toolsAdded ?? []) if (tool?.name) tools.add(tool.name);
	}
	return recorded === 0 ? { inherited: false } : { inherited: true, sections, tools: [...tools] };
}

/** Pi stores a named section rendered as `<name>\ncontent\n</name>`; the stored text is what it re-wraps. */
export function unwrapSection(name: string, text: string): string {
	const open = `<${name}>\n`;
	const close = `\n</${name}>`;
	return text.startsWith(open) && text.endsWith(close) ? text.slice(open.length, -close.length) : text;
}

/**
 * Reproduce the inherited head instead of composing one: a section, appended text or tool list that
 * differs lands before the fork point and re-bills the whole conversation. A tool this session
 * cannot serve stays declared and fails when called, which is the fork contract pi-subagents keeps.
 */
function reproduceInheritedPrompt(options: NormalizedBuildSystemPromptOptions, inherited: Extract<InheritedPrompt, { inherited: true }>): void {
	const policy = inherited.sections[POLICY_SECTION];
	if (typeof policy === "string") options.sections[POLICY_SECTION] = unwrapSection(POLICY_SECTION, policy);
	else delete options.sections[POLICY_SECTION];
	const addendum = inherited.sections[ADDENDUM_SECTION];
	options.appendSystemPrompt = typeof addendum === "string" ? unwrapSection(ADDENDUM_SECTION, addendum) : "";
	// An empty record means an older host never declared tools here; keep this session's selection.
	if (inherited.tools.length > 0) options.selectedTools = inherited.tools;
}

export type PolicyRuntimeOptions = {
	policyDir: string;
	/** Resolved by the caller (env → unified agent-dir location → legacy bundled file). */
	configPath?: string;
	extensionPath: string;
	register: typeof registerRequiredChildExtensions;
	backgroundChild: boolean;
	bbSignal?: BBPolicySignal;
	bbOrigin?: boolean;
};

export function installAgentPolicy(pi: ExtensionAPI, options: PolicyRuntimeOptions): void {
	// Like native APPEND_SYSTEM.md, snapshot at runtime creation, not first use.
	const config = readConfigSnapshot(options.policyDir, options.configPath ?? join(options.policyDir, "config.json"));
	const bbWorkflowWorker = options.bbSignal?.workflowWorker ?? false;
	const bbOrigin = options.bbOrigin ?? false;
	const bbDiagnostic = options.bbSignal?.diagnostic;
	let diagnosticReported = false;
	let identity: string | undefined;
	let registration: RequiredChildExtensionRegistration | undefined;
	let inheritedIdentity: string | undefined;
	let inherited: InheritedPrompt | undefined;

	function dispose(): void {
		registration?.dispose();
		registration = undefined;
		identity = undefined;
		inheritedIdentity = undefined;
		inherited = undefined;
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
	/** Sources for this session's layer: a root takes the host's main layer, a child its own. */
	function composeLayer(profile: PolicyProfile, agentName: string | undefined): string {
		if (profile === "main") return composeSources(config.common, bbOrigin ? config.mainBb : config.main);
		const named = agentName === undefined ? [] : config.agents.get(agentName) ?? [];
		return composeSources(config.common, config.child, named);
	}

	// A session's own history decides this once: a session that forked cannot later stop being one,
	// and a fork that compacted away every inherited message has no parent prefix left to match.
	function inheritedPrompt(ctx: ExtensionContext): InheritedPrompt {
		const next = ctx.sessionManager.getSessionId();
		if (inherited === undefined || inheritedIdentity !== next) {
			inheritedIdentity = next;
			inherited = readInheritedPrompt(ctx.sessionManager);
		}
		return inherited;
	}

	pi.on("before_agent_start", (event, ctx) => {
		ensureRegistration(ctx);
		try {
			const inheritedState = inheritedPrompt(ctx);
			if (inheritedState.inherited) {
				// A fork keeps the prompt it inherited; its own instructions belong after the fork point.
				reproduceInheritedPrompt(event.systemPromptOptions, inheritedState);
				return;
			}
			const nativeProfile = selectProfile(event.systemPrompt, options.backgroundChild);
			const profile = selectProfile(event.systemPrompt, options.backgroundChild, bbWorkflowWorker);
			// BB has no name contract: only native classification admits named sources.
			const agentName = selectAgentName(event.systemPrompt, nativeProfile);
			// A BB-origin root replaces the main layer; child routing is unaffected either way.
			const layer: PolicyProfile = profile === "main" && bbOrigin ? "main-bb" : profile;
			const policy = composeLayer(profile, agentName);
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
