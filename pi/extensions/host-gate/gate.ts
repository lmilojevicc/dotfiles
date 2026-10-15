import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readGateConfig } from "./config.ts";
import { decide, hostConditions, type HostEnv } from "./host.ts";
import type { SourceResolver } from "./manifest.ts";

export type GateOptions = Readonly<{
	configDir: string;
	env: HostEnv;
	isTTY: boolean;
	resolve: SourceResolver;
	loadFactory: (path: string) => Promise<unknown>;
}>;

/**
 * Load each allowed package's declared extension entrypoints through the supplied host API.
 * Fail-open: a resolved-but-broken entrypoint warns and leaves its siblings loaded.
 * Errors are collected and surfaced once per runtime, not swallowed.
 */
export async function installHostGate(pi: ExtensionAPI, options: GateOptions): Promise<readonly string[]> {
	// Capture host facts before any await: later env changes need a new runtime/reload.
	const conditions = hostConditions(options.env, options.isTTY);
	const config = readGateConfig(options.configDir);
	const warnings: string[] = [...config.warnings];

	const allowed: string[] = [];
	for (const entry of config.entries) {
		const decision = decide(entry.require, conditions);
		if (decision.unknown !== undefined) {
			warnings.push(`host-gate: ${entry.source}: unknown host condition ${JSON.stringify(decision.unknown)}; not loading.`);
			continue;
		}
		if (decision.load) allowed.push(entry.source);
	}

	if (allowed.length > 0) {
		let resolved;
		try {
			resolved = await options.resolve(allowed);
		} catch (error) {
			warnings.push(`host-gate: resolution failed: ${error instanceof Error ? error.message : String(error)}`);
			resolved = { entries: [], warnings: [] };
		}
		warnings.push(...resolved.warnings);
		const loaded = new Set<string>();
		for (const entry of resolved.entries) {
			if (loaded.has(entry.path)) continue;
			loaded.add(entry.path);
			try {
				const factory = await options.loadFactory(entry.path);
				if (typeof factory !== "function") {
					throw new Error("entrypoint has no default-export factory");
				}
				await (factory as (api: ExtensionAPI) => unknown)(pi);
			} catch (error) {
				warnings.push(`host-gate: ${entry.source} ${entry.path}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	let reported = false;
	function report(ctx: ExtensionContext): void {
		if (reported) return;
		reported = true;
		for (const warning of warnings) {
			if (ctx.hasUI) ctx.ui.notify(warning, "warning");
			else console.error(warning);
		}
	}
	pi.on("session_start", (_event, ctx) => report(ctx));
	// Pi starts each hook chain from its base prompt; this hook only reports, never mutates it.
	pi.on("before_agent_start", (_event, ctx) => report(ctx));

	return warnings;
}
