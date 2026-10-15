export type ResolvedEntry = Readonly<{ source: string; path: string }>;
export type ResolveResult = Readonly<{ entries: readonly ResolvedEntry[]; warnings: readonly string[] }>;
export type SourceResolver = (sources: readonly string[]) => Promise<ResolveResult>;

export type PackageLister = Readonly<{
	installedPath: (source: string) => string | undefined;
	extensionPaths: (source: string) => Promise<readonly string[]>;
}>;

/**
 * Resolve only sources that are already installed; the gate never installs or reconciles.
 * Every entry the package declares is taken, including ones settings filters out: that
 * filter is exactly what this gate replaces.
 */
export async function resolveSources(sources: readonly string[], lister: PackageLister): Promise<ResolveResult> {
	const entries: ResolvedEntry[] = [];
	const warnings: string[] = [];
	const seen = new Set<string>();
	for (const source of sources) {
		if (lister.installedPath(source) === undefined) {
			warnings.push(`host-gate: ${source}: not installed; not loading (this gate never installs or updates packages).`);
			continue;
		}
		let paths: readonly string[];
		try {
			paths = await lister.extensionPaths(source);
		} catch (error) {
			warnings.push(`host-gate: ${source}: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		if (paths.length === 0) {
			warnings.push(`host-gate: ${source}: no extension entrypoint resolved; nothing to load.`);
			continue;
		}
		for (const path of paths) {
			if (seen.has(path)) continue;
			seen.add(path);
			entries.push({ source, path });
		}
	}
	return { entries, warnings };
}
