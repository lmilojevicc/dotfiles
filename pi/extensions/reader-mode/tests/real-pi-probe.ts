// Loaded only by real-pi-pty.py, through the installed CLI's own extension loader.
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { CustomEditor, InteractiveMode, VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { addVisualMargin, SUPPORTED_PI_VERSION } from "../index.ts";

const patchKey = Symbol.for("dotfiles.reader-mode.layout-patch.v1");
const probeKey = Symbol.for("dotfiles.reader-mode.cli-smoke");
const globals = globalThis as any;
const report = (event: string, details = {}) => appendFileSync(process.env.READER_SMOKE_REPORT!, `${JSON.stringify({ event, ...details })}\n`);

export default function (pi: ExtensionAPI) {
	assert.equal(VERSION, SUPPORTED_PI_VERSION);
	const record = globals[patchKey];
	assert.ok(record && !record.error && !record.disabled, "reader installed through CLI loader");
	assert.equal(record.prototype, InteractiveMode.prototype, "loader imports the patched host class");
	const previous = globals[probeKey];

	pi.on("session_start", (event, ctx) => {
		const mode = record.mountedInstance;
		assert.ok(mode instanceof InteractiveMode, "the actual CLI mounted the imported class, not a separate SDK copy");
		assert.equal(record.latestRenderer, mode.renderer);
		assert.equal(record.components.size, 7);
		ctx.ui.setWidget("reader-smoke", ["READER_SMOKE_CONTENT"]);
		report(event.reason === "reload" ? "reloaded" : "ready", { mode: mode.renderer.mode });
	});
	// Fail closed if a driver typo would otherwise reach a model.
	pi.on("input", (_event, ctx) => {
		report("failure", { error: "CLI smoke must never submit a model prompt" });
		ctx.shutdown();
		return { action: "handled" };
	});

	pi.registerCommand("reader-smoke", {
		handler: async (stage, ctx) => {
			try {
				const mode = record.mountedInstance;
				assert.equal(record.error, undefined);
				assert.equal(record.state.enabled, stage !== "off");
				assert.equal(record.state.width, 110);
				assert.equal(record.latestRenderer, mode.renderer);
				assert.deepEqual([...record.components.keys()], mode.renderer.children);
				const columns = mode.renderer.terminal.columns;
				assert.equal(columns, 140);
				for (const patch of record.components.values()) {
					const width = stage === "off" ? columns : 110;
					const original = patch.originalRender.call(patch.component, width);
					const expected = stage === "off" ? original : original.map((line: string) => addVisualMargin(line, " ".repeat(15)));
					assert.deepEqual(patch.component.render(columns), expected, "actual host region rendering");
					assert.ok(expected.every((line: string) => visibleWidth(line) <= columns));
				}
				if (stage === "baseline") {
					globals[probeKey] = {
						instance: mode, renderer: mode.renderer, owner: record.owner,
						mount: InteractiveMode.prototype.mountInteractiveTui,
						renders: [...record.components.keys()].map((component: any) => component.render),
					};
					// Exercise 0.85.0's two working-indicator placements without an agent turn.
					ctx.ui.setWorkingMessage("READER_SMOKE_WORKING");
					ctx.ui.setWorkingIndicator({ frames: ["*"] });
					mode.showWorkingStatusIndicator();
					assert.equal(mode.activeWorkingIndicatorEmbedded, true);
					assert.ok(mode.editorContainer.render(columns).some((line: string) => line.includes("READER_SMOKE_WORKING")));
					mode.clearStatusIndicator();
					ctx.ui.setEditorComponent((tui, theme, keybindings) => new CustomEditor(tui, theme, keybindings));
					mode.showWorkingStatusIndicator();
					assert.equal(mode.activeWorkingIndicatorEmbedded, false);
					assert.ok(mode.statusContainer.render(columns).some((line: string) => line.includes("READER_SMOKE_WORKING")));
					mode.clearStatusIndicator();
					ctx.ui.setEditorComponent(undefined);
				} else if (stage === "switched") {
					const baseline = globals[probeKey];
					assert.equal(mode, baseline.instance);
					assert.notEqual(mode.renderer, baseline.renderer, "genuine /settings remount");
					assert.notEqual(mode.renderer.mode, baseline.renderer.mode);
					assert.equal(mode.settingsManager.getTuiMode(), mode.renderer.mode);
				} else if (stage === "reload") {
					assert.ok(previous, "probe factory was reloaded");
					assert.equal(mode, previous.instance);
					assert.notEqual(record.owner, previous.owner, "reader ownership transferred");
					assert.equal(InteractiveMode.prototype.mountInteractiveTui, previous.mount);
					assert.deepEqual([...record.components.keys()].map((component: any) => component.render), previous.renders);
				} else {
					assert.equal(stage, "off");
				}
				if (mode.renderer.mode === "fullscreen") {
					assert.equal(mode.renderer.layoutRoot, mode.fullscreenLayoutRoot, "fullscreen layout root is not wrapped");
				}
				mode.renderer.invalidate();
				mode.renderer.renderNow();
				report(stage, { version: VERSION, mode: mode.renderer.mode, columns, roots: record.components.size });
			} catch (error) {
				report("failure", { error: String(error), stack: (error as Error).stack });
				ctx.shutdown();
			}
		},
	});
}
