/**
 * The extension's config: a small optional JSON file `background-panel.json` in the agent dir, or
 * `PI_BACKGROUND_PANEL_CONFIG` pointing somewhere else. All fields are optional; a missing file
 * means defaults, an unreadable or invalid file means defaults plus one warning. There is no
 * `enabled` flag: loading the extension enables the panel. The file is read once, when the first
 * session starts.
 */
import { readFileSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

/** The key that opens the panel on an empty editor. */
export type BackgroundPanelOpenKey = "down" | "up" | "ctrl+j";

export interface BackgroundPanelBridgesConfig {
	/** Publish pi-subagents' async runs in the Subagents tab. */
	piSubagents: boolean;
	/** Publish pi-interactive-shell's background sessions in the Terminals tab. */
	piInteractiveShell: boolean;
}

export interface BackgroundPanelConfig {
	openKey: BackgroundPanelOpenKey;
	/** Per-tab order overrides by tab id; a tab without an entry keeps its provider's `order`. */
	tabOrder: Record<string, number>;
	bridges: BackgroundPanelBridgesConfig;
	/** Remove widgets the panel replaces (pi-interactive-shell's `bg-sessions`). */
	hideNativeWidgets: boolean;
}

export const BACKGROUND_PANEL_CONFIG_ENV = "PI_BACKGROUND_PANEL_CONFIG";
export const BACKGROUND_PANEL_CONFIG_FILE = "background-panel.json";
export const DEFAULT_BACKGROUND_PANEL_CONFIG: BackgroundPanelConfig = {
	openKey: "down",
	tabOrder: {},
	bridges: { piSubagents: true, piInteractiveShell: true },
	hideNativeWidgets: true,
};

const OPEN_KEYS: ReadonlySet<string> = new Set(["down", "up", "ctrl+j"]);
const MAX_TAB_ID_CODE_UNITS = 64;

/** `PI_BACKGROUND_PANEL_CONFIG`, then `<agentDir>/background-panel.json`. */
export function resolveConfigPath(envValue: string | undefined, agentDir: string): string {
	return envValue !== undefined && envValue !== ""
		? envValue
		: join(agentDir, BACKGROUND_PANEL_CONFIG_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOpenKey(value: unknown): BackgroundPanelOpenKey {
	return typeof value === "string" && OPEN_KEYS.has(value)
		? (value as BackgroundPanelOpenKey)
		: DEFAULT_BACKGROUND_PANEL_CONFIG.openKey;
}

/** Only entries with a usable tab id and an integer order survive. */
function parseTabOrder(value: unknown): Record<string, number> {
	if (!isRecord(value)) return {};
	const tabOrder: Record<string, number> = {};
	for (const [id, order] of Object.entries(value)) {
		if (id.length === 0 || id.length > MAX_TAB_ID_CODE_UNITS) continue;
		if (typeof order !== "number" || !Number.isSafeInteger(order)) continue;
		tabOrder[id] = order;
	}
	return tabOrder;
}

function parseBridges(value: unknown): BackgroundPanelBridgesConfig {
	return {
		piSubagents:
			isRecord(value) && typeof value.piSubagents === "boolean"
				? value.piSubagents
				: DEFAULT_BACKGROUND_PANEL_CONFIG.bridges.piSubagents,
		piInteractiveShell:
			isRecord(value) && typeof value.piInteractiveShell === "boolean"
				? value.piInteractiveShell
				: DEFAULT_BACKGROUND_PANEL_CONFIG.bridges.piInteractiveShell,
	};
}

function parseHideNativeWidgets(value: unknown): boolean {
	return typeof value === "boolean" ? value : DEFAULT_BACKGROUND_PANEL_CONFIG.hideNativeWidgets;
}

/** Resolves each field independently; an invalid field falls back to its default. */
export function parseConfig(value: unknown): BackgroundPanelConfig {
	if (!isRecord(value)) throw new Error("Expected a JSON object.");
	return {
		openKey: parseOpenKey(value.openKey),
		tabOrder: parseTabOrder(value.tabOrder),
		bridges: parseBridges(value.bridges),
		hideNativeWidgets: parseHideNativeWidgets(value.hideNativeWidgets),
	};
}

export interface LoadedBackgroundPanelConfig {
	config: BackgroundPanelConfig;
	/** Set when the config file exists but could not be used: defaults are in effect. */
	warning?: string;
}

/** Reads the config file; a missing file means defaults, an invalid file defaults with a warning. */
export function loadBackgroundPanelConfig(
	path: string = resolveConfigPath(process.env[BACKGROUND_PANEL_CONFIG_ENV], getAgentDir()),
): LoadedBackgroundPanelConfig {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return { config: { ...DEFAULT_BACKGROUND_PANEL_CONFIG } };
		return {
			config: { ...DEFAULT_BACKGROUND_PANEL_CONFIG },
			warning: `background-panel: could not read ${path}: ${error instanceof Error ? error.message : String(error)}; using defaults`,
		};
	}
	try {
		return { config: parseConfig(JSON.parse(text)) };
	} catch (error) {
		return {
			config: { ...DEFAULT_BACKGROUND_PANEL_CONFIG },
			warning: `background-panel: ${BACKGROUND_PANEL_CONFIG_FILE} is invalid: ${error instanceof Error ? error.message : String(error)}; using defaults`,
		};
	}
}
