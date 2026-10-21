import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installExtensionGate, isBbHost } from "./gate.ts";

/**
 * The only extension entry in `settings.json` besides the manager itself.
 *
 * Pi cannot unload an extension that settings already enabled, so a package that is disabled in
 * any scope is removed from settings and owned by `extension-manager.json` instead. Only this
 * loader brings those packages back, in the hosts where they are still enabled, and it does the
 * same for local entrypoints that settings skip in every host. `/extensions-manager` itself is
 * an ordinary auto-discovered local extension and is never gated.
 */
export default async function extensionManagerLoader(pi: ExtensionAPI): Promise<void> {
	// Capture host facts before any await; later env changes need a new runtime or /reload.
	const env = Object.freeze({ BB_THREAD_ID: process.env.BB_THREAD_ID });
	await installExtensionGate(pi, {
		configDir: dirname(fileURLToPath(import.meta.url)),
		cwd: process.cwd(),
		agentDir: getAgentDir(),
		bb: isBbHost(env),
		// Keep the import inside the host-loader-transpiled extension: Pi's jiti propagates its
		// module mapping to each entrypoint and its transitive SDK peer imports.
		loadFactory: async (path) => (await import(pathToFileURL(path).href)).default,
	});
}
