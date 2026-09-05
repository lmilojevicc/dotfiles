import { mkdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const CONFIG_BASENAME = "codex-enhanced.json";
const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;

export type RuntimeModel = {
	id?: string;
	provider: string;
	api: string;
	baseUrl?: string;
};

export type UsageWindow = {
	usedPercent?: number;
	windowMinutes?: number;
	resetsAt?: number;
};

export type UsageLimit = {
	limitId: string;
	limitName?: string;
	primary?: UsageWindow;
	secondary?: UsageWindow;
};

export type ResetCredit = {
	id?: string;
	status?: string;
	expiresAt?: string;
	/** Preserve malformed metadata so automation cannot mistake it for absent metadata. */
	invalidMetadata?: true;
	resetType?: string;
};

export type ResetCredits = {
	availableCount: number;
	credits: ResetCredit[];
};

export type UsageSnapshot = {
	planType?: string;
	limits: UsageLimit[];
	resetCredits?: ResetCredits;
};

export type ResetOutcome = "reset" | "already_redeemed" | "nothing_to_reset" | "no_credit" | "unknown";

export type ResetResult = {
	outcome: ResetOutcome;
	windowsReset?: number;
};

export type CodexEnhancedConfig = {
	fast: boolean;
	compaction: { responsesCompactEnabled: boolean };
};

type ConfigWriteResult = { ok: true } | { ok: false; error: string };
type ConfigToggleResult<K extends "fast" | "responsesCompactEnabled"> = ({ ok: true } & Record<K, boolean>) | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getConfigPath(agentDir: string): string {
	return join(agentDir, CONFIG_BASENAME);
}

/** @deprecated Use getConfigPath. */
export const getFastConfigPath = getConfigPath;

export function readConfig(configPath: string): CodexEnhancedConfig {
	try {
		const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
		const compaction = isRecord(parsed) && isRecord(parsed.compaction) ? parsed.compaction : {};
		return {
			fast: isRecord(parsed) && parsed.fast === true,
			compaction: { responsesCompactEnabled: compaction.responsesCompactEnabled === true },
		};
	} catch {
		return { fast: false, compaction: { responsesCompactEnabled: false } };
	}
}

/** @deprecated Use readConfig. */
export function readFastConfig(configPath: string): Pick<CodexEnhancedConfig, "fast"> {
	return { fast: readConfig(configPath).fast };
}

function writeConfigValue(
	configPath: string,
	update: (document: Record<string, unknown>) => Record<string, unknown>,
): ConfigWriteResult {
	const temporaryPath = `${configPath}.${process.pid}.${Date.now()}.${globalThis.crypto.randomUUID()}.tmp`;
	const lockPath = `${configPath}.lock`;
	let owned = false;
	try {
		mkdirSync(dirname(configPath), { recursive: true });
		mkdirSync(lockPath, { mode: 0o700 });
		owned = true;
		let document: Record<string, unknown> = {};
		try {
			const existing = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
			if (isRecord(existing)) document = existing;
		} catch {
			// A settings write replaces a missing or unreadable document.
		}
		writeFileSync(temporaryPath, `${JSON.stringify(update(document), null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		renameSync(temporaryPath, configPath);
		return { ok: true };
	} catch (error) {
		try {
			unlinkSync(temporaryPath);
		} catch (cleanupError) {
			if (!isRecord(cleanupError) || cleanupError.code !== "ENOENT") {
				const writeError = error instanceof Error ? error.message : String(error);
				const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
				return { ok: false, error: `${writeError}; temporary file cleanup also failed: ${cleanupMessage}` };
			}
		}
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	} finally {
		if (owned) {
			try { rmdirSync(lockPath); }
			catch { return { ok: false, error: "Settings lock cleanup failed; verify no writer is operating before removing the orphan lock." }; }
		}
	}
}

export function readAutoResetPreference(configPath: string, accountKey: string): { enabled: boolean; revision?: string } {
	try {
		const root = JSON.parse(readFileSync(configPath, "utf8"));
		const resets = isRecord(root) && isRecord(root.resets) ? root.resets : {};
		return {
			enabled: isRecord(resets.autoByAccount) && resets.autoByAccount[accountKey] === true,
			revision: isRecord(resets.revisionByAccount) ? stringValue(resets.revisionByAccount[accountKey]) : undefined,
		};
	} catch {
		return { enabled: false };
	}
}

export function writeAutoResetPreference(configPath: string, accountKey: string, enabled: boolean): ConfigWriteResult {
	if (!accountKey.startsWith("account:") || accountKey.length <= 8) return { ok: false, error: "Current account is required." };
	return writeConfigValue(configPath, (document) => {
		const resets = isRecord(document.resets) ? document.resets : {};
		return {
			...document,
			resets: {
				...resets,
				autoByAccount: { ...(isRecord(resets.autoByAccount) ? resets.autoByAccount : {}), [accountKey]: enabled },
				revisionByAccount: { ...(isRecord(resets.revisionByAccount) ? resets.revisionByAccount : {}), [accountKey]: globalThis.crypto.randomUUID() },
			},
		};
	});
}

export function writeFastConfig(fast: boolean, configPath: string): ConfigWriteResult {
	return writeConfigValue(configPath, (document) => ({ ...document, fast }));
}

export function writeResponsesCompactConfig(enabled: boolean, configPath: string): ConfigWriteResult {
	return writeConfigValue(configPath, (document) => ({
		...document,
		compaction: {
			...(isRecord(document.compaction) ? document.compaction : {}),
			responsesCompactEnabled: enabled,
		},
	}));
}

export function toggleFastConfig(configPath: string): ConfigToggleResult<"fast"> {
	const fast = !readConfig(configPath).fast;
	const result = writeFastConfig(fast, configPath);
	return "error" in result ? result : { ok: true, fast };
}

export function toggleResponsesCompactConfig(configPath: string): ConfigToggleResult<"responsesCompactEnabled"> {
	const responsesCompactEnabled = !readConfig(configPath).compaction.responsesCompactEnabled;
	const result = writeResponsesCompactConfig(responsesCompactEnabled, configPath);
	return "error" in result ? result : { ok: true, responsesCompactEnabled };
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function integerValue(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
	if (typeof value !== "string" || value.trim().length === 0) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : undefined;
}

function parseWindow(value: unknown): UsageWindow | undefined {
	if (!isRecord(value)) return undefined;
	const usedPercent = numberValue(value.used_percent);
	const seconds = numberValue(value.limit_window_seconds);
	const minutes = numberValue(value.window_minutes);
	const windowMinutes = minutes !== undefined && seconds !== undefined && minutes !== seconds / 60
		? undefined : minutes ?? (seconds === undefined ? undefined : seconds / 60);
	const resetsAt = numberValue(value.resets_at) ?? numberValue(value.reset_at);
	return usedPercent === undefined && windowMinutes === undefined && resetsAt === undefined
		? undefined
		: { usedPercent, windowMinutes, resetsAt };
}

function parseRateLimit(value: unknown): Pick<UsageLimit, "primary" | "secondary"> {
	if (!isRecord(value)) return {};
	const primary = parseWindow(value.primary_window) ?? parseWindow(value.primary);
	const secondary = parseWindow(value.secondary_window) ?? parseWindow(value.secondary);
	return primary?.windowMinutes === WEEKLY_WINDOW_MINUTES && !secondary ? { secondary: primary } : { primary, secondary };
}

function parseResetCredit(value: unknown): ResetCredit | undefined {
	if (!isRecord(value)) return undefined;
	const invalidMetadata = ["expires_at", "status", "reset_type"].some((key) =>
		value[key] !== undefined && value[key] !== null && !stringValue(value[key]));
	return {
		id: stringValue(value.id), status: stringValue(value.status), expiresAt: stringValue(value.expires_at),
		...(invalidMetadata ? { invalidMetadata: true as const } : {}),
		...(stringValue(value.reset_type) ? { resetType: stringValue(value.reset_type) } : {}),
	};
}

function resetCreditExpiry(expiresAt: string | undefined): number {
	if (!expiresAt) return Number.POSITIVE_INFINITY;
	const parsed = Date.parse(expiresAt);
	return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

export function selectResetCredit(credits: ResetCredit[], now = Date.now()): ResetCredit | undefined {
	return credits
		.filter((credit) => credit.id
			&& (!credit.status || credit.status === "available")
			&& resetCreditExpiry(credit.expiresAt) > now)
		.sort((left, right) => {
			const expiryOrder = resetCreditExpiry(left.expiresAt) - resetCreditExpiry(right.expiresAt);
			return Number.isNaN(expiryOrder) || expiryOrder === 0
				? ((left.id ?? "") < (right.id ?? "") ? -1 : (left.id ?? "") > (right.id ?? "") ? 1 : 0)
				: expiryOrder;
		})[0];
}

/** Auto never uses malformed known expiry as an unexpiring credit. */
export function selectAutoResetCredit(credits: ResetCredit[], now = Date.now()): ResetCredit | undefined {
	return selectResetCredit(credits.filter((credit) => {
		if (credit.invalidMetadata || (credit.resetType && credit.resetType !== "codex_rate_limits")) return false;
		if (credit.expiresAt === undefined) return true;
		const match = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(credit.expiresAt);
		if (!match || !Number.isFinite(Date.parse(credit.expiresAt))) return false;
		const days = new Date(Date.UTC(Number(match[1]), Number(match[2]), 0)).getUTCDate();
		return Number(match[3]) >= 1 && Number(match[3]) <= days;
	}), now);
}

/** Only a freshly fetched main weekly window can exhaust or rearm the spend guard. */
export function weeklyResetObservation(snapshot: UsageSnapshot, now = Date.now()): "exhausted" | "recovered" | "unknown" {
	const main = snapshot.limits.find((limit) => limit.limitId === "codex");
	const weekly = [main?.primary, main?.secondary].filter((window) => window?.windowMinutes === WEEKLY_WINDOW_MINUTES);
	if (weekly.length !== 1) return "unknown";
	const window = weekly[0]!;
	if (window.usedPercent === undefined || !Number.isFinite(window.usedPercent) || window.usedPercent < 0
		|| window.resetsAt === undefined || !Number.isFinite(new Date(window.resetsAt * 1000).getTime())
		|| window.resetsAt * 1000 <= now) return "unknown";
	return window.usedPercent >= 100 ? "exhausted" : "recovered";
}

export function parseResetCredits(value: unknown): ResetCredits | undefined {
	if (!isRecord(value)) return undefined;
	const availableCount = integerValue(value.available_count);
	if (availableCount === undefined) return undefined;
	const credits = Array.isArray(value.credits)
		? value.credits.map(parseResetCredit).filter((credit): credit is ResetCredit => Boolean(credit))
		: [];
	return { availableCount, credits };
}

export function parseUsagePayload(payload: unknown): UsageSnapshot {
	const root = isRecord(payload) ? payload : {};
	const limits: UsageLimit[] = [];
	const addLimit = (limitId: string, limitName: string | undefined, source: unknown) => {
		const rateLimit = isRecord(source) && "rate_limit" in source ? source.rate_limit : source;
		limits.push({ limitId, ...(limitName ? { limitName } : {}), ...parseRateLimit(rateLimit) });
	};

	addLimit("codex", undefined, root.rate_limit);
	if (Array.isArray(root.additional_rate_limits)) {
		for (const item of root.additional_rate_limits) {
			if (!isRecord(item)) continue;
			addLimit(stringValue(item.metered_feature) ?? "additional", stringValue(item.limit_name), item);
		}
	}

	return {
		planType: stringValue(root.plan_type),
		limits,
		resetCredits: parseResetCredits(root.rate_limit_reset_credits),
	};
}

export function parseResetResult(payload: unknown): ResetResult {
	const root = isRecord(payload) ? payload : {};
	const code = stringValue(root.code);
	const outcome: ResetOutcome = code === "reset" || code === "already_redeemed" || code === "nothing_to_reset" || code === "no_credit"
		? code
		: "unknown";
	return { outcome, windowsReset: integerValue(root.windows_reset) };
}

export function weeklyUsageLeft(snapshot: UsageSnapshot): number | undefined {
	const limit = snapshot.limits.find(({ limitId }) => limitId === "codex");
	const weekly = [limit?.primary, limit?.secondary].find((window) => window?.windowMinutes === WEEKLY_WINDOW_MINUTES);
	return weekly?.usedPercent === undefined ? undefined : 100 - Math.max(0, Math.min(100, weekly.usedPercent));
}

export function isCanonicalBaseUrl(value: string | undefined, allowCodexPath = false): boolean {
	try {
		const url = new URL(value ?? DEFAULT_CODEX_BASE_URL);
		const path = url.pathname.replace(/\/+$/, "");
		return url.protocol === "https:"
			&& url.hostname === "chatgpt.com"
			&& url.port === ""
			&& (path === "/backend-api" || (allowCodexPath && path === "/backend-api/codex"));
	} catch {
		return false;
	}
}

export function isCanonicalCodexModel(model: RuntimeModel | undefined): model is RuntimeModel {
	return model?.provider === "openai-codex"
		&& model.api === "openai-codex-responses"
		&& isCanonicalBaseUrl(model.baseUrl);
}

export function injectFastServiceTier<T>(
	payload: T,
	model: RuntimeModel | undefined,
	fast: boolean,
): (T & { service_tier: "priority" }) | undefined {
	if (!fast || !isCanonicalCodexModel(model) || !isRecord(payload) || Object.hasOwn(payload, "service_tier")) return undefined;
	return { ...payload, service_tier: "priority" };
}
