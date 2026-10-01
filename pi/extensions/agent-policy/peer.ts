import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { registerRequiredChildExtensions } from "pi-subagents/required-child-extensions";

const PUBLIC_API = "pi-subagents/required-child-extensions";

/** Resolve a normal peer first, then the existing Pi-managed npm anchor only. */
export function resolveRequiredChildAPI(extensionURL: string, agentDir: string): string {
	const local = createRequire(extensionURL);
	try {
		return local.resolve(PUBLIC_API);
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "MODULE_NOT_FOUND") throw error;
	}
	try {
		return createRequire(join(agentDir, "npm", "package.json")).resolve(PUBLIC_API);
	} catch (error) {
		throw new Error(`agent-policy: cannot resolve ${PUBLIC_API}; provision a compatible peer or Pi-managed npm package before loading (no automatic install).`, { cause: error });
	}
}

export async function loadRequiredChildAPI(extensionURL: string, agentDir: string): Promise<typeof registerRequiredChildExtensions> {
	const api = await import(pathToFileURL(resolveRequiredChildAPI(extensionURL, agentDir)).href);
	if (typeof api.registerRequiredChildExtensions !== "function") {
		throw new Error(`agent-policy: ${PUBLIC_API} lacks registerRequiredChildExtensions`);
	}
	return api.registerRequiredChildExtensions;
}
