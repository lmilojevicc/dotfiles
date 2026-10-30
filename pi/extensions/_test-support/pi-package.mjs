/**
 * Pi's internal modules (dist/core/...) are not exported by its package.json, so a test that needs
 * them must build a path from the package root. This helper takes that root from the specifier the
 * shared loader resolves, so no test hard-codes a Pi install location.
 *
 * Requires ./register-loader.mjs to be loaded (`--import`), otherwise the bare specifier below has
 * nothing to resolve against.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageName = "@earendil-works/pi-coding-agent";

/** The installed Pi package directory, as resolved by the shared test loader. */
export function piPackageRoot() {
	let directory = dirname(fileURLToPath(import.meta.resolve(packageName)));
	while (directory !== dirname(directory)) {
		const manifest = join(directory, "package.json");
		if (existsSync(manifest)) {
			try {
				if (JSON.parse(readFileSync(manifest, "utf8")).name === packageName) return directory;
			} catch {
				// An unreadable manifest is not Pi's; keep walking up.
			}
		}
		directory = dirname(directory);
	}
	throw new Error(`Cannot find ${packageName}; load _test-support/register-loader.mjs with --import first.`);
}

/** File URL of a path inside the installed Pi package, including non-exported dist/ internals. */
export function piModuleUrl(relativePath) {
	return pathToFileURL(join(piPackageRoot(), relativePath)).href;
}
