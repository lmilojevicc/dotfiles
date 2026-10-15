import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DefaultPackageManager, getAgentDir, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installHostGate } from "./gate.ts";
import { resolveSources, type PackageLister } from "./manifest.ts";

type SdkPackageManager = Readonly<{
	getInstalledPath: (source: string, scope: "user" | "project") => string | undefined;
	resolveExtensionSources: (sources: string[]) => Promise<{ extensions: readonly { path: string }[] }>;
}>;

/** Pi's own resolver, used read-only: installed-path probe plus manifest expansion. */
function createSdkLister(cwd: string, agentDir: string): PackageLister {
	let manager: SdkPackageManager | undefined;
	function packageManager(): SdkPackageManager {
		if (manager) return manager;
		// Constructed inside the host-loader-transpiled extension so Pi's module mapping applies.
		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
		manager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
		return manager;
	}
	return {
		installedPath(source) {
			return packageManager().getInstalledPath(source, "user");
		},
		async extensionPaths(source) {
			// A source is known-installed and unpinned here, so this cannot install or reconcile.
			const resolved = await packageManager().resolveExtensionSources([source]);
			return resolved.extensions.map((resource) => resource.path);
		},
	};
}

/**
 * Explicitly configured host gate. Pi cannot unload an extension that settings already
 * enabled, so gated packages stay installed with skills/prompts enabled while their
 * extension resource is filtered in settings and loaded here only for allowed hosts.
 */
export default async function hostGate(pi: ExtensionAPI): Promise<void> {
	// Capture host facts before any await; env changes later need a new runtime/reload.
	const env = Object.freeze({ BB_THREAD_ID: process.env.BB_THREAD_ID });
	const isTTY = Boolean(process.stdout.isTTY);
	const agentDir = getAgentDir();
	const lister = createSdkLister(process.cwd(), agentDir);
	await installHostGate(pi, {
		configDir: dirname(fileURLToPath(import.meta.url)),
		env,
		isTTY,
		resolve: (sources) => resolveSources(sources, lister),
		// Keep the import inside the host-loader-transpiled extension: Pi's jiti propagates
		// its module mapping to each entrypoint and its transitive SDK peer imports.
		loadFactory: async (path) => (await import(pathToFileURL(path).href)).default,
	});
}
