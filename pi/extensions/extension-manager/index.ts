import {
	DefaultPackageManager,
	SettingsManager,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	ExtensionManagerComponent,
	lockSuffix,
	noteSuffix,
	type ExtensionLock,
	type ExtensionManagerResult,
	type ExtensionManagerRow,
	type ExtensionNote,
} from "./component.ts";
import {
	readManagerConfig,
	writeManagerConfig,
	type Scope,
} from "./config.ts";
import {
	canonicalPath,
	discoverInventory,
	settingsSources,
	type InventoryEntry,
} from "./discovery.ts";
import { applySavePlan, reloadGlobalSettings, settingsError, validateGlobalRoot } from "./settings.ts";
import {
	baselineScope,
	entryKey,
	isScopeEnabled,
	isStagedChange,
	planSave,
	reconcileOwned,
	TABS,
	toggledScope,
	type EntryScope,
} from "./state.ts";

export const SAVE_CHOICE = "Save changes";
export const CANCEL_CHOICE = "Cancel";
export const SCOPE_LABELS: Record<Scope, string> = { global: "Pi (global)", bb: "BB" };
const SCOPE_SWITCH: Record<Scope, string> = {
	global: "Switch to BB scope",
	bb: "Switch to Pi (global) scope",
};

const defaultConfigDir = dirname(fileURLToPath(import.meta.url));
let configDirOverride: string | undefined;

/** Test hook: production keeps the tracked config beside this module. */
export function setConfigDirectoryForTesting(directory: string | undefined): void {
	configDirOverride = directory;
}

function configDirectory(): string {
	return configDirOverride ?? defaultConfigDir;
}

const managerPath = canonicalPath(fileURLToPath(import.meta.url));
const loaderPath = join(defaultConfigDir, "loader.ts");

/** The manager cannot disable itself; `/extensions-manager` has to stay reachable. */
export function isManagerEntry(entry: InventoryEntry): boolean {
	return entry.kind === "local" && canonicalPath(entry.path) === managerPath;
}

interface ManagerState {
	settingsManager: SettingsManager;
	agentDir: string;
	configDir: string;
	entries: InventoryEntry[];
	/** Scope before anything was staged, and the staged scope per entry key. */
	baseline: Map<string, EntryScope>;
	staged: Map<string, EntryScope>;
}

function stagedScope(state: ManagerState, entry: InventoryEntry): EntryScope {
	const key = entryKey(entry);
	return state.staged.get(key) ?? state.baseline.get(key) ?? "enabled";
}

function rowLock(state: ManagerState, entry: InventoryEntry, tab: Scope): ExtensionLock | undefined {
	if (isManagerEntry(entry)) return "required";
	// The BB tab can only narrow the global scope, exactly like Pi's own settings layers.
	if (tab === "bb" && stagedScope(state, entry) === "global") return "global-off";
	return undefined;
}

/** Informational, not a lock: an owned package can still be toggled while its install is gone. */
function rowNote(entry: InventoryEntry): ExtensionNote | undefined {
	if (entry.kind === "local" || entry.installed) return undefined;
	return "not-installed";
}

/** Component tabs are indexes; the first tab is the global scope. */
function tabScope(tab: number): Scope {
	return TABS[tab] === "bb" ? "bb" : "global";
}

function stagedCount(state: ManagerState): number {
	let count = 0;
	for (const entry of state.entries) {
		const key = entryKey(entry);
		if (isStagedChange(state.staged.get(key), state.baseline.get(key))) count++;
	}
	return count;
}

function toggleEntry(
	state: ManagerState,
	key: string,
	tab: Scope,
	notify: (message: string, type: "warning") => void,
): void {
	const entry = state.entries.find((candidate) => entryKey(candidate) === key);
	if (!entry) return;
	if (isManagerEntry(entry)) {
		notify("The extension manager keeps itself enabled so disabled extensions remain recoverable", "warning");
		return;
	}
	const next = toggledScope(stagedScope(state, entry), tab);
	if (next === undefined) {
		notify("This extension is disabled on the Pi (global) tab; enable it there before toggling the BB tab", "warning");
		return;
	}
	state.staged.set(key, next);
}

async function loadState(ctx: ExtensionCommandContext): Promise<ManagerState> {
	const agentDir = getAgentDir();
	validateGlobalRoot(agentDir);
	const settingsManager = SettingsManager.create(ctx.cwd, agentDir, { projectTrusted: false });
	const loadError = settingsError("Cannot read global settings", settingsManager.drainErrors());
	if (loadError) throw new Error(loadError);

	const configDir = configDirectory();
	// The tracked config names the owned packages; settings names everything Pi loads itself.
	const initial = readManagerConfig(configDir);
	// A malformed config still opens the menu so it can be repaired by a save.
	for (const warning of initial.warnings) ctx.ui.notify(warning, "warning");
	const inventory = await discoverInventory({
		cwd: ctx.cwd,
		agentDir,
		settingsManager,
		ownedPackages: Object.keys(initial.packages),
		// The loader is this extension's own settings entry, not a toggleable row.
		excludePaths: [loaderPath],
	});
	// A package that is back in settings.json is loaded by Pi before any toggle runs, so its
	// tracked scope is stale: treat it as enabled everywhere and let the next save drop it.
	const reconciled = reconcileOwned(
		initial,
		settingsSources(settingsManager.getGlobalSettings().packages ?? []),
	);
	for (const source of reconciled.stale) {
		ctx.ui.notify(`${source} is listed in settings.json again, so it is enabled everywhere; saving removes its managed scope`, "warning");
	}
	const entries = [...inventory.entries].sort((left, right) => left.label.localeCompare(right.label));
	const baseline = new Map<string, EntryScope>();
	for (const entry of entries) {
		baseline.set(entryKey(entry), isManagerEntry(entry) ? "enabled" : baselineScope(entry, reconciled.config));
	}
	return {
		settingsManager,
		agentDir,
		configDir,
		entries,
		baseline,
		staged: new Map(baseline),
	};
}

function managerRows(state: ManagerState): ExtensionManagerRow[] {
	return state.entries.map((entry) => ({
		id: entryKey(entry),
		label: entry.label,
		searchText: `${entry.label} ${entry.kind}`,
		enabled: isScopeEnabled(stagedScope(state, entry), "global"),
	}));
}

async function openSelectManager(
	ctx: ExtensionCommandContext,
	state: ManagerState,
): Promise<ExtensionManagerResult> {
	let scope: Scope = "global";
	while (true) {
		const choices = state.entries.map((entry) => {
			const lock = rowLock(state, entry, scope);
			return `${isScopeEnabled(stagedScope(state, entry), scope) ? "[x]" : "[ ]"} ${entry.label}${lockSuffix(lock)}${lock ? "" : noteSuffix(rowNote(entry))}`;
		});
		const choiceToKey = new Map(choices.map((choice, index) => [choice, entryKey(state.entries[index])]));
		const count = stagedCount(state);
		const title = count > 0
			? `Extensions · ${SCOPE_LABELS[scope]} (${count} staged)`
			: `Extensions · ${SCOPE_LABELS[scope]} (select to toggle)`;
		const choice = await ctx.ui.select(title, [...choices, SCOPE_SWITCH[scope], SAVE_CHOICE, CANCEL_CHOICE]);
		if (choice === undefined || choice === CANCEL_CHOICE) {
			if (stagedCount(state) === 0 || await ctx.ui.confirm(
				"Discard extension changes?",
				"Discard staged changes? Choose No to keep editing.",
			)) return "cancel";
			continue;
		}
		if (choice === SAVE_CHOICE) return "save";
		if (choice === SCOPE_SWITCH[scope]) {
			scope = scope === "global" ? "bb" : "global";
			continue;
		}
		const key = choiceToKey.get(choice);
		if (key) toggleEntry(state, key, scope, (message, type) => ctx.ui.notify(message, type));
	}
}

async function openTuiManager(
	ctx: ExtensionCommandContext,
	state: ManagerState,
): Promise<ExtensionManagerResult | undefined> {
	const rows = managerRows(state);
	const byKey = new Map(state.entries.map((entry) => [entryKey(entry), entry]));
	let getTerminalWidth = () => 1;
	return ctx.ui.custom<ExtensionManagerResult | undefined>((tui, theme, keybindings, done) => {
		getTerminalWidth = () => tui.terminal.columns;
		return new ExtensionManagerComponent({
			rows,
			theme,
			keybindings,
			tabs: TABS.map((tab) => SCOPE_LABELS[tab]),
			getHeight: () => Math.max(1, Math.min(19, tui.terminal.rows - 2)),
			getWidth: () => tui.terminal.columns,
			getTerminalHeight: () => tui.terminal.rows,
			getEnabled: (row, tab) => {
				const entry = byKey.get(row.id);
				return entry ? isScopeEnabled(stagedScope(state, entry), tabScope(tab)) : row.enabled;
			},
			getLock: (row, tab) => {
				const entry = byKey.get(row.id);
				return entry ? rowLock(state, entry, tabScope(tab)) : undefined;
			},
			getNote: (row) => {
				const entry = byKey.get(row.id);
				return entry ? rowNote(entry) : undefined;
			},
			getStagedCount: () => stagedCount(state),
			onToggle: (row, tab) => {
				if (!byKey.has(row.id)) return;
				toggleEntry(state, row.id, tabScope(tab), (message, type) => ctx.ui.notify(message, type));
			},
			onChange: () => tui.requestRender(),
			onDone: done,
		});
	}, {
		overlay: true,
		overlayOptions: {
			// OverlayOptions has no maxWidth, so cap its percentage width on each layout read.
			get width() {
				return Math.max(1, Math.min(Math.floor(getTerminalWidth() * 0.8), 96));
			},
			maxHeight: 19,
			margin: { left: 1, right: 1 },
			anchor: "center",
		},
	});
}

async function saveManager(ctx: ExtensionCommandContext, state: ManagerState): Promise<void> {
	const changed = stagedCount(state);
	if (changed === 0) {
		ctx.ui.notify("No extension changes to save", "info");
		return;
	}

	// Fresh settings and a fresh config: a concurrent edit must not be overwritten or lost.
	await reloadGlobalSettings(state.settingsManager, state.agentDir);
	const current = state.settingsManager.getGlobalSettings();
	const latest = readManagerConfig(state.configDir);
	// A source that reappeared in settings while the menu was open is loaded by Pi itself.
	const reconciled = reconcileOwned(latest, settingsSources(current.packages ?? []));
	const plan = planSave({
		packages: current.packages ?? [],
		extensionPaths: current.extensions ?? [],
		entries: state.entries,
		staged: state.staged,
		baseline: state.baseline,
		config: { packages: reconciled.config.packages, extensions: reconciled.config.extensions },
	});
	const strayManager = state.entries.some((entry) =>
		isManagerEntry(entry) && latest.extensions[entry.id] !== undefined);

	// Settings first: a failure there must not leave a config that claims the move happened.
	await applySavePlan(state.settingsManager, plan);
	writeManagerConfig(state.configDir, plan.config);

	ctx.ui.notify(
		`Saved ${changed} extension change${changed === 1 ? "" : "s"}; reload Pi for changes to take effect`,
		"info",
	);
	if (strayManager) {
		ctx.ui.notify("The extension manager cannot be disabled; removed it from the disabled lists", "info");
	}
}

/**
 * `pi update` only reconciles sources listed in settings, so owned packages would never update.
 *
 * Pi's own update pass is reused against an in-memory settings view holding exactly the owned
 * sources: pinned npm versions are skipped and pinned git refs are reconciled by Pi itself.
 */
async function updateOwnedPackages(ctx: ExtensionCommandContext): Promise<void> {
	const config = readManagerConfig(configDirectory());
	const sources = Object.keys(config.packages).sort();
	if (sources.length === 0) {
		ctx.ui.notify("No owned packages to update", "info");
		return;
	}
	const settingsManager = SettingsManager.inMemory({ packages: sources }, { projectTrusted: false });
	const manager = new DefaultPackageManager({ cwd: ctx.cwd, agentDir: getAgentDir(), settingsManager });
	const plural = sources.length === 1 ? "" : "s";
	ctx.ui.notify(`Updating ${sources.length} owned package${plural}...`, "info");
	try {
		await manager.update();
	} catch (error) {
		ctx.ui.notify(
			`Updating owned packages failed: ${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
		return;
	}
	ctx.ui.notify(`Updated ${sources.length} owned package${plural}; reload Pi to apply`, "info");
}

async function openManager(ctx: ExtensionCommandContext): Promise<void> {
	const state = await loadState(ctx);
	if (state.entries.length === 0) {
		ctx.ui.notify("No global extensions found", "warning");
		return;
	}
	const result = ctx.mode === "tui" ? await openTuiManager(ctx, state) : await openSelectManager(ctx, state);
	if (result !== "save") {
		if (stagedCount(state) > 0) ctx.ui.notify("Extension changes discarded", "info");
		return;
	}
	await saveManager(ctx, state);
}

export default function extensionManager(pi: ExtensionAPI): void {
	let opening = false;
	pi.registerCommand("extensions-manager", {
		description: "Toggle packages and local extensions per host; add `update` to refresh owned packages",
		handler: async (args, ctx) => {
			if (opening) return;
			opening = true;
			try {
				if (!ctx.hasUI) throw new Error("/extensions-manager requires interactive or RPC UI mode");
				if (args.trim() === "update") await updateOwnedPackages(ctx);
				else await openManager(ctx);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (ctx.hasUI) ctx.ui.notify(`Extension manager failed: ${message}`, "error");
				else throw error;
			} finally {
				opening = false;
			}
		},
	});
}
