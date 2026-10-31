import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Zentui's own protocol bounds; a longer key or text is dropped, not truncated, by the consumer. */
export const MAX_KEY_LENGTH = 64;
export const MAX_TEXT_LENGTH = 256;

/** A status key becomes a Zentui custom-value key verbatim, so it must be a usable variable name. */
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

export interface BridgeConfig {
	/** Status keys to bridge. Empty means every key some extension publishes. */
	include: string[];
	/** Status keys left on the host surface even when included. */
	exclude: string[];
	/** Prefix for the published Zentui key, e.g. `"status/"`. Must keep `include` keys under 64 characters. */
	keyPrefix: string;
	/** Hide the host copy (Footer status) once Zentui accepted the value, so it renders in one place only. */
	suppressHostStatus: boolean;
	/** Zentui drops text above 256 UTF-16 code units, so longer values are truncated here instead. */
	maxTextLength: number;
}

export const DEFAULT_CONFIG: BridgeConfig = {
	include: [],
	exclude: [],
	keyPrefix: "",
	suppressHostStatus: true,
	maxTextLength: MAX_TEXT_LENGTH,
};

export function configPath(): string {
	return join(getAgentDir(), "zentui-status-bridge.json");
}

export function isBridgeKey(key: string): boolean {
	return key.length > 0 && key.length <= MAX_KEY_LENGTH && KEY_PATTERN.test(key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readKeyList(value: unknown, where: string, report: (detail: string) => void): string[] | undefined {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		report(`"${where}" must be an array of status keys; ignored`);
		return undefined;
	}
	const keys: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string") {
			report(`"${where}" entries must be strings; skipped ${JSON.stringify(entry)}`);
			continue;
		}
		const key = entry.trim();
		if (!isBridgeKey(key)) {
			report(`"${where}" contains invalid status key ${JSON.stringify(entry)}; skipped`);
			continue;
		}
		keys.push(key);
	}
	return keys;
}

/**
 * Read the effective config. The file is never created or repaired: a missing
 * file bridges every status key with the defaults. Malformed JSON, a non-object
 * root, or an invalid field discards just that field and warns once, so a typo
 * cannot silently move every status line. Keys starting with `_` are inert, so
 * the checked-in file can carry examples next to the live rules.
 */
export function readBridgeConfig(
	warn: (message: string) => void,
	path: string = configPath(),
): BridgeConfig {
	const report = (detail: string): void => warn(`Status bridge config ${path}: ${detail}`);

	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			report(`${code ?? (error instanceof Error ? error.message : "cannot read")}; bridging every status key`);
		}
		return { ...DEFAULT_CONFIG };
	}

	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		report("invalid JSON; bridging every status key");
		return { ...DEFAULT_CONFIG };
	}
	if (!isRecord(value)) {
		report("expected a JSON object; bridging every status key");
		return { ...DEFAULT_CONFIG };
	}

	const config: BridgeConfig = { ...DEFAULT_CONFIG };
	config.include = readKeyList(value.include, "include", report) ?? [];
	config.exclude = readKeyList(value.exclude, "exclude", report) ?? [];

	const prefix = value.keyPrefix;
	if (prefix === undefined) {
		// Default.
	} else if (typeof prefix !== "string" || (prefix !== "" && !KEY_PATTERN.test(prefix.replace(/\/+$/, "")))) {
		report('"keyPrefix" must be a string of [A-Za-z0-9._:/-]; ignored');
	} else if (prefix.length > MAX_KEY_LENGTH) {
		report(`"keyPrefix" is longer than ${MAX_KEY_LENGTH} characters; ignored`);
	} else {
		config.keyPrefix = prefix;
	}

	const suppress = value.suppressHostStatus;
	if (suppress === undefined) {
		// Default.
	} else if (typeof suppress !== "boolean") {
		report('"suppressHostStatus" must be true or false; using the default');
	} else {
		config.suppressHostStatus = suppress;
	}

	const max = value.maxTextLength;
	if (max === undefined) {
		// Default.
	} else if (!Number.isInteger(max) || (max as number) < 1 || (max as number) > MAX_TEXT_LENGTH) {
		report(`"maxTextLength" must be an integer between 1 and ${MAX_TEXT_LENGTH}; using the default`);
	} else {
		config.maxTextLength = max as number;
	}

	const dropped = config.include.filter((key) => config.keyPrefix.length + key.length > MAX_KEY_LENGTH);
	for (const key of dropped) {
		report(`"keyPrefix" plus status key "${key}" exceeds ${MAX_KEY_LENGTH} characters; that key stays on the host surface`);
	}
	config.include = config.include.filter((key) => !dropped.includes(key));
	return config;
}
