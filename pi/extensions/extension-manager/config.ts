import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const CONFIG_FILE_NAME = "extension-manager.json";

/** `global` means off in every host; `bb` means off only when launched from BB. */
export const SCOPES = ["global", "bb"] as const;
export type Scope = (typeof SCOPES)[number];

/** Which scope disables a package source (or a local extension id). Absent means enabled. */
export type DisabledMap = Record<string, Scope>;

export interface ManagerConfig {
	packages: DisabledMap;
	extensions: DisabledMap;
}

export interface ConfigSnapshot extends ManagerConfig {
	path: string;
	warnings: string[];
}

/** Keys are package sources or agent-relative extension ids; values are the disabled scope. */
export const CONFIG_KEYS = ["packages", "extensions"] as const;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Ids are bare paths or `source`, never blank and never control characters. */
function isValidId(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && !/[\x00-\x1f\x7f-\x9f]/.test(value);
}

function isScope(value: unknown): value is Scope {
	return typeof value === "string" && (SCOPES as readonly string[]).includes(value);
}

export function configPath(configDir: string): string {
	return join(configDir, CONFIG_FILE_NAME);
}

function sorted(map: DisabledMap): DisabledMap {
	const entries = Object.entries(map).sort(([left], [right]) => left.localeCompare(right));
	return Object.fromEntries(entries);
}

/**
 * Eager, fail-open snapshot: a missing file disables nothing, and a bad key warns and is ignored
 * so valid siblings still apply. Unknown ids are inert data, not errors: they may name a package
 * whose install is temporarily gone, and saving preserves them.
 */
export function readManagerConfig(configDir: string): ConfigSnapshot {
	const path = configPath(configDir);
	const warnings: string[] = [];
	const config: ManagerConfig = { packages: {}, extensions: {} };
	function warn(context: string, message: string): void {
		warnings.push(`extension-manager: ${path}: ${context}: ${message}; ignoring affected input.`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			warn("config", error instanceof Error ? error.message : String(error));
		}
		return { ...config, path, warnings };
	}
	if (!isObject(parsed)) {
		warn("config", "expected an object with optional packages and extensions objects");
		return { ...config, path, warnings };
	}
	for (const key of Object.keys(parsed)) {
		if (!(CONFIG_KEYS as readonly string[]).includes(key)) warn(key, "unknown top-level key");
	}
	for (const key of CONFIG_KEYS) {
		const value = parsed[key];
		if (value === undefined) continue;
		if (!isObject(value)) {
			warn(key, `expected an object mapping ids to ${SCOPES.join(" or ")}`);
			continue;
		}
		for (const [id, scope] of Object.entries(value)) {
			if (!isValidId(id)) {
				warn(key, "expected nonblank ids without control characters");
				continue;
			}
			if (!isScope(scope)) {
				warn(key, `${id}: expected "global" or "bb"`);
				continue;
			}
			config[key][id] = scope;
		}
	}
	return { packages: sorted(config.packages), extensions: sorted(config.extensions), path, warnings };
}

/** Atomic replace so a crash cannot leave a half-written tracked config. */
export function writeManagerConfig(configDir: string, config: ManagerConfig): void {
	const path = configPath(configDir);
	const body = JSON.stringify({
		packages: sorted(config.packages),
		extensions: sorted(config.extensions),
	}, null, 2);
	const temporary = `${path}.tmp`;
	writeFileSync(temporary, `${body}\n`);
	renameSync(temporary, path);
}
