/*
 * Menu, quota, and reset behavior adapted from @howaboua/pi-codex-conversion 3.0.14:
 * https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/d2e9b82f8abafa24f8488d5211f8307ea4815edb/packages/pi-codex-conversion
 *
 * MIT License — Copyright © 2026 Umberto B.
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, unwatchFile, watchFile, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

const STATUS_KEY = "codex-enhanced";
const FAST_CONFIG_BASENAME = "codex-enhanced.json";
const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;
const RESET_CREDITS_CACHE_MS = 5_000;
const WEEKLY_USAGE_CACHE_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

type RuntimeModel = {
	provider: string;
	api: string;
	baseUrl?: string;
};

type UsageWindow = {
	usedPercent?: number;
	windowMinutes?: number;
	resetsAt?: number;
};

type UsageLimit = {
	limitId: string;
	limitName?: string;
	primary?: UsageWindow;
	secondary?: UsageWindow;
};

type ResetCredit = {
	status?: string;
	expiresAt?: string;
};

type ResetCredits = {
	availableCount: number;
	credits: ResetCredit[];
};

type UsageSnapshot = {
	planType?: string;
	limits: UsageLimit[];
	resetCredits?: ResetCredits;
};

type ResetOutcome = "reset" | "already_redeemed" | "nothing_to_reset" | "no_credit" | "unknown";

type ResetResult = {
	outcome: ResetOutcome;
	windowsReset?: number;
};

type UsageState = UsageSnapshot | { error: string } | undefined;
type MenuTab = "quota" | "resets" | "fast";
type FastConfig = { fast: boolean };
type FastConfigWriteResult = { ok: true } | { ok: false; error: string };
type FastConfigToggleResult = { ok: true; fast: boolean } | { ok: false; error: string };
type ResetRequestPhase = "pending" | "ambiguous" | "locked";
type ResetRequestState = {
	requestId: string;
	phase: ResetRequestPhase;
	promise?: Promise<ResetResult>;
	message?: { kind: "info" | "error"; text: string };
};
type ResetRequestStore = Map<string, ResetRequestState>;

const MENU_TABS: readonly MenuTab[] = ["quota", "resets", "fast"];
const RESET_REQUEST_STORE = Symbol.for("codex-enhanced.reset-request-store");
const globalResetState = globalThis as typeof globalThis & { [RESET_REQUEST_STORE]?: ResetRequestStore };
const resetRequestStateByAccount = globalResetState[RESET_REQUEST_STORE] ??= new Map();
let resetCreditsCache: { key: string; expiresAt: number; promise: Promise<ResetCredits | undefined> } | undefined;
const weeklyUsageCache = new Map<string, { value?: number; expiresAt: number; promise?: Promise<number | undefined> }>();
const weeklyUsageKeyByModel = new WeakMap<object, string>();

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getFastConfigPath(agentDir: string = getAgentDir()): string {
	return join(agentDir, FAST_CONFIG_BASENAME);
}

function readFastConfig(configPath: string = getFastConfigPath()): FastConfig {
	try {
		const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
		return { fast: isRecord(parsed) && parsed.fast === true };
	} catch {
		return { fast: false };
	}
}

function writeFastConfig(fast: boolean, configPath: string = getFastConfigPath()): FastConfigWriteResult {
	const temporaryPath = `${configPath}.${process.pid}.${Date.now()}.${globalThis.crypto.randomUUID()}.tmp`;
	try {
		mkdirSync(dirname(configPath), { recursive: true });
		let document: Record<string, unknown> = {};
		try {
			const existing = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
			if (isRecord(existing)) document = existing;
		} catch {
			// A settings write replaces a missing or unreadable document.
		}
		writeFileSync(temporaryPath, `${JSON.stringify({ ...document, fast }, null, 2)}\n`, {
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
	}
}

function toggleFastConfig(configPath: string = getFastConfigPath()): FastConfigToggleResult {
	const fast = !readFastConfig(configPath).fast;
	const result = writeFastConfig(fast, configPath);
	return result.ok ? { ok: true, fast } : result;
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
	const windowMinutes = numberValue(value.window_minutes) ?? (seconds === undefined ? undefined : Math.ceil(seconds / 60));
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
	return { status: stringValue(value.status), expiresAt: stringValue(value.expires_at) };
}

function parseResetCredits(value: unknown): ResetCredits | undefined {
	if (!isRecord(value)) return undefined;
	const availableCount = integerValue(value.available_count);
	if (availableCount === undefined) return undefined;
	const credits = Array.isArray(value.credits)
		? value.credits.map(parseResetCredit).filter((credit): credit is ResetCredit => Boolean(credit))
		: [];
	return { availableCount, credits };
}

function parseUsagePayload(payload: unknown): UsageSnapshot {
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

function parseResetResult(payload: unknown): ResetResult {
	const root = isRecord(payload) ? payload : {};
	const code = stringValue(root.code);
	const outcome: ResetOutcome = code === "reset" || code === "already_redeemed" || code === "nothing_to_reset" || code === "no_credit"
		? code
		: "unknown";
	return { outcome, windowsReset: integerValue(root.windows_reset) };
}

function weeklyUsageLeft(snapshot: UsageSnapshot): number | undefined {
	const limit = snapshot.limits.find(({ limitId }) => limitId === "codex");
	const weekly = [limit?.primary, limit?.secondary].find((window) => window?.windowMinutes === WEEKLY_WINDOW_MINUTES);
	return weekly?.usedPercent === undefined ? undefined : 100 - Math.max(0, Math.min(100, weekly.usedPercent));
}

function isCanonicalBaseUrl(value: string | undefined, allowCodexPath = false): boolean {
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

function isCanonicalCodexModel(model: RuntimeModel | undefined): model is RuntimeModel {
	return model?.provider === "openai-codex"
		&& model.api === "openai-codex-responses"
		&& isCanonicalBaseUrl(model.baseUrl);
}

function extractAccountId(token: string): string | undefined {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return undefined;
		const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as unknown;
		const authClaims = isRecord(payload) ? payload[JWT_CLAIM_PATH] : undefined;
		return isRecord(authClaims) ? stringValue(authClaims.chatgpt_account_id) : undefined;
	} catch {
		return undefined;
	}
}

async function buildHeaders(ctx: ExtensionContext, model: RuntimeModel): Promise<Headers> {
	if (!isCanonicalCodexModel(model)) throw new Error("Codex usage requires the canonical ChatGPT subscription endpoint.");
	const resolved = await ctx.modelRegistry.getProviderAuth("openai-codex");
	const token = resolved?.auth.apiKey;
	if (!token || !isCanonicalBaseUrl(resolved?.auth.baseUrl, true)) {
		throw new Error("Canonical OpenAI Codex subscription auth is required.");
	}
	const accountId = extractAccountId(token);
	if (!accountId) throw new Error("Canonical OpenAI Codex subscription auth is required.");
	return new Headers({
		accept: "application/json",
		authorization: `Bearer ${token}`,
		"chatgpt-account-id": accountId,
		"OAI-Language": "en",
		originator: "pi",
	});
}

function accountKey(headers: Headers): string | undefined {
	const accountId = headers.get("chatgpt-account-id")?.trim();
	return accountId ? `account:${accountId}` : undefined;
}

async function fetchJson(url: string, options: RequestInit): Promise<unknown> {
	const response = await fetch(url, options);
	if (!response.ok) throw new Error(`Codex request failed (${response.status} ${response.statusText})`);
	return JSON.parse(await response.text()) as unknown;
}

async function fetchDetailedResetCredits(headers: Headers, signal?: AbortSignal): Promise<ResetCredits | undefined> {
	const key = accountKey(headers);
	if (key && resetCreditsCache?.key === key && resetCreditsCache.expiresAt > Date.now()) return resetCreditsCache.promise;
	const promise = fetchJson(`${DEFAULT_CODEX_BASE_URL}/wham/rate-limit-reset-credits`, { method: "GET", headers, signal })
		.then(parseResetCredits);
	if (key) resetCreditsCache = { key, expiresAt: Date.now() + RESET_CREDITS_CACHE_MS, promise };
	return promise;
}

async function fetchUsageWithHeaders(headers: Headers, signal?: AbortSignal, includeDetailedResetCredits = true): Promise<UsageSnapshot> {
	const snapshot = parseUsagePayload(await fetchJson(`${DEFAULT_CODEX_BASE_URL}/wham/usage`, { method: "GET", headers, signal }));
	if (includeDetailedResetCredits && (!snapshot.resetCredits || snapshot.resetCredits.availableCount > 0)) {
		try {
			const detailed = await fetchDetailedResetCredits(headers, signal);
			if (detailed) snapshot.resetCredits = detailed;
		} catch {
			// Reset-credit details are additive; basic quota data is still useful.
		}
	}
	return snapshot;
}

async function fetchUsage(ctx: ExtensionContext, signal?: AbortSignal): Promise<UsageSnapshot> {
	const model = ctx.model as RuntimeModel | undefined;
	if (!model) throw new Error("No active model selected.");
	if (model.provider !== "openai-codex") throw new Error("Codex usage is only available for OpenAI Codex subscription models.");
	return fetchUsageWithHeaders(await buildHeaders(ctx, model), signal);
}

async function fetchWeeklyUsageLeft(ctx: ExtensionContext, signal?: AbortSignal): Promise<number | undefined> {
	const model = ctx.model as RuntimeModel | undefined;
	if (!isCanonicalCodexModel(model)) return undefined;
	const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	try {
		const headers = await withAbort(buildHeaders(ctx, model), combinedSignal);
		const key = accountKey(headers);
		if (!key) return undefined;
		weeklyUsageKeyByModel.set(model as object, key);
		const cached = weeklyUsageCache.get(key);
		if (cached && cached.expiresAt > Date.now()) return cached.value;
		if (cached?.promise) return cached.promise;
		const entry = cached ?? { expiresAt: 0 };
		const previous = entry.value;
		const promise = (async () => {
			try {
				entry.value = weeklyUsageLeft(await fetchUsageWithHeaders(headers, combinedSignal, false));
				entry.expiresAt = Date.now() + WEEKLY_USAGE_CACHE_MS;
			} catch {
				entry.value = previous;
			} finally {
				entry.promise = undefined;
			}
			return entry.value;
		})();
		entry.promise = promise;
		weeklyUsageCache.set(key, entry);
		return promise;
	} catch {
		const previousKey = weeklyUsageKeyByModel.get(model as object);
		return previousKey ? weeklyUsageCache.get(previousKey)?.value : undefined;
	}
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	});
}

function createRedeemRequestId(): string {
	return globalThis.crypto.randomUUID();
}

async function resolveResetAccount(ctx: ExtensionContext, signal?: AbortSignal): Promise<{ key: string; headers: Headers }> {
	const model = ctx.model as RuntimeModel | undefined;
	if (!model) throw new Error("No active model selected.");
	if (model.provider !== "openai-codex") throw new Error("Codex reset credits are only available for OpenAI Codex subscription models.");
	const headers = await withOptionalAbort(buildHeaders(ctx, model), signal);
	const key = accountKey(headers);
	if (!key) throw new Error("Canonical OpenAI Codex subscription auth is required.");
	return { key, headers };
}

async function consumeResetCredit(headers: Headers, redeemRequestId: string, signal?: AbortSignal): Promise<ResetResult> {
	headers.set("content-type", "application/json");
	resetCreditsCache = undefined;
	const result = parseResetResult(await fetchJson(`${DEFAULT_CODEX_BASE_URL}/wham/rate-limit-reset-credits/consume`, {
		method: "POST",
		headers,
		body: JSON.stringify({ redeem_request_id: redeemRequestId }),
		signal,
	}));
	resetCreditsCache = undefined;
	if (result.outcome === "reset" || result.outcome === "already_redeemed") {
		const key = accountKey(headers);
		if (key) weeklyUsageCache.delete(key);
	}
	return result;
}

function withOptionalAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	return signal ? withAbort(promise, signal) : promise;
}

function usageBar(percent: number | undefined): string {
	if (percent === undefined) return "░░░░░░░░░░";
	const filled = Math.max(0, Math.min(10, Math.round(percent / 10)));
	return "█".repeat(filled) + "░".repeat(10 - filled);
}

function formatResetShort(timestampSeconds: number | undefined): string {
	if (!timestampSeconds) return "reset ?";
	const remainingMs = timestampSeconds * 1000 - Date.now();
	if (remainingMs <= 0) return "~now";
	const minutes = Math.ceil(remainingMs / 60_000);
	if (minutes < 60) return `~${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `~${hours}h`;
	return `~${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function usageColumns(window: UsageWindow | undefined): { bar: string; percent: string; reset: string } {
	if (!window) return { bar: "", percent: "", reset: "" };
	const percent = window.usedPercent === undefined ? undefined : 100 - Math.max(0, Math.min(100, window.usedPercent));
	return {
		bar: usageBar(percent),
		percent: percent === undefined ? "?%" : `${Math.round(percent)}%`,
		reset: formatResetShort(window.resetsAt),
	};
}

function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function columnWidths(rows: string[][]): number[] {
	return Array.from({ length: Math.max(...rows.map((row) => row.length)) }, (_, index) =>
		Math.max(...rows.map((row) => stripAnsi(row[index] ?? "").length)));
}

function formatRow(row: string[], widths: number[]): string {
	return `  ${row.map((cell, index) => cell + " ".repeat(Math.max(0, (widths[index] ?? 0) - stripAnsi(cell).length))).join("  ")}`;
}

function formatResetCreditExpiries(credits: ResetCredit[]): string {
	const expiries = credits
		.map((credit) => ({ credit, ms: credit.expiresAt ? Date.parse(credit.expiresAt) : Number.NaN }))
		.filter(({ credit, ms }) => Number.isFinite(ms) && (!credit.status || credit.status === "available"))
		.sort((left, right) => left.ms - right.ms);
	if (expiries.length === 0) return "unknown";
	const shown = expiries.slice(0, 3).map(({ ms }, index) => {
		const minutes = Math.round((ms - Date.now()) / 60_000);
		const expiry = minutes <= 0 ? "expired" : minutes < 90 ? `in ~${minutes}m` : minutes < 60 * 48 ? `in ~${Math.round(minutes / 60)}h` : `in ~${Math.round(minutes / 1440)}d`;
		return `#${index + 1} ${expiry}`;
	});
	return `${shown.join(" · ")}${expiries.length > shown.length ? ` · +${expiries.length - shown.length} more` : ""}`;
}

function formatResetResult(result: ResetResult): string {
	if (result.outcome === "reset") return "Codex rate limits reset.";
	if (result.outcome === "already_redeemed") return "Reset already applied; refreshed usage.";
	if (result.outcome === "nothing_to_reset") return "No active Codex limit to reset.";
	if (result.outcome === "no_credit") return "No banked resets available.";
	return "Reset response was not recognized; refreshed usage.";
}

function visibleUsageLimits(snapshot: UsageSnapshot): UsageLimit[] {
	return snapshot.limits.filter((limit) => !/spark/i.test(`${limit.limitName ?? ""} ${limit.limitId}`));
}

function formatQuotaLines(theme: Theme, usageState: UsageState, loading: boolean): string[] {
	if (!usageState) return [theme.fg("dim", "  Loading Codex usage…")];
	if ("error" in usageState) return [theme.fg("error", `  ${usageState.error}`), theme.fg("dim", "  Press R to retry.")];

	const rows = visibleUsageLimits(usageState).map((limit) => {
		const primary = usageColumns(limit.primary);
		const secondary = usageColumns(limit.secondary);
		return [limit.limitName ?? limit.limitId, primary.bar, primary.percent, primary.reset, secondary.bar, secondary.percent, secondary.reset];
	});
	const headers = ["Limit", "5h left", "", "Reset", "Weekly left", "", "Reset"];
	const widths = columnWidths([headers, ...rows]);
	return [
		`  ${theme.bold(`Codex quota${usageState.planType ? ` · ${usageState.planType}` : ""}`)}${loading ? theme.fg("dim", "  refreshing…") : ""}`,
		"",
		formatRow(headers.map((header) => theme.fg("dim", header)), widths),
		theme.fg("borderMuted", `  ${"─".repeat(widths.reduce((sum, width) => sum + width, 0) + 2 * (widths.length - 1))}`),
		...rows.map((row) => formatRow(row, widths)),
	];
}

function formatResetLines(
	theme: Theme,
	usageState: UsageState,
	loading: boolean,
	accountLoading: boolean,
	requestState: ResetRequestState | undefined,
	armed: boolean,
): string[] {
	if (!usageState) return [theme.fg("dim", "  Loading banked resets…")];
	if ("error" in usageState) return [theme.fg("error", `  ${usageState.error}`), theme.fg("dim", "  Press R to retry.")];

	const count = usageState.resetCredits?.availableCount;
	const busy = accountLoading || requestState?.phase === "pending";
	const lines = [
		`  ${theme.bold("Banked resets")}${loading ? theme.fg("dim", "  refreshing…") : ""}${busy ? theme.fg("dim", "  resetting…") : ""}`,
		`  Available: ${theme.bold(count === undefined ? "unknown" : String(count))}`,
	];
	if (count && count > 0) lines.push(theme.fg("dim", `  Expires: ${formatResetCreditExpiries(usageState.resetCredits?.credits ?? [])}`));
	if (requestState?.message) lines.push(theme.fg(requestState.message.kind === "error" ? "error" : "accent", `  ${requestState.message.text}`));
	if (requestState?.phase === "ambiguous") lines.push(theme.fg("warning", "  Outcome is unknown. Ctrl+R retries the same request ID; another reset is blocked."));
	else if (requestState?.phase === "locked") lines.push(theme.fg("dim", "  Press R to refresh before using another reset."));
	else if (armed) lines.push(theme.fg("warning", "  Reset armed — press Ctrl+R again to consume one banked reset."));
	else if (count && count > 0) lines.push(theme.fg("dim", "  Press Ctrl+R twice to consume one banked reset."));
	return lines;
}

function formatFastLines(theme: Theme, fast: boolean, eligible: boolean): string[] {
	const value = fast ? theme.fg("accent", "on") : theme.fg("dim", "off");
	const status = fast
		? theme.fg(eligible ? "accent" : "dim", `  Globally enabled · subsequent canonical Codex requests without an explicit tier are eligible.${eligible ? "" : " Current model is ineligible."}`)
		: theme.fg("dim", "  Globally off · outgoing service tier is left untouched.");
	return [
		`  ${theme.bold("Fast mode")}  ${value}`,
		status,
		...(fast ? [theme.fg("dim", "  Served tier is unobserved; the backend may still serve standard processing.")] : []),
		theme.fg("dim", "  This setting persists globally across Pi sessions; toggling changes all sessions on their next request."),
		theme.fg("dim", "  Enter or Space to toggle."),
	];
}

function formatUsageText(snapshot: UsageSnapshot): string {
	const lines = [`Codex usage${snapshot.planType ? ` (${snapshot.planType})` : ""}:`];
	if (snapshot.resetCredits) lines.push(`- resets available: ${snapshot.resetCredits.availableCount}`);
	for (const limit of visibleUsageLimits(snapshot)) {
		const formatWindow = (label: string, window: UsageWindow | undefined) => {
			if (!window) return undefined;
			const remaining = window.usedPercent === undefined ? "?" : String(Math.round(100 - Math.max(0, Math.min(100, window.usedPercent))));
			return `${label}: ${remaining}% left (${formatResetShort(window.resetsAt)})`;
		};
		const windows = [formatWindow("5h", limit.primary), formatWindow("weekly", limit.secondary)].filter(Boolean);
		lines.push(`- ${limit.limitName ?? limit.limitId}: ${windows.length ? windows.join("; ") : "no usage data"}`);
	}
	return lines.join("\n");
}

async function openUsage(ctx: ExtensionContext, shutdownSignal: AbortSignal): Promise<void> {
	if (ctx.mode !== "tui") {
		try {
			ctx.ui.notify(formatUsageText(await fetchUsage(ctx, shutdownSignal)), "info");
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
		return;
	}

	const viewController = new AbortController();
	const viewSignal = AbortSignal.any([shutdownSignal, viewController.signal]);
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		let activeTab: MenuTab = "quota";
		let usageState: UsageState;
		let usageLoading = false;
		let resetAccountLoading = false;
		let resetAccountKey: string | undefined;
		let resetArmed = false;

		const render = () => {
			if (!viewSignal.aborted) tui.requestRender();
		};
		const fastConfigPath = getFastConfigPath();
		const onFastConfigChange = () => render();
		let fastConfigWatcherActive = true;
		watchFile(fastConfigPath, { interval: 250, persistent: false }, onFastConfigChange);
		const stopFastConfigWatcher = () => {
			if (!fastConfigWatcherActive) return;
			fastConfigWatcherActive = false;
			unwatchFile(fastConfigPath, onFastConfigChange);
		};
		const closeOnShutdown = () => {
			stopFastConfigWatcher();
			done(undefined);
		};
		shutdownSignal.addEventListener("abort", closeOnShutdown, { once: true });
		const currentResetState = () => resetAccountKey ? resetRequestStateByAccount.get(resetAccountKey) : undefined;
		const load = (unlockSettledReset = false) => {
			if (usageLoading) return;
			const unlockAccountKey = unlockSettledReset ? resetAccountKey : undefined;
			const stateAtLoad = unlockAccountKey ? resetRequestStateByAccount.get(unlockAccountKey) : undefined;
			const stateToUnlock = stateAtLoad?.phase === "locked" ? stateAtLoad : undefined;
			usageLoading = true;
			resetArmed = false;
			render();
			fetchUsage(ctx, viewSignal)
				.then((usage) => {
					usageState = usage;
					if (stateToUnlock?.phase === "locked" && unlockAccountKey && resetRequestStateByAccount.get(unlockAccountKey) === stateToUnlock) {
						resetRequestStateByAccount.delete(unlockAccountKey);
					}
				})
				.catch((error) => {
					if (!viewSignal.aborted) usageState = { error: error instanceof Error ? error.message : String(error) };
				})
				.finally(() => { usageLoading = false; render(); });
		};
		const ensureResetAccount = async (): Promise<{ key: string; headers: Headers } | undefined> => {
			if (resetAccountLoading) return undefined;
			resetAccountLoading = true;
			render();
			try {
				const account = await resolveResetAccount(ctx, viewSignal);
				resetAccountKey = account.key;
				return account;
			} catch (error) {
				if (!viewSignal.aborted) usageState = { error: error instanceof Error ? error.message : String(error) };
				return undefined;
			} finally {
				resetAccountLoading = false;
				render();
			}
		};
		const watchReset = (state: ResetRequestState) => {
			void state.promise?.then(
				() => {
					if (!viewSignal.aborted) {
						usageState = undefined;
						load();
					}
					render();
				},
				() => render(),
			);
		};
		const startReset = async () => {
			if (usageLoading || resetAccountLoading) return;
			const account = await ensureResetAccount();
			if (!account || viewSignal.aborted) return;
			const existing = resetRequestStateByAccount.get(account.key);
			if (existing?.phase === "pending") {
				watchReset(existing);
				return;
			}
			if (existing?.phase === "locked") return;
			if (!existing && (!usageState || "error" in usageState || (usageState.resetCredits?.availableCount ?? 0) < 1)) return;
			if (!existing && !resetArmed) {
				resetArmed = true;
				render();
				return;
			}

			resetArmed = false;
			const state: ResetRequestState = existing ?? { requestId: createRedeemRequestId(), phase: "pending" };
			state.phase = "pending";
			state.message = undefined;
			state.promise = consumeResetCredit(account.headers, state.requestId, shutdownSignal)
				.then((result) => {
					state.phase = "locked";
					state.message = {
						kind: result.outcome === "reset" || result.outcome === "already_redeemed" ? "info" : "error",
						text: formatResetResult(result),
					};
					return result;
				})
				.catch((error) => {
					state.phase = "ambiguous";
					state.message = { kind: "error", text: error instanceof Error ? error.message : String(error) };
					throw error;
				})
				.finally(() => { state.promise = undefined; });
			resetRequestStateByAccount.set(account.key, state);
			watchReset(state);
			render();
		};
		const activateTab = (tab: MenuTab) => {
			activeTab = tab;
			resetArmed = false;
			if (tab === "resets" && !resetAccountKey) void ensureResetAccount();
			render();
		};
		const cycleTab = (offset: number) => {
			const index = MENU_TABS.indexOf(activeTab);
			activateTab(MENU_TABS[(index + offset + MENU_TABS.length) % MENU_TABS.length] ?? "quota");
		};
		const toggleFast = () => {
			const result = toggleFastConfig();
			if (!result.ok) ctx.ui.notify(`Failed to save Fast mode: ${result.error}`, "error");
			render();
		};

		load();
		return {
			render: (width: number) => {
				const tabs = `  ${activeTab === "quota" ? theme.bold("Quota") : theme.fg("dim", "Quota")}  ${theme.fg("dim", "/")}  ${activeTab === "resets" ? theme.bold("Resets") : theme.fg("dim", "Resets")}  ${theme.fg("dim", "/")}  ${activeTab === "fast" ? theme.bold("Fast") : theme.fg("dim", "Fast")}`;
				const requestState = currentResetState();
				const footer = activeTab === "quota"
					? "  Tab next · Shift+Tab previous · R to refresh · Esc to close"
					: activeTab === "fast"
						? "  Tab next · Shift+Tab previous · Enter/Space toggle · Esc to close"
						: requestState?.phase === "ambiguous"
							? "  Tab next · Shift+Tab previous · Ctrl+R retry same reset · R refresh usage · Esc to close"
							: "  Tab next · Shift+Tab previous · R to refresh · Ctrl+R use reset · Esc to close";
				return [
					theme.fg("accent", "─".repeat(Math.max(0, width))),
					tabs,
					theme.fg("borderMuted", "─".repeat(Math.max(0, width))),
					...(activeTab === "quota"
						? formatQuotaLines(theme, usageState, usageLoading)
						: activeTab === "resets"
							? formatResetLines(theme, usageState, usageLoading, resetAccountLoading, requestState, resetArmed)
							: formatFastLines(theme, readFastConfig().fast, isCanonicalCodexModel(ctx.model as RuntimeModel | undefined))),
					"",
					theme.fg("dim", footer),
					theme.fg("accent", "─".repeat(Math.max(0, width))),
				].map((line) => truncateToWidth(line, width, ""));
			},
			invalidate: render,
			dispose: () => {
				shutdownSignal.removeEventListener("abort", closeOnShutdown);
				stopFastConfigWatcher();
				viewController.abort();
			},
			handleInput: (data: string) => {
				if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
					stopFastConfigWatcher();
					viewController.abort();
					done(undefined);
				} else if (matchesKey(data, "shift+tab")) {
					cycleTab(-1);
				} else if (matchesKey(data, "tab")) {
					cycleTab(1);
				} else if (activeTab === "fast" && (matchesKey(data, "enter") || matchesKey(data, "space"))) {
					toggleFast();
				} else if (activeTab === "resets" && matchesKey(data, "ctrl+r")) {
					void startReset();
				} else if (activeTab !== "fast" && data.toLowerCase() === "r") {
					load(true);
				}
			},
		};
	});
}

function setStatus(ctx: ExtensionContext, weeklyLeft?: number): void {
	try {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(STATUS_KEY, weeklyLeft === undefined ? undefined : `Codex weekly: ${Math.round(weeklyLeft)}% left`);
	} catch {
		// UI contexts may become stale during reload or shutdown.
	}
}

export default function codexEnhanced(pi: ExtensionAPI) {
	let generation = 0;
	let shutdownController = new AbortController();
	let lastContext: ExtensionContext | undefined;

	const clearStatus = (ctx?: ExtensionContext) => {
		generation += 1;
		if (ctx) setStatus(ctx);
	};
	const refreshStatus = async (ctx: ExtensionContext) => {
		lastContext = ctx;
		const currentGeneration = ++generation;
		if (!ctx.hasUI || !isCanonicalCodexModel(ctx.model as RuntimeModel | undefined)) {
			setStatus(ctx);
			return;
		}
		const weeklyLeft = await fetchWeeklyUsageLeft(ctx, shutdownController.signal);
		if (currentGeneration !== generation || shutdownController.signal.aborted) return;
		if (!isCanonicalCodexModel(ctx.model as RuntimeModel | undefined)) {
			setStatus(ctx);
			return;
		}
		setStatus(ctx, weeklyLeft);
	};

	pi.registerCommand("codex-enhanced", {
		description: "Open Codex quota, banked reset, and Fast mode menu",
		handler: async (_args, ctx) => {
			await openUsage(ctx, shutdownController.signal);
			void refreshStatus(ctx);
		},
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!readFastConfig().fast) return undefined;
		if (!isCanonicalCodexModel(ctx.model as RuntimeModel | undefined)) return undefined;
		if (!isRecord(event.payload) || Object.hasOwn(event.payload, "service_tier")) return undefined;
		return { ...event.payload, service_tier: "priority" };
	});
	pi.on("session_start", (_event, ctx) => {
		shutdownController.abort();
		shutdownController = new AbortController();
		clearStatus(lastContext);
		void refreshStatus(ctx);
	});
	pi.on("model_select", (_event, ctx) => {
		clearStatus(lastContext);
		void refreshStatus(ctx);
	});
	pi.on("agent_settled", (_event, ctx) => {
		void refreshStatus(ctx);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		shutdownController.abort();
		clearStatus(ctx);
		if (lastContext && lastContext !== ctx) setStatus(lastContext);
		lastContext = undefined;
	});
}
