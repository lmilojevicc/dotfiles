import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Per-model override; any omitted field falls back to the global value. */
export interface ModelOverride {
	enabled?: boolean;
	thresholdPercent?: number;
}

export interface AutoCompactConfig {
	enabled: boolean;
	/** Start a background summary once context usage reaches this share of the model's window. */
	thresholdPercent: number;
	/** Keys are exact `provider/modelId`, or a bare `modelId` matching every provider. */
	models: Record<string, ModelOverride>;
}

export interface ResolvedModelConfig {
	enabled: boolean;
	thresholdPercent: number;
	/** The `models` key that matched, if any. */
	matched?: string;
}

export const DEFAULT_CONFIG: AutoCompactConfig = {
	enabled: true,
	thresholdPercent: 80,
	models: {},
};

export const CONFIG_ENV_VAR = "PI_AUTO_COMPACT_CONFIG";
export const CONFIG_FILE_NAME = "auto-compact.json";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkKeys(value: Record<string, unknown>, allowed: string[], where: string): void {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) {
			throw new Error(`Unknown key ${JSON.stringify(key)} in ${where}; allowed: ${allowed.join(", ")}.`);
		}
	}
}

function checkPercent(value: unknown, where: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value >= 100) {
		throw new Error(`${where} must be a number greater than 0 and less than 100.`);
	}
	return value;
}

function checkBoolean(value: unknown, where: string): boolean {
	if (typeof value !== "boolean") throw new Error(`${where} must be true or false.`);
	return value;
}

export function parseConfig(value: unknown): AutoCompactConfig {
	if (!isRecord(value)) throw new Error("Expected a JSON object.");
	checkKeys(value, ["enabled", "thresholdPercent", "models"], "the config");
	const config: AutoCompactConfig = { ...DEFAULT_CONFIG, models: {} };
	if (value.enabled !== undefined) config.enabled = checkBoolean(value.enabled, '"enabled"');
	if (value.thresholdPercent !== undefined) {
		config.thresholdPercent = checkPercent(value.thresholdPercent, '"thresholdPercent"');
	}
	if (value.models !== undefined) {
		if (!isRecord(value.models)) throw new Error('"models" must be an object.');
		for (const [key, override] of Object.entries(value.models)) {
			if (!key || key.trim() !== key) {
				throw new Error("Model keys must be non-empty, without surrounding whitespace.");
			}
			const where = `models[${JSON.stringify(key)}]`;
			if (!isRecord(override)) throw new Error(`${where} must be an object.`);
			checkKeys(override, ["enabled", "thresholdPercent"], where);
			const parsed: ModelOverride = {};
			if (override.enabled !== undefined) {
				parsed.enabled = checkBoolean(override.enabled, `${where}.enabled`);
			}
			if (override.thresholdPercent !== undefined) {
				parsed.thresholdPercent = checkPercent(override.thresholdPercent, `${where}.thresholdPercent`);
			}
			config.models[key] = parsed;
		}
	}
	return config;
}

/** An exact `provider/modelId` entry wins over a bare `modelId` entry; omitted fields use the global value. */
export function resolveForModel(
	config: AutoCompactConfig,
	model: { provider: string; id: string },
): ResolvedModelConfig {
	const exact = `${model.provider}/${model.id}`;
	const matched = exact in config.models ? exact : model.id in config.models ? model.id : undefined;
	const override = matched ? config.models[matched] : {};
	return {
		enabled: config.enabled && (override.enabled ?? true),
		thresholdPercent: override.thresholdPercent ?? config.thresholdPercent,
		matched,
	};
}

export function thresholdTokens(contextWindow: number, thresholdPercent: number): number {
	return Math.floor((contextWindow * thresholdPercent) / 100);
}

/** `PI_AUTO_COMPACT_CONFIG` (`~/` expands to home, otherwise relative to cwd), then `<agentDir>/auto-compact.json`. */
export function resolveConfigPath(agentDir: string, envValue = process.env[CONFIG_ENV_VAR]): string {
	if (envValue) return envValue.startsWith("~/") ? resolve(homedir(), envValue.slice(2)) : resolve(envValue);
	return join(agentDir, CONFIG_FILE_NAME);
}

export type LoadedConfig =
	| { ok: true; config: AutoCompactConfig; missing: boolean }
	| { ok: false; error: string };

/** A missing file means defaults; an unreadable or invalid file disables the extension until fixed. */
export function loadConfig(path: string): LoadedConfig {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") {
			return { ok: true, config: { ...DEFAULT_CONFIG, models: {} }, missing: true };
		}
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
	try {
		return { ok: true, config: parseConfig(JSON.parse(text)), missing: false };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}
