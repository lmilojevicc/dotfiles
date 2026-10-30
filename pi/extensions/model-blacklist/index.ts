import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readBlacklistConfig } from "./config.ts";
import { describeApplication, formatReport, type ApplicationReport } from "./report.ts";
import { compileRules, type CompiledRules } from "./rules.ts";
import { installStoreHook, storedProviderIds, type HookState, type RuntimeLike } from "./store-hook.ts";

/** Rules read by the installed store hook, shared with hooks installed before a `/reload`. */
const HOOK_STATE_KEY = Symbol.for("pi.model-blacklist.hook-state");

function readHookState(): HookState {
	const store = globalThis as unknown as Record<symbol, unknown>;
	const existing = store[HOOK_STATE_KEY];
	if (existing) return existing as HookState;
	const created: HookState = {};
	store[HOOK_STATE_KEY] = created;
	return created;
}

/** Pi's `ModelRegistry` is a facade over `ModelRuntime`; the field is private in its types. */
function runtimeOf(ctx: ExtensionContext): RuntimeLike | undefined {
	const runtime = (ctx.modelRegistry as unknown as { runtime?: RuntimeLike }).runtime;
	return typeof runtime === "object" && runtime !== null ? runtime : undefined;
}

/**
 * Surface a diagnostic. Pi's own notification reaches the terminal UI only;
 * hosts such as BB run Pi in RPC mode and drop `notify`, so anything outside the
 * TUI is mirrored to stderr where the host keeps it.
 */
function report(ctx: ExtensionContext, message: string, type: "info" | "warning"): void {
	if (ctx.hasUI) ctx.ui.notify(message, type);
	if (ctx.mode !== "tui") console.error(message);
}

interface Application {
	rules: CompiledRules;
	report: ApplicationReport;
	notices: string[];
}

/**
 * Read the config and publish its rules to the store hook.
 *
 * Providers stored before this point and every provider composed afterwards are
 * filtered by the same wrapper, which reads the current rules on each access, so
 * applying again only swaps the rules and refreshes Pi's model snapshot.
 */
function applyRules(ctx: ExtensionContext): Application {
	const notices: string[] = [];
	const rules = compileRules(readBlacklistConfig((message) => notices.push(message)));
	const state = readHookState();
	state.rules = rules;

	const runtime = runtimeOf(ctx);
	if (!runtime) {
		notices.push("Model blacklist: Pi exposed no model runtime; no models are hidden");
		return { rules, report: describeApplication(rules, undefined), notices };
	}
	if (installStoreHook(runtime, state) === "unsupported") {
		notices.push("Model blacklist: cannot filter Pi's model store (runtime.models.setProvider); no models are hidden");
		return { rules, report: describeApplication(rules, undefined), notices };
	}
	// The provider list is the one Pi stores, which also holds composed
	// `models.json` providers that no registry lookup would have found.
	runtime.updateModelSnapshot?.();
	return { rules, report: describeApplication(rules, storedProviderIds(runtime)), notices };
}

export default function modelBlacklist(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		const { notices } = applyRules(ctx);
		for (const notice of notices) report(ctx, notice, "warning");
	});

	// A reload that drops this extension leaves the installed hook behind;
	// clearing the rules makes it transparent again instead of hiding models of a
	// config nobody is applying anymore.
	pi.on("session_shutdown", (_event, ctx) => {
		const state = readHookState();
		if (!state.rules) return;
		state.rules = undefined;
		runtimeOf(ctx)?.updateModelSnapshot?.();
	});

	pi.registerCommand("model-blacklist", {
		description: "Show the model blacklist rules and apply them now",
		handler: async (_args, ctx) => {
			const { rules, report: result, notices } = applyRules(ctx);
			const lines = [...formatReport(rules, result), ...notices];
			report(ctx, lines.join("\n"), notices.length > 0 ? "warning" : "info");
		},
	});
}
