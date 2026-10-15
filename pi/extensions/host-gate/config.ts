import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isKnownCondition, KNOWN_CONDITIONS } from "./host.ts";

export type GateEntry = Readonly<{ source: string; require?: readonly string[] }>;
export type GateConfigSnapshot = Readonly<{ entries: readonly GateEntry[]; warnings: readonly string[] }>;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A pinned source could trigger an install/version reconciliation inside Pi's resolver. */
export function pinnedSource(source: string): boolean {
	if (source.startsWith("npm:")) return source.slice(4).includes("@");
	if (source.startsWith("git:") || /^https?:/.test(source)) return source.includes("#");
	return false;
}

/** Eager, fail-open config snapshot: a bad entry warns and is skipped, valid siblings load. */
export function readGateConfig(policyDir: string): GateConfigSnapshot {
	const configPath = join(policyDir, "host-gate.json");
	const warnings: string[] = [];
	const entries: GateEntry[] = [];
	function warn(context: string, message: string): void {
		warnings.push(`host-gate: ${configPath}: ${context}: ${message}; skipping affected input.`);
	}
	let config: unknown;
	try {
		config = JSON.parse(readFileSync(configPath, "utf8"));
	} catch (error) {
		warn("config", error instanceof Error ? error.message : String(error));
		return { entries, warnings };
	}
	if (!isObject(config)) {
		warn("config", "expected an object with an optional packages mapping");
		return { entries, warnings };
	}
	for (const key of Object.keys(config)) {
		if (key !== "packages") warn(key, "unknown top-level key");
	}
	if (config.packages !== undefined && !isObject(config.packages)) {
		warn("packages", "expected an object mapping a package source to its host conditions");
		return { entries, warnings };
	}
	for (const [source, value] of Object.entries(config.packages ?? {})) {
		const context = `packages[${JSON.stringify(source)}]`;
		if (!source.trim() || /[\x00-\x1f\x7f]/.test(source)) {
			warn(context, "expected a nonblank package source without control characters");
			continue;
		}
		if (!isObject(value)) {
			warn(context, "expected an object with an optional require array");
			continue;
		}
		for (const key of Object.keys(value)) {
			if (key !== "require") warn(`${context}.${key}`, "unknown key");
		}
		if (value.require !== undefined && (!Array.isArray(value.require) || value.require.some((item) => typeof item !== "string" || !item.trim()))) {
			warn(`${context}.require`, `expected an array of nonblank conditions from ${KNOWN_CONDITIONS.join(", ")}`);
			continue;
		}
		const required = value.require as string[] | undefined;
		const unknown = required?.find((condition) => !isKnownCondition(condition));
		if (unknown !== undefined) {
			warn(`${context}.require`, `unknown host condition ${JSON.stringify(unknown)}; known: ${KNOWN_CONDITIONS.join(", ")}`);
			continue;
		}
		if (pinnedSource(source)) {
			warn(context, "a version-pinned source can make Pi's resolver install or reconcile; list it unpinned");
			continue;
		}
		entries.push({ source, ...(required === undefined ? {} : { require: required }) });
	}
	return { entries, warnings };
}
