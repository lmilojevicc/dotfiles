import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { configPath, readBridgeConfig, type BridgeConfig } from "./config.ts";
import { createStatusBridge } from "./bridge.ts";
import { hasStatusTap, installStatusTap } from "./tap.ts";

/**
 * Surface a diagnostic. Pi's notification reaches the terminal UI only; hosts
 * such as BB run Pi in RPC mode and drop `notify`, so anything outside the TUI
 * is mirrored to stderr where the host keeps it.
 */
function report(ctx: ExtensionContext, message: string, type: "info" | "warning"): void {
	if (ctx.hasUI) ctx.ui.notify(message, type);
	if (ctx.mode !== "tui") console.error(message);
}

export default function zentuiStatusBridge(pi: ExtensionAPI): void {
	let config: BridgeConfig = readBridgeConfig(() => {});
	const bridge = createStatusBridge({ events: pi.events, getConfig: () => config });
	let unsupportedReported = false;

	const loadConfig = (ctx: ExtensionContext): string[] => {
		const notices: string[] = [];
		config = readBridgeConfig((message) => notices.push(message));
		for (const notice of notices) report(ctx, notice, "warning");
		return notices;
	};

	/**
	 * Install the tap when it is missing. Called on `session_start` (covers
	 * publications outside a turn) and again on `before_agent_start`, which is
	 * the first point guaranteed to run after Zentui installed its own
	 * `setStatus` wrapper — the tap has to sit outside it to see values Zentui
	 * would otherwise hide.
	 */
	const ensureTap = (ctx: ExtensionContext): void => {
		if (ctx.mode !== "tui" || !ctx.ui) return;
		const result = installStatusTap(ctx.ui, bridge);
		if (result === "unsupported" && !unsupportedReported) {
			unsupportedReported = true;
			report(ctx, "Status bridge: Pi's setStatus is not a patchable method; statuses stay on the footer", "warning");
		}
	};

	pi.on("session_start", (_event, ctx) => {
		bridge.clear();
		loadConfig(ctx);
		ensureTap(ctx);
	});

	pi.on("before_agent_start", (_event, ctx) => {
		ensureTap(ctx);
	});

	pi.on("agent_end", (_event, ctx) => {
		ensureTap(ctx);
	});

	pi.on("session_shutdown", () => {
		bridge.clear();
	});

	pi.registerCommand("status-bridge", {
		description: "Show the status-to-Zentui bridge config and the keys it currently publishes",
		handler: async (_args, ctx) => {
			const notices = loadConfig(ctx);
			ensureTap(ctx);
			const published = bridge.snapshot();
			const lines = [
				`Status bridge: ${configPath()}`,
				`include: ${config.include.length > 0 ? config.include.join(", ") : "(every status key)"}`,
				config.exclude.length > 0 ? `exclude: ${config.exclude.join(", ")}` : "exclude: (none)",
				`keyPrefix: ${config.keyPrefix || "(none)"} · suppressHostStatus: ${config.suppressHostStatus} · maxTextLength: ${config.maxTextLength}`,
				`tap: ${ctx.mode === "tui" && ctx.ui ? (hasStatusTap(ctx.ui) ? "installed" : "not installed") : `unavailable (${ctx.mode} mode)`}`,
				published.size > 0
					? `published: ${[...published.entries()].map(([key, entry]) => `${key} → ${entry.targetKey}`).join(", ")}`
					: "published: (nothing yet this session)",
			];
			report(ctx, [...lines, ...notices].join("\n"), notices.length > 0 ? "warning" : "info");
		},
	});
}
