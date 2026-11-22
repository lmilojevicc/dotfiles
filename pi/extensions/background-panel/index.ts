/**
 * background-panel: one place for everything running in the background, after OpenCode v2's
 * composer. A status (`↓ 1 workflow · 3 subagents · 1 shell`, published as the `background-jobs`
 * status key) says what runs; the open key (default ↓) on an empty editor opens a tabbed panel in
 * the editor's place (Subagents, Shell, Terminals); Enter shows a job's output in an overlay or
 * attaches to a terminal, Ctrl+D stops a job.
 *
 * Extensions list their work with the background-jobs v1 protocol (protocol.ts); bash-improved does.
 * For packages that do not, bridges read pi-subagents (over its RPC) and pi-interactive-shell (from
 * its session manager on globalThis). This file is wiring only: lifecycle in controller.ts, config
 * in config.ts, rendering in panel.ts/output-view.ts, data in registry.ts/protocol.ts.
 */
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PiInteractiveShellBridge } from "./bridges/interactive-shell.ts";
import { PiSubagentsBridge } from "./bridges/subagents.ts";
import {
	type BackgroundPanelConfig,
	DEFAULT_BACKGROUND_PANEL_CONFIG,
	loadBackgroundPanelConfig,
} from "./config.ts";
import { BackgroundPanelController, BACKGROUND_PANEL_STATUS_KEY } from "./controller.ts";
import { BackgroundJobsRegistry } from "./registry.ts";
import { INTERACTIVE_SHELL_TOOL, startShellInBackground } from "./shell-launch.ts";

/** The status key that carries the count line; zentui-status-bridge can move it into the editor border. */
export const STATUS_KEY = BACKGROUND_PANEL_STATUS_KEY;

export default function backgroundPanel(pi: ExtensionAPI): void {
	const registry = new BackgroundJobsRegistry();
	let config: BackgroundPanelConfig | undefined;
	const getConfig = () => config ?? DEFAULT_BACKGROUND_PANEL_CONFIG;
	const controller = new BackgroundPanelController(pi.events, registry, getConfig);

	// The bridges publish pi-subagents' and pi-interactive-shell's work through the same protocol
	// any provider uses. `attach` runs once the panel has closed: pi-interactive-shell's `/attach
	// <id>` takes over, expanded as a prompt template; a busy agent would queue it, so it waits in
	// the editor.
	const attachBackgroundSession = (id: string): void => {
		const ctx = controller.currentContext();
		if (!ctx) throw new Error("no active session to attach in");
		if (ctx.isIdle()) {
			pi.sendUserMessage(`/attach ${id}`, { expandPromptTemplates: true });
			return;
		}
		ctx.ui.setEditorText(`/attach ${id}`);
		ctx.ui.notify(`Agent busy: /attach ${id} is in the editor`, "info");
	};
	const subagentsBridge = new PiSubagentsBridge(pi.events);
	const interactiveShellBridge = new PiInteractiveShellBridge(pi.events, {
		attach: attachBackgroundSession,
	});
	// The bridges poll their package about once a second only while the panel's session runs.
	const reconcileBridges = (): void => {
		const active = controller.isComponentActive();
		subagentsBridge.setActive(active && getConfig().bridges.piSubagents);
		interactiveShellBridge.setActive(active && getConfig().bridges.piInteractiveShell);
	};

	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		// The config file is read once, when the first session starts; an invalid file warns once.
		if (config === undefined) {
			const loaded = loadBackgroundPanelConfig();
			config = loaded.config;
			if (loaded.warning !== undefined) ctx.ui.notify(loaded.warning, "warning");
		}
		controller.startSession(ctx);
		reconcileBridges();
	});

	// A provider can reinstall a replaced widget between runs; the panel hides its own again.
	pi.on("before_agent_start", (_event, ctx: ExtensionContext) => {
		controller.suppressReplacedWidgets(ctx);
	});

	// New interactive shells start in the background, in the Terminals tab, instead of opening their
	// overlay over the chat; the user opens them from the panel.
	pi.on("tool_call", (event) => {
		if (event.toolName !== INTERACTIVE_SHELL_TOOL) return;
		const settings = getConfig();
		if (!settings.backgroundShells || !settings.bridges.piInteractiveShell) return;
		if (!controller.isComponentActive()) return;
		startShellInBackground(event.input);
	});

	pi.on("session_shutdown", () => {
		controller.shutdown();
		reconcileBridges();
	});
}
