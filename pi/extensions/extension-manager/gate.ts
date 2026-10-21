import {
	DefaultPackageManager,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
	type ResolvedPaths,
	type ResolvedResource,
} from "@earendil-works/pi-coding-agent";
import { isAbsolute, join, relative } from "node:path";
import { CONFIG_FILE_NAME, readManagerConfig } from "./config.ts";
import {
	canonicalPath,
	installedPathProbe,
	isPinnedSource,
	settingsSources,
} from "./discovery.ts";

export type GateOptions = Readonly<{
	configDir: string;
	cwd: string;
	agentDir: string;
	/** `BB_THREAD_ID` was nonblank when this runtime was created. */
	bb: boolean;
	installedPath?: (source: string) => string | undefined;
	resolve?: (sources: readonly string[]) => Promise<ResolvedPaths>;
	loadFactory: (path: string) => Promise<unknown>;
}>;

export interface GateResources {
	skillPaths: string[];
	promptPaths: string[];
	themePaths: string[];
}

export interface GateResult {
	loaded: string[];
	/** Package skills, prompts and themes for this host; empty when nothing is owned here. */
	resources: GateResources;
	warnings: string[];
}

const EMPTY_PATHS: ResolvedPaths = { extensions: [], skills: [], prompts: [], themes: [] };

/** BB origin is any nonblank `BB_THREAD_ID`, the same rule every BB-aware extension uses. */
export function isBbHost(env: Readonly<Record<string, string | undefined>>): boolean {
	const threadId = env.BB_THREAD_ID;
	return typeof threadId === "string" && threadId.trim().length > 0;
}

/** Owned packages load here unless the config disables them in this host. */
export function ownedPackageSources(packages: Readonly<Record<string, string>>, bb: boolean): string[] {
	return Object.entries(packages)
		.filter(([, scope]) => scope === "bb" && !bb)
		.map(([source]) => source)
		.sort((left, right) => left.localeCompare(right));
}

/** Local entrypoints Pi skips everywhere but the loader loads in non-BB hosts. */
export function ownedLocalEntries(
	extensions: Readonly<Record<string, string>>,
	agentDir: string,
	bb: boolean,
): Array<{ id: string; path: string }> {
	return Object.entries(extensions)
		.filter(([, scope]) => scope === "bb" && !bb)
		.map(([id]) => ({
			id,
			path: isAbsolute(id) ? id : join(agentDir, id),
		}))
		.sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Resolve owned packages the way Pi would, without touching settings.
 *
 * `onMissing: "skip"` is the safety net behind the installed-path pre-flight: nothing here can
 * install, clone, update or reconcile a package.
 */
export function ownedPackageResolver(options: { cwd: string; agentDir: string }) {
	return async (sources: readonly string[]): Promise<ResolvedPaths> => {
		const settingsManager = SettingsManager.inMemory(
			{ packages: [...sources] },
			{ projectTrusted: false },
		);
		const manager = new DefaultPackageManager({
			cwd: options.cwd,
			agentDir: options.agentDir,
			settingsManager,
		});
		return await manager.resolve(async () => "skip");
	};
}

/**
 * Sources the global settings still list.
 *
 * Pi resolves those itself before any extension runs, in every host, so a tracked scope for such
 * a source can no longer apply and loading it again would register its extensions twice.
 */
function listedInSettings(options: GateOptions, warnings: string[]): Set<string> {
	try {
		const manager = SettingsManager.create(options.cwd, options.agentDir, { projectTrusted: false });
		return new Set(settingsSources(manager.getGlobalSettings().packages ?? []));
	} catch (error) {
		warnings.push(`extension-manager: could not read settings.json (${error instanceof Error ? error.message : String(error)}); owned packages may be loaded twice.`);
		return new Set();
	}
}

function enabledPaths(resources: readonly ResolvedResource[]): string[] {
	return resources
		.filter((resource) => resource.enabled && resource.metadata.origin === "package")
		.map((resource) => resource.path);
}

/**
 * Load the package and local entrypoints that settings no longer know about.
 *
 * A package that is disabled anywhere lives only in `extension-manager.json`, so Pi never sees
 * it: this loader is the only thing that can load it, and it must be fail-open with visible
 * warnings. Nothing is loaded for the scope that disabled it.
 */
export async function installExtensionGate(pi: ExtensionAPI, options: GateOptions): Promise<GateResult> {
	const config = readManagerConfig(options.configDir);
	const warnings = [...config.warnings];
	const installedPath = options.installedPath ??
		installedPathProbe({ cwd: options.cwd, agentDir: options.agentDir });
	const resolve = options.resolve ?? ownedPackageResolver({ cwd: options.cwd, agentDir: options.agentDir });
	const managerPath = canonicalPath(join(options.configDir, "index.ts"));
	const loaderPath = canonicalPath(join(options.configDir, "loader.ts"));

	// A package `pi install` (or a hand edit) puts back into settings.json is loaded by Pi before
	// this loader runs, so its tracked scope is stale: skip it here instead of loading it twice.
	const listed = Object.keys(config.packages).length > 0
		? listedInSettings(options, warnings)
		: new Set<string>();
	for (const source of Object.keys(config.packages).sort()) {
		if (!listed.has(source)) continue;
		warnings.push(`extension-manager: ${CONFIG_FILE_NAME}: ${source} is also listed in settings.json, so Pi loads it natively here and the loader skips it; toggle it in /extensions-manager to take it back.`);
	}

	const loadable: string[] = [];
	for (const source of ownedPackageSources(config.packages, options.bb)) {
		if (listed.has(source)) continue;
		if (isPinnedSource(source)) {
			warnings.push(`extension-manager: ${CONFIG_FILE_NAME}: ${source}: a version-pinned source is never resolved by the loader (it does not install or reconcile); list it unpinned to keep its extensions.`);
			continue;
		}
		if (installedPath(source) === undefined) {
			warnings.push(`extension-manager: ${CONFIG_FILE_NAME}: ${source} is owned but not installed; expecting no extensions from it until it is installed again.`);
			continue;
		}
		loadable.push(source);
	}

	let resolved = EMPTY_PATHS;
	if (loadable.length > 0) {
		try {
			resolved = await resolve(loadable);
		} catch (error) {
			warnings.push(`extension-manager: ${CONFIG_FILE_NAME}: resolving ${loadable.join(", ")} failed: ${error instanceof Error ? error.message : String(error)}; owned packages were not loaded.`);
		}
	}

	const loads: Array<{ id: string; path: string }> = [];
	for (const entry of ownedLocalEntries(config.extensions, options.agentDir, options.bb)) {
		const canonical = canonicalPath(entry.path);
		if (canonical === managerPath || canonical === loaderPath) {
			warnings.push(`extension-manager: ${CONFIG_FILE_NAME}: the extension manager cannot be disabled; ignoring its entry.`);
			continue;
		}
		loads.push({ id: entry.id, path: entry.path });
	}
	for (const resource of resolved.extensions) {
		if (!resource.enabled || resource.metadata.origin !== "package") continue;
		const baseDir = resource.metadata.baseDir;
		const relativePath = (baseDir === undefined ? resource.path : relative(baseDir, resource.path))
			.replaceAll("\\", "/");
		loads.push({ id: `${resource.metadata.source}/${relativePath}`, path: resource.path });
	}

	const loaded: string[] = [];
	for (const entry of loads) {
		try {
			const factory = await options.loadFactory(entry.path);
			if (typeof factory !== "function") throw new Error("entrypoint has no default-export factory");
			await (factory as (api: ExtensionAPI) => unknown)(pi);
			loaded.push(entry.id);
		} catch (error) {
			warnings.push(`extension-manager: ${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	const resources: GateResources = {
		skillPaths: enabledPaths(resolved.skills),
		promptPaths: enabledPaths(resolved.prompts),
		themePaths: enabledPaths(resolved.themes),
	};
	// Only advertise resources this host would otherwise miss, and only via Pi's own hook.
	if (resources.skillPaths.length > 0 || resources.promptPaths.length > 0 || resources.themePaths.length > 0) {
		pi.on("resources_discover", () => resources);
	}

	let reported = false;
	function report(ctx: ExtensionContext): void {
		if (reported) return;
		reported = true;
		for (const warning of warnings) {
			if (ctx.hasUI) ctx.ui.notify(warning, "warning");
			else console.error(warning);
		}
	}
	if (warnings.length > 0) {
		pi.on("session_start", (_event, ctx) => report(ctx));
		// Pi starts each hook chain from its base prompt; this hook only reports, never mutates it.
		pi.on("before_agent_start", (_event, ctx) => report(ctx));
	}

	return { loaded, resources, warnings };
}
