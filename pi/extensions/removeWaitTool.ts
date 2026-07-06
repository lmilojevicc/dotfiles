/**
 * removeWaitTool — hide the `wait` tool from the LLM.
 *
 * pi-subagents registers a `wait` tool (src/runs/background/wait.ts) that
 * blocks the current turn until async subagent runs complete. In an
 * interactive TUI session this is unnecessary — the model should just end
 * the turn and let Pi deliver completions via pi.sendMessage({ triggerTurn:
 * true }). Forcing `wait` out of the active set keeps the LLM from
 * voluntarily holding the turn open.
 *
 * Mechanism: pi has no first-class per-tool kill switch (no `disabledTools`
 * in settings, no unregisterTool API). The supported lever is
 * `pi.setActiveTools([...names])` (docs/extensions.md:1568), which works
 * for both built-in and dynamically-registered tools. We hook session_start
 * and strip "wait" from the active set.
 *
 * Load order matters: this extension must load AFTER pi-subagents so that
 * the `wait` tool is already registered when we filter it out. Order in
 * `~/.pi/agent/settings.json` -> `packages` determines load order.
 *
 * Optional env override: PI_KEEP_WAIT=1 skips the filter (for debugging or
 * for non-interactive runs where `wait` is actually useful).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const WAIT_TOOL_NAME = "wait";

export default function removeWaitTool(pi: ExtensionAPI) {
	const keep = process.env.PI_KEEP_WAIT === "1";
	if (keep) return;

	pi.on("session_start", () => {
		const all = pi.getAllTools().map((t) => t.name);
		if (!all.includes(WAIT_TOOL_NAME)) return; // not installed; nothing to do

		const active = pi.getActiveTools().filter((n) => n !== WAIT_TOOL_NAME);
		pi.setActiveTools(active);
	});
}
