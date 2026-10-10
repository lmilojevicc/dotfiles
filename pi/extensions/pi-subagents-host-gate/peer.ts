import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

/** Resolve only the public package export, peer first then Pi's managed npm anchor. */
export function resolveSubagents(extensionURL: string, agentDir: string): string {
	const local = createRequire(extensionURL);
	try {
		return local.resolve("pi-subagents");
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "MODULE_NOT_FOUND") throw error;
		// Missing exports/main targets also report MODULE_NOT_FOUND. Only an absent
		// package may fall back; a present broken peer must retain its own error.
		if (local.resolve.paths("pi-subagents")?.some((root) => existsSync(join(root, "pi-subagents")))) throw error;
	}
	try {
		return createRequire(join(agentDir, "npm", "package.json")).resolve("pi-subagents");
	} catch (error) {
		throw new Error("pi-subagents-host-gate: cannot resolve pi-subagents public export; provision a peer or Pi-managed npm package (no automatic install)", { cause: error });
	}
}
