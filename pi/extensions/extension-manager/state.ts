import type { PackageSource } from "@earendil-works/pi-coding-agent";
import type { DisabledMap, ManagerConfig, Scope } from "./config.ts";
import { packageSource, type InventoryEntry } from "./discovery.ts";

/**
 * A package or local extension is either listed in settings (enabled everywhere) or owned by
 * `extension-manager.json`, where the value names the host scope that disables it.
 */
export type EntryScope = "enabled" | Scope;

/** Menu tabs, in display order; the label mapping lives in `index.ts`. */
export const TABS = ["global", "bb"] as const;

export function entryKey(entry: InventoryEntry): string {
	return `${entry.kind}:${entry.id}`;
}

/** Global disables apply everywhere; a `bb` scope only removes the entry inside BB. */
export function isScopeEnabled(scope: EntryScope, tab: Scope): boolean {
	return tab === "global" ? scope !== "global" : scope === "enabled";
}

/**
 * The scope a toggle produces, or undefined when the tab locks the row.
 *
 * The BB tab cannot disable an entry that is already off globally; it stays unavailable until
 * the global tab re-enables it, exactly like Pi's own two-layer settings.
 */
export function toggledScope(scope: EntryScope, tab: Scope): EntryScope | undefined {
	if (tab === "global") return scope === "global" ? "enabled" : "global";
	if (scope === "global") return undefined;
	return scope === "bb" ? "enabled" : "bb";
}

export function isStagedChange(staged: EntryScope | undefined, baseline: EntryScope | undefined): boolean {
	return staged !== baseline;
}

/** Settings order decides load order, so an enabled entry keeps its position when it returns. */
function withPlainString(packages: readonly PackageSource[], source: string): PackageSource[] {
	if (packages.some((pkg) => packageSource(pkg) === source)) return [...packages];
	return [...packages, source];
}

function normalizePatternTarget(pattern: string): string {
	const withoutDotPrefix = pattern.startsWith("./") || pattern.startsWith(".\\")
		? pattern.slice(2)
		: pattern;
	return withoutDotPrefix.replaceAll("\\", "/");
}

function isExactOverride(pattern: string): boolean {
	return pattern.startsWith("+") || pattern.startsWith("-") || pattern.startsWith("!");
}

/** Remove every exact override that already targets this local entrypoint. */
function withoutLocalOverrides(
	extensionPaths: readonly string[],
	targets: ReadonlySet<string>,
): string[] {
	return extensionPaths.filter((entry) =>
		!(isExactOverride(entry) && targets.has(normalizePatternTarget(entry.slice(1)))));
}

function localTargets(entry: { id: string; path?: string }): Set<string> {
	return new Set([entry.id, `./${entry.id}`, entry.path]
		.filter((value): value is string => typeof value === "string")
		.map(normalizePatternTarget));
}

export interface SavePlan {
	packages: PackageSource[];
	extensionPaths: string[];
	packagesChanged: boolean;
	extensionPathsChanged: boolean;
	config: ManagerConfig;
}

/**
 * Translate staged scopes into the two files the design keeps in sync.
 *
 * Settings only ever gains or loses plain package strings and one exact `-path` line per disabled
 * local extension; everything else in the file is left for SettingsManager to preserve untouched.
 * A package disabled anywhere is owned by the tracked config and absent from settings, because Pi
 * cannot unload an extension it loaded from settings.
 */
export function planSave(input: {
	packages: readonly PackageSource[];
	extensionPaths: readonly string[];
	entries: readonly InventoryEntry[];
	staged: ReadonlyMap<string, EntryScope>;
	baseline: ReadonlyMap<string, EntryScope>;
	config: ManagerConfig;
}): SavePlan {
	const scopeOf = (entry: InventoryEntry): EntryScope =>
		input.staged.get(entryKey(entry)) ?? input.baseline.get(entryKey(entry)) ?? "enabled";

	let packages: PackageSource[] = [...input.packages];
	let extensionPaths: string[] = [...input.extensionPaths];
	const configPackages: DisabledMap = { ...input.config.packages };
	const configExtensions: DisabledMap = { ...input.config.extensions };

	for (const entry of input.entries) {
		const scope = scopeOf(entry);
		if (entry.kind === "package") {
			if (scope === "enabled") {
				packages = withPlainString(packages, entry.id);
				delete configPackages[entry.id];
			} else {
				packages = packages.filter((pkg) => packageSource(pkg) !== entry.id);
				configPackages[entry.id] = scope;
			}
			continue;
		}
		const targets = localTargets(entry);
		extensionPaths = withoutLocalOverrides(extensionPaths, targets);
		if (scope === "enabled") {
			delete configExtensions[entry.id];
		} else {
			// Both scopes keep Pi from loading it; the loader decides about non-BB hosts.
			extensionPaths.push(`-${entry.id}`);
			configExtensions[entry.id] = scope;
		}
	}

	return {
		packages,
		extensionPaths,
		packagesChanged: JSON.stringify(packages) !== JSON.stringify(input.packages),
		extensionPathsChanged: JSON.stringify(extensionPaths) !== JSON.stringify(input.extensionPaths),
		config: { packages: configPackages, extensions: configExtensions },
	};
}

/**
 * Drop tracked scopes for packages settings lists again, for example after `pi install`.
 *
 * Pi loads such a package before any extension runs, so the package is enabled everywhere and
 * keeping its scope would make the menu disagree with what Pi loads. The returned config is the
 * effective one; the next save persists it.
 */
export function reconcileOwned(
	config: ManagerConfig,
	settingsSources: readonly string[],
): { config: ManagerConfig; stale: string[] } {
	const listed = new Set(settingsSources);
	const stale = Object.keys(config.packages).filter((source) => listed.has(source)).sort();
	if (stale.length === 0) return { config, stale };
	const packages = { ...config.packages };
	for (const source of stale) delete packages[source];
	return { config: { ...config, packages }, stale };
}

/** The scope a configured entry is known to be in before anything is staged. */
export function baselineScope(entry: InventoryEntry, config: ManagerConfig): EntryScope {
	if (entry.kind === "package") return config.packages[entry.id] ?? "enabled";
	if (entry.enabled) return "enabled";
	// A hand-written `-path` line without a config entry is off everywhere.
	return config.extensions[entry.id] ?? "global";
}
