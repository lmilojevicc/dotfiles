import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	BACKGROUND_PANEL_CONFIG_ENV,
	DEFAULT_BACKGROUND_PANEL_CONFIG,
	loadBackgroundPanelConfig,
	parseConfig,
	resolveConfigPath,
} from "../config.ts";

const envPaths: string[] = [];

/** Points `PI_BACKGROUND_PANEL_CONFIG` at a temp file for this test; restored afterwards. */
function withEnvConfig(setup: (path: string) => void): string {
	const directory = mkdtempSync(join(tmpdir(), "background-panel-config-"));
	const path = join(directory, "background-panel.json");
	envPaths.push(directory);
	process.env[BACKGROUND_PANEL_CONFIG_ENV] = path;
	setup(path);
	return path;
}

afterEach(() => {
	delete process.env[BACKGROUND_PANEL_CONFIG_ENV];
	for (const directory of envPaths.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("background panel config", () => {
	it("defaults to the open key ↓, both bridges, hidden native widgets, and background shells", () => {
		assert.deepEqual(parseConfig({}), DEFAULT_BACKGROUND_PANEL_CONFIG);
		// A non-object is the invalid-file case: loadBackgroundPanelConfig turns it into defaults plus
		// a warning (covered below); parseConfig itself rejects it.
		assert.throws(() => parseConfig(null), /Expected a JSON object/);
	});

	it("resolves each field independently and ignores invalid values", () => {
		const config = parseConfig({
			openKey: "ctrl+j",
			tabOrder: { shell: 5, subagents: "first", ["x".repeat(65)]: 1, terminals: 2.5 },
			bridges: { piSubagents: false, piInteractiveShell: "no" },
			hideNativeWidgets: false,
			backgroundShells: "yes",
		});
		assert.deepEqual(config, {
			openKey: "ctrl+j",
			tabOrder: { shell: 5 },
			bridges: { piSubagents: false, piInteractiveShell: true },
			hideNativeWidgets: false,
			backgroundShells: true,
		});
		assert.equal(parseConfig({ openKey: "enter" }).openKey, "down");
	});

	it("prefers PI_BACKGROUND_PANEL_CONFIG over the agent dir", () => {
		assert.equal(resolveConfigPath("/tmp/other.json", "/tmp/agent"), "/tmp/other.json");
		assert.equal(
			resolveConfigPath(undefined, "/tmp/agent"),
			join("/tmp/agent", "background-panel.json"),
		);
		assert.equal(resolveConfigPath("", "/tmp/agent"), join("/tmp/agent", "background-panel.json"));
	});

	it("a missing file means defaults, without a warning", () => {
		withEnvConfig(() => {});
		const loaded = loadBackgroundPanelConfig();
		assert.deepEqual(loaded.config, DEFAULT_BACKGROUND_PANEL_CONFIG);
		assert.equal(loaded.warning, undefined);
	});

	it("an invalid file falls back to defaults with one warning", () => {
		withEnvConfig((path) => writeFileSync(path, "{ not json"));
		const loaded = loadBackgroundPanelConfig();
		assert.deepEqual(loaded.config, DEFAULT_BACKGROUND_PANEL_CONFIG);
		assert.match(loaded.warning ?? "", /background-panel\.json is invalid/);
		assert.match(loaded.warning ?? "", /using defaults/);
	});

	it("a non-object file falls back to defaults with one warning", () => {
		withEnvConfig((path) => writeFileSync(path, "[1, 2]"));
		const loaded = loadBackgroundPanelConfig();
		assert.deepEqual(loaded.config, DEFAULT_BACKGROUND_PANEL_CONFIG);
		assert.match(loaded.warning ?? "", /Expected a JSON object/);
	});

	it("reads a valid file from the env override path", () => {
		withEnvConfig((path) =>
			writeFileSync(
				path,
				JSON.stringify({
					openKey: "up",
					tabOrder: { subagents: 5 },
					bridges: { piInteractiveShell: false },
					hideNativeWidgets: false,
					backgroundShells: false,
				}),
			),
		);
		const loaded = loadBackgroundPanelConfig();
		assert.deepEqual(loaded.config, {
			openKey: "up",
			tabOrder: { subagents: 5 },
			bridges: { piSubagents: true, piInteractiveShell: false },
			hideNativeWidgets: false,
			backgroundShells: false,
		});
		assert.equal(loaded.warning, undefined);
	});
});
