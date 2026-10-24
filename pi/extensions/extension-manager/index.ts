import {
	DefaultPackageManager,
	getAgentDir,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type PackageSource,
	type ResolvedResource,
} from "@earendil-works/pi-coding-agent";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ExtensionManagerComponent, type ExtensionManagerResult, type ExtensionManagerRow } from "./component.ts";
import { applyExtensionChanges, type ExtensionChange } from "./state.ts";

export const SAVE_CHOICE = "Save changes";
export const CANCEL_CHOICE = "Cancel";

const selfPath = canonicalPath(fileURLToPath(import.meta.url));

function canonicalPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

export function isManagerResource(resource: ResolvedResource): boolean {
	return canonicalPath(resource.path) === selfPath;
}

function slash(path: string): string {
	return path.replaceAll("\\", "/");
}

function resourceName(resource: ResolvedResource, agentDir: string): string {
	const baseDir = resource.metadata.baseDir ?? agentDir;
	const path = slash(relative(baseDir, resource.path)) || basename(resource.path);
	const source = resource.metadata.origin === "package"
		? resource.metadata.source
		: "local";
	return `${source} · ${path}`;
}

function errorMessage(prefix: string, errors: Array<{ error: Error }>): string | undefined {
	if (errors.length === 0) return undefined;
	return `${prefix}: ${errors.map(({ error }) => error.message).join("; ")}`;
}

/** Native settings accepts absent/empty files or an object root, but not other JSON roots. */
function validateGlobalRoot(agentDir: string): void {
	let content: string;
	try {
		content = readFileSync(join(agentDir, "settings.json"), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (content === "") return;
	const root: unknown = JSON.parse(content.replace(/^\uFEFF/, ""));
	if (!root || typeof root !== "object" || Array.isArray(root)) {
		throw new Error("Global settings.json must contain a JSON object");
	}
}

function packageSource(pkg: PackageSource): string {
	return typeof pkg === "string" ? pkg : pkg.source;
}

function isFile(path: string | undefined): boolean {
	if (!path) return false;
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

async function discoverDeltaPackageExtensions(
	cwd: string,
	agentDir: string,
	packages: readonly PackageSource[],
	npmCommand: string[] | undefined,
): Promise<ResolvedResource[]> {
	const deltaPackages = packages.filter(
		(pkg): pkg is Exclude<PackageSource, string> => typeof pkg !== "string" && pkg.autoload === false,
	);
	if (deltaPackages.length === 0) return [];

	// A delta package only returns resources named by its filters. Resolve the same
	// installed package without those filters so the menu can also enable omitted
	// extensions; "skip" guarantees discovery never installs a missing package.
	const discoverySettings = SettingsManager.inMemory({
		npmCommand,
		packages: deltaPackages.map(packageSource),
	}, { projectTrusted: false });
	const discoveryManager = new DefaultPackageManager({ cwd, agentDir, settingsManager: discoverySettings });
	const discovered = await discoveryManager.resolve(async () => "skip");
	return discovered.extensions.filter((resource) => resource.metadata.scope === "user");
}

async function loadGlobalExtensions(ctx: ExtensionCommandContext): Promise<{
	settingsManager: SettingsManager;
	resources: ResolvedResource[];
	localFilePackageSources: ReadonlySet<string>;
	agentDir: string;
}> {
	const agentDir = getAgentDir();
	validateGlobalRoot(agentDir);
	const settingsManager = SettingsManager.create(ctx.cwd, agentDir, { projectTrusted: false });
	const loadError = errorMessage("Cannot read global settings", settingsManager.drainErrors());
	if (loadError) throw new Error(loadError);

	const packageManager = new DefaultPackageManager({ cwd: ctx.cwd, agentDir, settingsManager });
	const resolved = await packageManager.resolve(async () => "skip");
	const globalSettings = settingsManager.getGlobalSettings();
	const localFilePackageSources = new Set<string>();
	for (const pkg of globalSettings.packages ?? []) {
		const source = packageSource(pkg);
		const installedPath = packageManager.getInstalledPath(source, "user");
		if (isFile(installedPath)) localFilePackageSources.add(source);
	}
	const resources = resolved.extensions.filter((resource) => resource.metadata.scope === "user");
	const knownPaths = new Set(resources.map((resource) => canonicalPath(resource.path)));
	const discovered = await discoverDeltaPackageExtensions(
		ctx.cwd,
		agentDir,
		globalSettings.packages ?? [],
		globalSettings.npmCommand,
	);
	for (const resource of discovered) {
		const path = canonicalPath(resource.path);
		if (knownPaths.has(path)) continue;
		knownPaths.add(path);
		resources.push({ ...resource, enabled: false });
	}
	resources.sort((left, right) => resourceName(left, agentDir).localeCompare(resourceName(right, agentDir)));
	return { settingsManager, resources, localFilePackageSources, agentDir };
}

async function persistChanges(
	settingsManager: SettingsManager,
	resources: readonly ResolvedResource[],
	desired: ReadonlyMap<string, boolean>,
	agentDir: string,
): Promise<number> {
	const changes: ExtensionChange[] = [];
	for (const resource of resources) {
		const enabled = desired.get(resource.path);
		if (enabled !== undefined && enabled !== resource.enabled) {
			changes.push({ resource, enabled });
		}
	}
	if (changes.length === 0) return 0;

	validateGlobalRoot(agentDir);
	await settingsManager.reload();
	const reloadError = errorMessage("Could not refresh global settings", settingsManager.drainErrors());
	if (reloadError) throw new Error(reloadError);
	validateGlobalRoot(agentDir);
	const current = settingsManager.getGlobalSettings();
	const update = applyExtensionChanges(
		current.extensions ?? [],
		current.packages ?? [],
		changes,
		agentDir,
	);
	if (update.extensionPathsChanged) settingsManager.setExtensionPaths(update.extensionPaths);
	if (update.packagesChanged) settingsManager.setPackages(update.packages);
	await settingsManager.flush();

	const saveError = errorMessage("Could not save extension settings", settingsManager.drainErrors());
	if (saveError) throw new Error(saveError);
	return changes.length;
}

function stagedCount(resources: readonly ResolvedResource[], desired: ReadonlyMap<string, boolean>): number {
	return resources.filter((resource) => desired.get(resource.path) !== resource.enabled).length;
}

function toggleResource(
	ctx: ExtensionCommandContext,
	resource: ResolvedResource,
	desired: Map<string, boolean>,
	localFilePackageSources: ReadonlySet<string>,
): void {
	if (isManagerResource(resource)) {
		ctx.ui.notify("The extension manager keeps itself enabled so disabled extensions remain recoverable", "warning");
		return;
	}
	if (localFilePackageSources.has(resource.metadata.source)) {
		ctx.ui.notify("Pi does not support extension filters for local-file packages; configure a directory package to make this extension toggleable", "warning");
		return;
	}
	desired.set(resource.path, !(desired.get(resource.path) ?? resource.enabled));
}

async function openSelectManager(
	ctx: ExtensionCommandContext,
	resources: readonly ResolvedResource[],
	desired: Map<string, boolean>,
	localFilePackageSources: ReadonlySet<string>,
	agentDir: string,
): Promise<ExtensionManagerResult> {
	while (true) {
		const choices = resources.map((resource) => {
			const enabled = desired.get(resource.path) ?? resource.enabled;
			const lock = isManagerResource(resource)
				? " · required"
				: localFilePackageSources.has(resource.metadata.source)
					? " · unavailable (local file package)"
					: "";
			return `${enabled ? "[x]" : "[ ]"} ${resourceName(resource, agentDir)}${lock}`;
		});
		const choiceToResource = new Map(choices.map((choice, index) => [choice, resources[index]]));
		const count = stagedCount(resources, desired);
		const choice = await ctx.ui.select(
			count > 0 ? `Extensions (${count} staged)` : "Extensions (select to toggle)",
			[...choices, SAVE_CHOICE, CANCEL_CHOICE],
		);
		if (choice === undefined || choice === CANCEL_CHOICE) {
			if (stagedCount(resources, desired) === 0 || await ctx.ui.confirm(
				"Discard extension changes?",
				"Discard staged changes? Choose No to keep editing.",
			)) return "cancel";
			continue;
		}
		if (choice === SAVE_CHOICE) return "save";
		const resource = choiceToResource.get(choice);
		if (resource) toggleResource(ctx, resource, desired, localFilePackageSources);
	}
}

async function openTuiManager(
	ctx: ExtensionCommandContext,
	resources: readonly ResolvedResource[],
	desired: Map<string, boolean>,
	localFilePackageSources: ReadonlySet<string>,
	agentDir: string,
): Promise<ExtensionManagerResult | undefined> {
	const rows: ExtensionManagerRow[] = resources.map((resource) => {
		const label = resourceName(resource, agentDir);
		return {
			id: resource.path,
			label,
			searchText: `${label} ${resource.path} ${resource.metadata.source} ${resource.metadata.origin}`,
			enabled: resource.enabled,
			lock: isManagerResource(resource)
				? "required"
				: localFilePackageSources.has(resource.metadata.source) ? "local-file-package" : undefined,
		};
	});
	const byPath = new Map(resources.map((resource) => [resource.path, resource]));
	let getTerminalWidth = () => 1;
	return ctx.ui.custom<ExtensionManagerResult | undefined>((tui, theme, keybindings, done) => {
		getTerminalWidth = () => tui.terminal.columns;
		return new ExtensionManagerComponent({
			rows,
			theme,
			keybindings,
			getHeight: () => Math.max(1, Math.min(19, tui.terminal.rows - 2)),
			getWidth: () => tui.terminal.columns,
			getTerminalHeight: () => tui.terminal.rows,
			getEnabled: (row) => desired.get(row.id) ?? row.enabled,
			getStagedCount: () => stagedCount(resources, desired),
			onToggle: (row) => {
				const resource = byPath.get(row.id);
				if (resource) toggleResource(ctx, resource, desired, localFilePackageSources);
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

async function openManager(ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) throw new Error("/extensions-manager requires interactive or RPC UI mode");

	const { settingsManager, resources, localFilePackageSources, agentDir } = await loadGlobalExtensions(ctx);
	if (resources.length === 0) {
		ctx.ui.notify("No global extensions found", "warning");
		return;
	}

	const desired = new Map(
		resources.map((resource) => [resource.path, isManagerResource(resource) || resource.enabled]),
	);
	const result = ctx.mode === "tui"
		? await openTuiManager(ctx, resources, desired, localFilePackageSources, agentDir)
		: await openSelectManager(ctx, resources, desired, localFilePackageSources, agentDir);
	if (result !== "save") {
		if (stagedCount(resources, desired) > 0) ctx.ui.notify("Extension changes discarded", "info");
		return;
	}

	const changed = await persistChanges(settingsManager, resources, desired, agentDir);
	if (changed === 0) {
		ctx.ui.notify("No extension changes to save", "info");
		return;
	}
	ctx.ui.notify(`Saved ${changed} extension change${changed === 1 ? "" : "s"}; reload Pi for changes to take effect`, "info");
}

export default function extensionManager(pi: ExtensionAPI): void {
	let opening = false;
	pi.registerCommand("extensions-manager", {
		description: "Save global extension settings (reload Pi to apply)",
		handler: async (_args, ctx) => {
			if (opening) return;
			opening = true;
			try {
				await openManager(ctx);
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
