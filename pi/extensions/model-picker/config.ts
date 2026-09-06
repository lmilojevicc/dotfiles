import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Resolve and read on each opening; agent configuration is never created or repaired here. */
export function readConfig(warn: (message: string) => void, path = join(getAgentDir(), "model-picker.json")): { vimMode: boolean } {
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("expected an object");
		const vimMode = (value as Record<string, unknown>).vimMode;
		if (vimMode !== undefined && typeof vimMode !== "boolean") throw Error("vimMode must be boolean");
		return { vimMode: vimMode === true };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			const reason = error instanceof SyntaxError ? "invalid JSON" : (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : "cannot read");
			warn(`Model picker config ${path}: ${reason}; using vimMode=false`);
		}
		return { vimMode: false };
	}
}
