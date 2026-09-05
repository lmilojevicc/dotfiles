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

import { unwatchFile, watchFile } from "node:fs";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import {
	getConfigPath as resolveConfigPath,
	injectFastServiceTier,
	isCanonicalBaseUrl,
	isCanonicalCodexModel,
	parseResetCredits,
	parseResetResult,
	parseUsagePayload,
	readConfig as readConfigFile,
	readAutoResetPreference,
	writeAutoResetPreference,
	toggleFastConfig as toggleFastConfigFile,
	toggleResponsesCompactConfig as toggleResponsesCompactConfigFile,
	weeklyUsageLeft,
	type ResetCredit,
	type ResetCredits,
	type ResetResult,
	type RuntimeModel,
	type UsageLimit,
	type UsageSnapshot,
	type UsageWindow,
} from "./core.ts";
import {
	applyCompactedHistory,
	captureRequestShape,
	compactOnServer,
	reconstructCompactedHistory,
	withCurrentActiveTools,
	type RequestShape,
} from "./compaction.ts";
import { fetchBoundedJson, requestSignal, withAbort } from "./network.ts";
import { coordinateReset, preserveLegacyReset, readResetJournal, withResetAccountLock, resetAccountStatus, type ResetOperationResult } from "./resets.ts";

const STATUS_KEY = "codex-enhanced";
const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const RESET_CREDITS_CACHE_MS = 5_000;
const WEEKLY_USAGE_CACHE_MS = 5 * 60_000;

type AccountUsageSnapshot = UsageSnapshot & { accountKey: string };
type UsageState = AccountUsageSnapshot | { error: string } | undefined;
type MenuTab = "quota" | "resets" | "fast" | "compaction";
const MENU_TABS: readonly MenuTab[] = ["quota", "resets", "fast", "compaction"];
let resetCreditsCache: { key: string; expiresAt: number; promise: Promise<ResetCredits | undefined> } | undefined;
const weeklyUsageCache = new Map<string, { value?: number; expiresAt: number; promise?: Promise<number | undefined> }>();

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getConfigPath(): string {
	return resolveConfigPath(getAgentDir());
}

function readConfig(configPath: string = getConfigPath()) {
	return readConfigFile(configPath);
}

function toggleFastConfig(configPath: string = getConfigPath()) {
	return toggleFastConfigFile(configPath);
}

function toggleResponsesCompactConfig(configPath: string = getConfigPath()) {
	return toggleResponsesCompactConfigFile(configPath);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
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

async function buildHeaders(ctx: ExtensionContext): Promise<Headers> {
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
	return await fetchBoundedJson(url, options);
}

async function fetchDetailedResetCredits(headers: Headers, signal?: AbortSignal): Promise<ResetCredits | undefined> {
	const key = accountKey(headers);
	if (key && resetCreditsCache?.key === key && resetCreditsCache.expiresAt > Date.now()) return resetCreditsCache.promise;
	const promise = fetchJson(`${DEFAULT_CODEX_BASE_URL}/wham/rate-limit-reset-credits`, { method: "GET", headers, signal })
		.then(parseResetCredits);
	if (key) resetCreditsCache = { key, expiresAt: Date.now() + RESET_CREDITS_CACHE_MS, promise };
	return promise;
}

async function fetchUsageWithHeaders(headers: Headers, signal?: AbortSignal, includeDetailedResetCredits = true): Promise<AccountUsageSnapshot> {
	const key = accountKey(headers);
	if (!key) throw new Error("Canonical OpenAI Codex subscription auth is required.");
	const snapshot = parseUsagePayload(await fetchJson(`${DEFAULT_CODEX_BASE_URL}/wham/usage`, { method: "GET", headers, signal }));
	if (includeDetailedResetCredits && (!snapshot.resetCredits || snapshot.resetCredits.availableCount > 0)) {
		try {
			const detailed = await fetchDetailedResetCredits(headers, signal);
			if (detailed) snapshot.resetCredits = detailed;
		} catch {
			// Reset-credit details are additive; basic quota data is still useful.
		}
	}
	return { ...snapshot, accountKey: key };
}

async function fetchUsage(ctx: ExtensionContext, signal?: AbortSignal): Promise<AccountUsageSnapshot> {
	const boundedSignal = requestSignal(signal);
	const headers = await withAbort(buildHeaders(ctx), boundedSignal);
	return fetchUsageWithHeaders(headers, boundedSignal);
}

async function fetchWeeklyUsageLeft(ctx: ExtensionContext, signal?: AbortSignal): Promise<number | undefined> {
	const combinedSignal = requestSignal(signal);
	try {
		const headers = await withAbort(buildHeaders(ctx), combinedSignal);
		const key = accountKey(headers);
		if (!key) return undefined;
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
		return undefined;
	}
}

async function resolveResetAccount(ctx: ExtensionContext, signal?: AbortSignal): Promise<{ key: string; headers: Headers }> {
	const boundedSignal = requestSignal(signal);
	const headers = await withAbort(buildHeaders(ctx), boundedSignal);
	const key = accountKey(headers);
	if (!key) throw new Error("Canonical OpenAI Codex subscription auth is required.");
	return { key, headers };
}

async function consumeResetCredit(
	headers: Headers,
	creditId: string,
	redeemRequestId: string,
	signal?: AbortSignal,
): Promise<ResetResult> {
	if (!creditId?.trim()) throw new Error("No usable reset credit ID is available. Refresh reset credits before retrying.");
	const accountId = headers.get("chatgpt-account-id")?.trim();
	if (!accountId) throw new Error("Canonical OpenAI Codex subscription auth is required.");
	headers.set("content-type", "application/json");
	resetCreditsCache = undefined;
	const result = parseResetResult(await fetchJson(`${DEFAULT_CODEX_BASE_URL}/wham/rate-limit-reset-credits/consume`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			credit_id: creditId,
			redeem_request_id: redeemRequestId,
			account_id: accountId,
		}),
		signal,
	}));
	resetCreditsCache = undefined;
	if (result.outcome === "reset" || result.outcome === "already_redeemed") {
		const key = accountKey(headers);
		if (key) weeklyUsageCache.delete(key);
	}
	return result;
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

function legacyResetIntents(): Map<string, { requestId?: string; creditId?: string }> {
	const store: unknown = Reflect.get(globalThis, Symbol.for("codex-enhanced.reset-request-store"));
	const intents = new Map<string, { requestId?: string; creditId?: string }>();
	if (store instanceof Map) for (const [key, value] of store) {
		if (typeof key !== "string" || !key.startsWith("account:")) continue;
		intents.set(key, {
			requestId: isRecord(value) ? stringValue(value.requestId) : undefined,
			creditId: isRecord(value) ? stringValue(value.creditId) : undefined,
		});
	}
	return intents;
}

async function runCoordinatedReset(
	ctx: ExtensionContext,
	mode: "auto" | "manual",
	signal: AbortSignal,
	isCurrent: () => boolean,
	expectedAccountKey?: string,
	manualAfterRequestId?: string,
	onReconciled?: (usage: AccountUsageSnapshot) => void,
): Promise<ResetOperationResult> {
	try {
		const modelIdentity = JSON.stringify(ctx.model);
		const account = await resolveResetAccount(ctx, signal);
		const configPath = getConfigPath();
		const preference = readAutoResetPreference(configPath, account.key);
		if (expectedAccountKey && account.key !== expectedAccountKey) throw new Error("Account changed");
		let headers = account.headers;
		const check = () => {
			signal.throwIfAborted();
			if (!isCurrent() || ctx.mode !== "tui" || JSON.stringify(ctx.model) !== modelIdentity) throw new Error("Context changed");
			if (mode === "auto") {
				const current = readAutoResetPreference(configPath, account.key);
				if (!isCanonicalCodexModel(ctx.model) || !preference.enabled || !current.enabled
					|| preference.revision !== current.revision) throw new Error("Consent changed");
			}
		};
		const validate = async () => {
			check();
			const current = await resolveResetAccount(ctx, signal);
			check();
			if (current.key !== account.key || current.headers.get("authorization") !== account.headers.get("authorization")) throw new Error("Auth changed");
			headers = current.headers;
		};
		check();
		return await coordinateReset({
			agentDir: getAgentDir(), accountKey: account.key, mode, validate, checkBeforePost: check, manualAfterRequestId,
			legacyIntent: legacyResetIntents().get(account.key),
			readUsage: () => fetchUsageWithHeaders(headers, signal, false),
			// Spending decisions never use the menu's five-second detail cache.
			readCredits: async () => parseResetCredits(await fetchJson(`${DEFAULT_CODEX_BASE_URL}/wham/rate-limit-reset-credits`, { method: "GET", headers, signal })),
			consume: (creditId, requestId) => consumeResetCredit(headers, creditId, requestId, signal),
			refresh: async () => {
				const usage = await fetchUsageWithHeaders(headers, signal, false);
				await validate();
				resetCreditsCache = undefined;
				const credits = await fetchDetailedResetCredits(headers, signal);
				await validate();
				check();
				if (credits) usage.resetCredits = credits;
				onReconciled?.(usage); // Display only; never an automatic recovery observation.
			},
		});
	} catch {
		return { status: "Paused: current account, model, consent or lifecycle changed/unavailable; no new POST." };
	}
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
	armed: boolean,
	autoEnabled: boolean,
	status: string,
): string[] {
	const usage = usageState && !("error" in usageState) ? usageState : undefined;
	const count = usage?.resetCredits?.availableCount;
	const busy = accountLoading;
	const lines = [
		`  ${theme.bold("Banked resets")}${loading ? theme.fg("dim", "  refreshing…") : ""}${busy ? theme.fg("dim", "  resetting…") : ""}`,
		`  Available: ${theme.bold(count === undefined ? "unknown" : String(count))}`,
	];
	if (usageState && "error" in usageState) lines.push(theme.fg("error", "  Usage unavailable. R to retry."));
	if (count && count > 0) lines.push(theme.fg("dim", `  Expires: ${formatResetCreditExpiries(usage?.resetCredits?.credits ?? [])}`));
	lines.push(
		`  ${theme.bold("Auto reset")}  ${autoEnabled ? "on" : "off"} · this account`,
		"  Weekly 0% · soonest expiry first · no prompts",
		`  ${status}`,
		...(status.includes("journal/lock") ? ["  Recovery instructions: see README."] : []),
	);
	if (armed) lines.push(theme.fg("warning", "  Reset armed — Ctrl+R again to use one reset."));
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

function formatCompactionLines(theme: Theme, enabled: boolean, eligible: boolean): string[] {
	const value = enabled ? theme.fg("accent", "on") : theme.fg("dim", "off");
	const status = enabled
		? theme.fg(eligible ? "accent" : "dim", `  Globally enabled · Pi compaction uses OpenAI's encrypted Responses compaction item for canonical Codex sessions.${eligible ? "" : " Current model is ineligible."}`)
		: theme.fg("dim", "  Globally off · Pi uses its normal local compaction.");
	return [
		`  ${theme.bold("Server compaction")}  ${value}`,
		status,
		theme.fg("dim", "  The menu is always accessible; this setting only applies to canonical OpenAI Codex Responses models."),
		theme.fg("dim", "  Remote failures fall back to Pi's local compaction without replacing session history."),
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

type ResetMenuControls = {
	checkAuto: () => Promise<void>;
	captureCurrent: () => () => boolean;
	changed: () => void;
	status: (accountKey: string) => string;
	track: <T>(operation: Promise<T>) => Promise<T>;
	onStatusChange: (render: (usage?: AccountUsageSnapshot) => void) => () => void;
};

async function openUsage(ctx: ExtensionContext, shutdownSignal: AbortSignal, controls: ResetMenuControls): Promise<void> {
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
		let usageRevision = 0;
		let resetAccountLoading = false;
		let resetAccountKey: string | undefined;
		let resetArmedAccountKey: string | undefined;
		let resetRunning = false;
		let resetMessage: string | undefined;
		let manualRefresh: { accountKey: string; requestId?: string } | undefined;

		const render = () => {
			if (!viewSignal.aborted) tui.requestRender();
		};
		const stopStatusListener = controls.onStatusChange((usage) => {
			if (viewSignal.aborted) return;
			if (usage && (!resetAccountKey || usage.accountKey === resetAccountKey)) {
				usageRevision += 1; // Do not let an older menu GET overwrite reconciliation.
				usageState = usage;
				resetAccountKey = usage.accountKey;
				manualRefresh = undefined;
				resetArmedAccountKey = undefined;
			}
			render();
		});
		const configPath = getConfigPath();
		const onConfigChange = () => render();
		let configWatcherActive = true;
		watchFile(configPath, { interval: 250, persistent: false }, onConfigChange);
		const stopConfigWatcher = () => {
			if (!configWatcherActive) return;
			configWatcherActive = false;
			stopStatusListener();
			unwatchFile(configPath, onConfigChange);
		};
		const closeOnShutdown = () => {
			stopConfigWatcher();
			done(undefined);
		};
		shutdownSignal.addEventListener("abort", closeOnShutdown, { once: true });
		const load = (account?: { key: string; headers: Headers }, explicit = false) => {
			if (usageLoading) return;
			usageLoading = true;
			resetArmedAccountKey = undefined;
			render();
			const current = controls.captureCurrent();
			const modelIdentity = JSON.stringify(ctx.model);
			const revision = ++usageRevision;
			if (explicit) manualRefresh = undefined;
			const usagePromise = explicit ? (async () => {
				const before = await resolveResetAccount(ctx, viewSignal);
				const readDisplay = async () => {
					const usage = await fetchUsageWithHeaders(before.headers, viewSignal);
					const after = await resolveResetAccount(ctx, viewSignal);
					if (viewSignal.aborted || !current() || JSON.stringify(ctx.model) !== modelIdentity
						|| before.key !== after.key || before.headers.get("authorization") !== after.headers.get("authorization")) throw new Error("Account or context changed.");
					return usage;
				};
				try {
					const refreshed = await withResetAccountLock(getAgentDir(), before.key, async () => {
						const journal = readResetJournal(getAgentDir(), before.key);
						const usage = await readDisplay();
						return { usage, requestId: journal && !["pending", "ambiguous", "unknown"].includes(journal.phase) ? journal.requestId : undefined };
					});
					if (!viewSignal.aborted && current() && revision === usageRevision) {
						manualRefresh = { accountKey: before.key, requestId: refreshed.requestId };
					}
					return refreshed.usage;
				} catch {
					// Read-only quota remains available with a busy/orphan lock or corrupt journal.
					// No manual authorization is issued unless the entire coordinated refresh succeeds.
					return readDisplay();
				}
			})() : account
				? fetchUsageWithHeaders(account.headers, requestSignal(viewSignal))
				: fetchUsage(ctx, viewSignal);
			usagePromise
				.then((usage) => {
					if (viewSignal.aborted || revision !== usageRevision || !current()) return;
					usageState = usage;
					resetAccountKey = usage.accountKey;
				})
				.catch((error) => {
					if (!viewSignal.aborted && revision === usageRevision && current()) usageState = { error: error instanceof Error ? error.message : String(error) };
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
		const startReset = async () => {
			if (usageLoading || resetAccountLoading || resetRunning) return;
			const current = controls.captureCurrent();
			const account = await ensureResetAccount();
			if (!account || viewSignal.aborted || !current()) return;
			if (!usageState || "error" in usageState || usageState.accountKey !== account.key) {
				load(account);
				return;
			}
			if (resetArmedAccountKey !== account.key) {
				resetArmedAccountKey = account.key;
				render();
				return;
			}
			resetArmedAccountKey = undefined;
			resetRunning = true;
			render();
			const result = await controls.track(runCoordinatedReset(ctx, "manual", shutdownSignal, current, account.key,
				manualRefresh?.accountKey === account.key ? manualRefresh.requestId : undefined));
			manualRefresh = undefined;
			resetRunning = false;
			resetMessage = result.result ? `${formatResetResult(result.result)} ${result.status}` : result.status;
			if (!viewSignal.aborted) load();
			render();
		};
		const toggleAuto = async () => {
			const displayedAccountKey = resetAccountKey;
			const current = controls.captureCurrent();
			const account = await ensureResetAccount();
			if (!account || viewSignal.aborted || !current()) return;
			resetArmedAccountKey = undefined;
			if (!displayedAccountKey || displayedAccountKey !== account.key) {
				resetMessage = "Account changed; refreshed current account. No spending preference changed.";
				load(account);
				return;
			}
			const preference = readAutoResetPreference(configPath, account.key);
			const result = writeAutoResetPreference(configPath, account.key, !preference.enabled);
			controls.changed();
			if ("error" in result) ctx.ui.notify("Failed to save automatic reset preference; verify config permissions/lock.", "error");
			else if (!preference.enabled) void controls.checkAuto().then(render);
			render();
		};
		const activateTab = (tab: MenuTab) => {
			activeTab = tab;
			resetArmedAccountKey = undefined;
			if (tab === "resets" && !resetAccountKey) void ensureResetAccount();
			render();
		};
		const cycleTab = (offset: number) => {
			const index = MENU_TABS.indexOf(activeTab);
			activateTab(MENU_TABS[(index + offset + MENU_TABS.length) % MENU_TABS.length] ?? "quota");
		};
		const toggleFast = () => {
			const result = toggleFastConfig();
			if ("error" in result) ctx.ui.notify(`Failed to save Fast mode: ${result.error}`, "error");
			render();
		};
		const toggleCompaction = () => {
			const result = toggleResponsesCompactConfig();
			if ("error" in result) ctx.ui.notify(`Failed to save server compaction: ${result.error}`, "error");
			render();
		};

		load();
		return {
			render: (width: number) => {
				const tabs = `  ${activeTab === "quota" ? theme.bold("Quota") : theme.fg("dim", "Quota")}  ${theme.fg("dim", "/")}  ${activeTab === "resets" ? theme.bold("Resets") : theme.fg("dim", "Resets")}  ${theme.fg("dim", "/")}  ${activeTab === "fast" ? theme.bold("Fast") : theme.fg("dim", "Fast")}  ${theme.fg("dim", "/")}  ${activeTab === "compaction" ? theme.bold("Compaction") : theme.fg("dim", "Compaction")}`;
				const footer = activeTab === "quota"
					? "  Tab next · Shift+Tab previous · R to refresh · Esc to close"
					: activeTab === "fast" || activeTab === "compaction"
						? "  Tab next · Shift+Tab previous · Enter/Space toggle · Esc to close"
						: "  Tab next · Shift+Tab previous · Enter/Space auto toggle · R refresh · Ctrl+R manual reset · Esc close";
				const config = readConfig();
				const eligible = isCanonicalCodexModel(ctx.model as RuntimeModel | undefined);
				return [
					theme.fg("accent", "─".repeat(Math.max(0, width))),
					tabs,
					theme.fg("borderMuted", "─".repeat(Math.max(0, width))),
					...(activeTab === "quota"
						? formatQuotaLines(theme, usageState, usageLoading)
						: activeTab === "resets"
							? formatResetLines(theme, usageState, usageLoading, resetAccountLoading || resetRunning,
								Boolean(resetAccountKey && resetArmedAccountKey === resetAccountKey),
								resetAccountKey ? readAutoResetPreference(configPath, resetAccountKey).enabled : false,
								resetMessage ?? (resetAccountKey ? controls.status(resetAccountKey) : "Resolve current account to change automatic spending."))
							: activeTab === "fast"
								? formatFastLines(theme, config.fast, eligible)
								: formatCompactionLines(theme, config.compaction.responsesCompactEnabled, eligible)),
					"",
					theme.fg("dim", footer),
					theme.fg("accent", "─".repeat(Math.max(0, width))),
				].map((line) => truncateToWidth(line, width, ""));
			},
			invalidate: render,
			dispose: () => {
				shutdownSignal.removeEventListener("abort", closeOnShutdown);
				stopConfigWatcher();
				viewController.abort();
			},
			handleInput: (data: string) => {
				if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
					stopConfigWatcher();
					viewController.abort();
					done(undefined);
				} else if (matchesKey(data, "shift+tab")) {
					cycleTab(-1);
				} else if (matchesKey(data, "tab")) {
					cycleTab(1);
				} else if (activeTab === "fast" && (matchesKey(data, "enter") || matchesKey(data, "space"))) {
					toggleFast();
				} else if (activeTab === "compaction" && (matchesKey(data, "enter") || matchesKey(data, "space"))) {
					toggleCompaction();
				} else if (activeTab === "resets" && (matchesKey(data, "enter") || matchesKey(data, "space"))) {
					void toggleAuto();
				} else if (activeTab === "resets" && matchesKey(data, "ctrl+r")) {
					void startReset();
				} else if ((activeTab === "quota" || activeTab === "resets") && data.toLowerCase() === "r") {
					resetMessage = undefined;
					load(undefined, true);
				}
			},
		};
	});
}

async function runCompactionHook(
	event: Parameters<typeof compactOnServer>[0],
	ctx: ExtensionContext,
	shape: RequestShape,
) {
	if (event.signal.aborted) return { cancel: true } as const;
	try {
		const compaction = await compactOnServer(event, ctx, shape);
		if (event.signal.aborted) return { cancel: true } as const;
		return compaction ? { compaction } : undefined;
	} catch (error) {
		if (event.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
			return { cancel: true } as const;
		}
		throw error;
	}
}

function setStatus(ctx: ExtensionContext, weeklyLeft?: number): void {
	try {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(STATUS_KEY, weeklyLeft === undefined ? undefined : `Codex weekly: ${Math.round(weeklyLeft)}% left`);
	} catch {
		// UI contexts may become stale during reload or shutdown.
	}
}

export const __testing = Object.freeze({
	consumeResetCredit,
	fetchUsage,
	fetchWeeklyUsageLeft,
	resolveResetAccount,
	runCompactionHook,
	runCoordinatedReset,
	openUsage,
});

export default function codexEnhanced(pi: ExtensionAPI) {
	let generation = 0;
	let shutdownController = new AbortController();
	let lastContext: ExtensionContext | undefined;
	const requestShapeBySession = new Map<string, RequestShape>();
	let active = false;
	let resetGeneration = 0;
	let autoTimer: ReturnType<typeof setInterval> | undefined;
	let autoCheck: Promise<void> | undefined;
	const autoStatus = new Map<string, string>();
	const manualOperations = new Set<Promise<unknown>>();
	const resetStatusListeners = new Set<(usage?: AccountUsageSnapshot) => void>();
	const captureCurrent = () => {
		const captured = resetGeneration;
		return () => active && captured === resetGeneration && !shutdownController.signal.aborted;
	};
	const checkAuto = (): Promise<void> => {
		if (autoCheck) return autoCheck;
		const ctx = lastContext;
		const current = captureCurrent();
		if (!ctx || !current() || ctx.mode !== "tui" || !isCanonicalCodexModel(ctx.model)) return Promise.resolve();
		const signal = shutdownController.signal;
		const promise = (async () => {
			try {
				const account = await resolveResetAccount(ctx, signal);
				if (!current() || !readAutoResetPreference(getConfigPath(), account.key).enabled) return;
				const result = await runCoordinatedReset(ctx, "auto", signal, current, account.key, undefined, (usage) => {
					generation += 1; // Invalidate older footer reads as well as its cached value.
					const weeklyLeft = weeklyUsageLeft(usage);
					weeklyUsageCache.set(usage.accountKey, { value: weeklyLeft, expiresAt: Date.now() + WEEKLY_USAGE_CACHE_MS });
					setStatus(ctx, weeklyLeft);
					for (const render of resetStatusListeners) render(usage);
				});
				if (current()) {
					autoStatus.set(account.key, result.status);
					for (const render of resetStatusListeners) render();
				}
			} catch { /* No auth: do not spend or emit per-minute notifications. */ }
		})();
		autoCheck = promise;
		void promise.finally(() => { if (autoCheck === promise) autoCheck = undefined; });
		return promise;
	};
	const stopAuto = () => {
		active = false;
		resetGeneration += 1;
		if (autoTimer) clearInterval(autoTimer);
		autoTimer = undefined;
	};

	const clearStatus = (ctx?: ExtensionContext) => {
		generation += 1;
		if (ctx) setStatus(ctx);
	};
	const refreshStatus = async (ctx: ExtensionContext) => {
		lastContext = ctx;
		const currentGeneration = ++generation;
		if (!ctx.hasUI) return;
		const weeklyLeft = await fetchWeeklyUsageLeft(ctx, shutdownController.signal);
		if (currentGeneration !== generation || shutdownController.signal.aborted) return;
		setStatus(ctx, weeklyLeft);
	};

	pi.registerCommand("codex-enhanced", {
		description: "Open Codex quota, resets, Fast mode, and server compaction settings",
		handler: async (_args, ctx) => {
			const signal = shutdownController.signal;
			await openUsage(ctx, signal, {
				captureCurrent,
				changed: () => { resetGeneration += 1; },
				checkAuto: async () => { if (autoCheck) await autoCheck; await checkAuto(); },
				status: (key) => {
					const durable = resetAccountStatus(getAgentDir(), key);
					if (durable.startsWith("Paused")) return durable;
					if (!readAutoResetPreference(getConfigPath(), key).enabled) return "Automatic spending off.";
					if (!isCanonicalCodexModel(ctx.model)) return "Inactive: select a canonical Codex model for automatic checks.";
					return autoStatus.get(key) ?? durable;
				},
				onStatusChange: (render) => {
					resetStatusListeners.add(render);
					return () => { resetStatusListeners.delete(render); };
				},
				track: async (operation) => {
					manualOperations.add(operation);
					try { return await operation; } finally { manualOperations.delete(operation); }
				},
			});
			if (!signal.aborted && signal === shutdownController.signal) void refreshStatus(ctx);
		},
	});

	pi.on("before_provider_request", (event, ctx) => {
		const model = ctx.model as RuntimeModel | undefined;
		let payload = event.payload;
		if (isCanonicalCodexModel(model) && model.id) {
			const history = reconstructCompactedHistory(ctx.sessionManager.getBranch() as never, model);
			const replayed = history ? applyCompactedHistory(payload, history) : undefined;
			if (replayed) payload = replayed;
		}
		const fastPayload = injectFastServiceTier(payload, model, readConfig().fast);
		if (fastPayload) payload = fastPayload;
		if (isCanonicalCodexModel(model) && model.id) {
			const shape = captureRequestShape(payload);
			if (shape) requestShapeBySession.set(ctx.sessionManager.getSessionId(), shape);
		}
		return payload === event.payload ? undefined : payload;
	});
	pi.on("session_before_compact", async (event, ctx) => {
		if (!readConfig().compaction.responsesCompactEnabled) return undefined;
		return runCompactionHook(
			event,
			ctx,
			withCurrentActiveTools(pi, requestShapeBySession.get(ctx.sessionManager.getSessionId())),
		);
	});
	pi.on("session_start", async (_event, ctx) => {
		stopAuto();
		shutdownController.abort();
		shutdownController = new AbortController();
		active = ctx.mode === "tui";
		clearStatus(lastContext);
		void refreshStatus(ctx);
		const signal = shutdownController.signal;
		for (const [key, intent] of legacyResetIntents()) {
			try { await preserveLegacyReset(getAgentDir(), key, intent); }
			catch { autoStatus.set(key, "Paused: legacy reset could not be journaled. Reconcile original request; do not restart to erase it."); }
		}
		if (active && !signal.aborted) {
			autoTimer = setInterval(() => { void checkAuto(); }, 60_000);
			autoTimer.unref?.();
			void checkAuto();
		}
	});
	pi.on("model_select", (_event, ctx) => {
		resetGeneration += 1;
		clearStatus(lastContext);
		void refreshStatus(ctx);
	});
	pi.on("agent_settled", (_event, ctx) => {
		void refreshStatus(ctx);
		void checkAuto();
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		stopAuto();
		shutdownController.abort();
		await autoCheck;
		await Promise.allSettled([...manualOperations]);
		requestShapeBySession.delete(ctx.sessionManager.getSessionId());
		clearStatus(ctx);
		if (lastContext && lastContext !== ctx) setStatus(lastContext);
		lastContext = undefined;
	});
}
