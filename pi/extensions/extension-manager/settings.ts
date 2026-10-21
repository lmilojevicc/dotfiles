import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SavePlan } from "./state.ts";

export function settingsError(prefix: string, errors: Array<{ error: Error }>): string | undefined {
	if (errors.length === 0) return undefined;
	return `${prefix}: ${errors.map(({ error }) => error.message).join("; ")}`;
}

/** Native settings accepts absent/empty files or an object root, but not other JSON roots. */
export function validateGlobalRoot(agentDir: string): void {
	let content: string;
	try {
		content = readFileSync(join(agentDir, "settings.json"), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (content === "") return;
	const root: unknown = JSON.parse(content.replace(/^\uFEFF/, ""));
	if (!root || typeof root !== "object" || Array.isArray(root)) {
		throw new Error("Global settings.json must contain a JSON object");
	}
}

/** Re-read settings so a save never plans against a stale file. */
export async function reloadGlobalSettings(settingsManager: SettingsManager, agentDir: string): Promise<void> {
	validateGlobalRoot(agentDir);
	await settingsManager.reload();
	const error = settingsError("Could not refresh global settings", settingsManager.drainErrors());
	if (error) throw new Error(error);
	validateGlobalRoot(agentDir);
}

/**
 * The only settings.json write path.
 *
 * `SettingsManager` persists just the fields it was told changed and merges them into the file as
 * it is on disk, so every other setting survives byte for byte. A plan never writes object-form
 * package entries: packages are added and removed as plain source strings, local extensions as
 * exactly one `-path` line.
 */
export async function applySavePlan(settingsManager: SettingsManager, plan: SavePlan): Promise<void> {
	if (plan.packagesChanged) settingsManager.setPackages(plan.packages);
	if (plan.extensionPathsChanged) settingsManager.setExtensionPaths(plan.extensionPaths);
	if (!plan.packagesChanged && !plan.extensionPathsChanged) return;
	await settingsManager.flush();
	const error = settingsError("Could not save extension settings", settingsManager.drainErrors());
	if (error) throw new Error(error);
}
