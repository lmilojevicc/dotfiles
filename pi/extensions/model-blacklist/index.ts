import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyBlacklist, type ApplyResult } from "./apply.ts";
import { readBlacklistConfig } from "./config.ts";
import { installRegistryHook, type HookState, type RuntimeLike } from "./registry-hook.ts";
import { compileRules, type CompiledRules } from "./rules.ts";

/**
 * Provider ids filtered by the current process, kept on `globalThis` so the
 * set survives the module re-evaluation that `/reload` performs. Without it,
 * a rule removed during a session could not be undone before a full restart.
 */
const APPLIED_KEY = Symbol.for("pi.model-blacklist.applied");

function readAppliedProviders(): Set<string> {
	const store = globalThis as unknown as Record<symbol, unknown>;
	const existing = store[APPLIED_KEY];
	if (existing instanceof Set) return existing as Set<string>;
	const created = new Set<string>();
	store[APPLIED_KEY] = created;
	return created;
}

/** Rules read by the registry hook, shared with hooks installed before a `/reload`. */
const HOOK_STATE_KEY = Symbol.for("pi.model-blacklist.hook-state");

function readHookState(): HookState {
	const store = globalThis as unknown as Record<symbol, unknown>;
	const existing = store[HOOK_STATE_KEY];
	if (existing) return existing as HookState;
	const created: HookState = { applied: readAppliedProviders() };
	store[HOOK_STATE_KEY] = created;
	return created;
}

/** Pi's `ModelRegistry` is a facade over `ModelRuntime`; the field is private in its types. */
function runtimeOf(ctx: ExtensionContext): RuntimeLike | undefined {
	const runtime = (ctx.modelRegistry as unknown as { runtime?: Partial<RuntimeLike> }).runtime;
	if (
		typeof runtime?.registerProvider !== "function" ||
		typeof runtime.registerNativeProvider !== "function" ||
		typeof runtime.getProvider !== "function"
	)
		return undefined;
	return runtime as RuntimeLike;
}

function applyToContext(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): { result: ApplyResult; rules: CompiledRules; notices: string[] } {
	const applied = readAppliedProviders();
	const notices: string[] = [];
	const config = readBlacklistConfig((message) => notices.push(message));
	const rules = compileRules(config);
	// Publish the rules before applying them, so a provider restored below is
	// not re-wrapped by the hook under the previous rules.
	const hookState = readHookState();
	hookState.rules = rules;
	hookState.applied = applied;
	const runtime = runtimeOf(ctx);
	if (runtime) installRegistryHook(runtime, hookState);
	const result = applyBlacklist({
		registry: ctx.modelRegistry,
		rules,
		register: (provider) => pi.registerProvider(provider),
		previouslyApplied: [...applied],
	});

	applied.clear();
	for (const providerId of result.applied) applied.add(providerId);
	return { result, rules, notices };
}

export default function modelBlacklist(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		const { notices } = applyToContext(pi, ctx);
		for (const notice of notices) ctx.ui.notify(notice, "warning");
	});

	pi.registerCommand("model-blacklist", {
		description: "Show the model blacklist rules and apply them now",
		handler: async (_args, ctx) => {
			const { result, rules, notices } = applyToContext(pi, ctx);
			const lines: string[] = [`Model blacklist: ${rules.patternCount} pattern(s)`];
			for (const providerId of result.applied) {
				lines.push(`  ${providerId}: ${rules.patternsFor(providerId).join(", ")}`);
			}
			if (result.restored.length > 0) lines.push(`Restored: ${result.restored.join(", ")}`);
			if (result.missing.length > 0) lines.push(`Unknown providers (ignored): ${result.missing.join(", ")}`);
			if (result.applied.length === 0 && result.missing.length === 0)
				lines.push("No providers configured; no models are hidden");
			for (const notice of notices) lines.push(notice);
			ctx.ui.notify(lines.join("\n"), notices.length > 0 ? "warning" : "info");
		},
	});
}
