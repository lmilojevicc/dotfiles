import {
	DefaultPackageManager,
	SettingsManager,
	type PackageSource,
} from "@earendil-works/pi-coding-agent";
import { realpathSync } from "node:fs";
import { relative, resolve } from "node:path";

const BUILTIN_PREFIX = "builtin:";

/** One toggleable package: a plain settings entry or a package owned by this manager. */
export interface PackageEntry {
	kind: "package";
	/** Package source, which is also the config key. */
	id: string;
	label: string;
	installed: boolean;
}

/** One toggleable local extension discovered under the agent extensions directory. */
export interface LocalEntry {
	kind: "local";
	/** Agent-directory-relative entrypoint id, which is also the `-path` settings target. */
	id: string;
	label: string;
	path: string;
	/** Whether Pi's own settings still let it load this extension natively. */
	enabled: boolean;
}

export type InventoryEntry = PackageEntry | LocalEntry;

export interface Inventory {
	entries: InventoryEntry[];
}

export interface DiscoverOptions {
	cwd: string;
	agentDir: string;
	settingsManager: SettingsManager;
	/** Entrypoints that are never rows, for example the loader and `builtin:*` resources. */
	excludePaths?: readonly string[];
}

export function canonicalPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

export function packageSource(pkg: PackageSource): string {
	return typeof pkg === "string" ? pkg : pkg.source;
}

/** Settings may still hold object entries; only their source identifies the package. */
export function settingsSources(packages: readonly PackageSource[]): string[] {
	return [...new Set(packages.map(packageSource))];
}

/** A pinned source could trigger an install or version reconciliation inside Pi's resolver. */
export function isPinnedSource(source: string): boolean {
	if (source.startsWith("npm:")) {
		const spec = source.slice(4);
		// A leading `@` is an npm scope, not a version; the pin follows the package name.
		const name = spec.startsWith("@") ? spec.slice(spec.indexOf("/") + 1) : spec;
		return name.includes("@");
	}
	if (source.startsWith("git:") || /^https?:/.test(source)) return source.includes("#");
	return false;
}

function slash(path: string): string {
	return path.replaceAll("\\", "/");
}

/** Local ids are agent-directory-relative; paths outside it stay absolute rather than use `..`. */
export function localExtensionId(agentDir: string, path: string): string {
	const relativePath = slash(relative(agentDir, path));
	return relativePath.startsWith("../") ? slash(path) : relativePath;
}

/** Installed-path pre-flight: Pi's resolver installs a source that is not on disk yet. */
export function installedPathProbe(options: { cwd: string; agentDir: string }): (source: string) => string | undefined {
	// A settings-free manager: the probe must not read or rewrite the live settings file.
	const manager = new DefaultPackageManager({
		cwd: options.cwd,
		agentDir: options.agentDir,
		settingsManager: SettingsManager.inMemory({}, { projectTrusted: false }),
	});
	return (source) => manager.getInstalledPath(source, "user");
}

/**
 * Every local extension Pi knows about, including the ones its settings exclude.
 *
 * Pi's own resolution already applies `-path` filters, so one filter-free pass is enough: the
 * live view reports every auto-discovered or explicitly listed entrypoint with its enabled flag.
 * `onMissing: "skip"` keeps package resolution free of install side effects.
 */
export async function discoverLocalExtensions(options: DiscoverOptions): Promise<LocalEntry[]> {
	const manager = new DefaultPackageManager({
		cwd: options.cwd,
		agentDir: options.agentDir,
		settingsManager: options.settingsManager,
	});
	const resolved = await manager.resolve(async () => "skip");
	const excluded = new Set((options.excludePaths ?? []).map(canonicalPath));
	const seen = new Set<string>();
	const entries: LocalEntry[] = [];
	for (const resource of resolved.extensions) {
		if (resource.metadata.scope !== "user" || resource.metadata.origin !== "top-level") continue;
		if (resource.path.startsWith(BUILTIN_PREFIX)) continue;
		const path = canonicalPath(resource.path);
		if (excluded.has(path) || seen.has(path)) continue;
		seen.add(path);
		const id = localExtensionId(options.agentDir, resource.path);
		entries.push({ kind: "local", id, label: id, path: resource.path, enabled: resource.enabled });
	}
	return entries;
}

/**
 * The menu inventory: settings packages, packages this manager owns, and local extensions.
 *
 * A package is identified by its source and is either a plain settings string or an entry in
 * `extension-manager.json`; it is never listed in both.
 */
export async function discoverInventory(options: DiscoverOptions & {
	ownedPackages: readonly string[];
	probeInstalled?: (source: string) => string | undefined;
}): Promise<Inventory> {
	const settings = options.settingsManager.getGlobalSettings();
	const probe = options.probeInstalled ?? installedPathProbe({ cwd: options.cwd, agentDir: options.agentDir });
	const sources = settingsSources(settings.packages ?? []);
	const owned = [...new Set(options.ownedPackages)].filter((source) => !sources.includes(source));
	const entries: InventoryEntry[] = [...sources, ...owned].map((source) => ({
		kind: "package",
		id: source,
		label: source,
		installed: probe(source) !== undefined,
	}));
	return { entries: [...entries, ...await discoverLocalExtensions(options)] };
}
