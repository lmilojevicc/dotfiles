import type { PackageSource, ResolvedResource } from "@earendil-works/pi-coding-agent";
import { relative } from "node:path";

const RESOURCE_KEYS = ["extensions", "skills", "prompts", "themes"] as const;

type PackageConfig = Exclude<PackageSource, string>;

export interface ExtensionChange {
	resource: ResolvedResource;
	enabled: boolean;
}

export interface ExtensionSettingsUpdate {
	extensionPaths: string[];
	packages: PackageSource[];
	extensionPathsChanged: boolean;
	packagesChanged: boolean;
}

function packageSource(pkg: PackageSource): string {
	return typeof pkg === "string" ? pkg : pkg.source;
}

function normalizePatternTarget(pattern: string): string {
	const withoutDotPrefix = pattern.startsWith("./") || pattern.startsWith(".\\")
		? pattern.slice(2)
		: pattern;
	return withoutDotPrefix.replaceAll("\\", "/");
}

function isExactOverride(pattern: string): boolean {
	return pattern.startsWith("+") || pattern.startsWith("-");
}

function targetsResource(pattern: string, targets: ReadonlySet<string>): boolean {
	return isExactOverride(pattern) && targets.has(normalizePatternTarget(pattern.slice(1)));
}

function packagePattern(resource: ResolvedResource): string {
	return normalizePatternTarget(relative(resource.metadata.baseDir ?? "", resource.path));
}

function topLevelPattern(resource: ResolvedResource, agentDir: string): string {
	return normalizePatternTarget(relative(resource.metadata.baseDir ?? agentDir, resource.path));
}

function updateTopLevelPaths(
	paths: string[],
	resource: ResolvedResource,
	enabled: boolean,
	agentDir: string,
): string[] {
	const pattern = topLevelPattern(resource, agentDir);
	const matchingTargets = new Set([
		pattern,
		resource.path,
		relative(agentDir, resource.path),
	].map(normalizePatternTarget));
	const updated = paths.filter((entry) => !targetsResource(entry, matchingTargets));
	updated.push(`${enabled ? "+" : "-"}${pattern}`);
	return updated;
}

function updatePackage(
	packages: PackageSource[],
	resource: ResolvedResource,
	enabled: boolean,
): PackageSource[] {
	const packageIndex = packages.findIndex((pkg) => packageSource(pkg) === resource.metadata.source);
	if (packageIndex < 0) {
		throw new Error(`Package source is no longer configured globally: ${resource.metadata.source}`);
	}

	const updatedPackages = packages.map((pkg) =>
		typeof pkg === "string" ? pkg : { ...pkg },
	);
	const existing = updatedPackages[packageIndex];
	if (existing === undefined) return packages;
	const pkg: PackageConfig = typeof existing === "string" ? { source: existing } : existing;
	updatedPackages[packageIndex] = pkg;

	const pattern = packagePattern(resource);
	const matchingTargets = new Set([pattern, resource.path].map(normalizePatternTarget));
	const hadExtensionFilter = pkg.extensions !== undefined;
	const current = [...(pkg.extensions ?? [])];
	const updated = current.filter((entry) => !targetsResource(entry, matchingTargets));

	if (enabled) {
		if (pkg.autoload === false) {
			// Delta packages start with nothing loaded, so the enable override must
			// remain explicit even when it is the package's only extension filter.
			updated.push(`+${pattern}`);
		} else if (hadExtensionFilter && current.length === 0) {
			// An empty filter disables every extension. A plain include changes that to
			// "only this extension"; +path would incorrectly enable the whole package.
			updated.push(pattern);
		} else if (updated.length > 0) {
			updated.push(`+${pattern}`);
		}
		// With no remaining filters, omitting the key restores package autoload.
	} else {
		updated.push(`-${pattern}`);
	}

	pkg.extensions = updated.length > 0 ? updated : undefined;
	const hasResourceFilters = RESOURCE_KEYS.some((key) => pkg[key] !== undefined);
	if (!hasResourceFilters && pkg.autoload === undefined) {
		updatedPackages[packageIndex] = pkg.source;
	}
	return updatedPackages;
}

export function applyExtensionChanges(
	extensionPaths: readonly string[],
	packages: readonly PackageSource[],
	changes: readonly ExtensionChange[],
	agentDir: string,
): ExtensionSettingsUpdate {
	let nextExtensionPaths = [...extensionPaths];
	let nextPackages = packages.map((pkg) => (typeof pkg === "string" ? pkg : { ...pkg }));
	let extensionPathsChanged = false;
	let packagesChanged = false;

	for (const change of changes) {
		if (change.resource.metadata.origin === "package") {
			const updated = updatePackage(nextPackages, change.resource, change.enabled);
			if (updated !== nextPackages) {
				nextPackages = updated;
				packagesChanged = true;
			}
			continue;
		}
		nextExtensionPaths = updateTopLevelPaths(
			nextExtensionPaths,
			change.resource,
			change.enabled,
			agentDir,
		);
		extensionPathsChanged = true;
	}

	return {
		extensionPaths: nextExtensionPaths,
		packages: nextPackages,
		extensionPathsChanged,
		packagesChanged,
	};
}
