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
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
	getConfigPath as resolveConfigPath,
	injectFastServiceTier,
	isCanonicalBaseUrl,
	isCanonicalCodexModel,
	parseResetCredits,
	selectAutoResetCredit,
	selectResetCredit,
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
import { coordinateReset, legacyResetIntent, preserveLegacyReset, readResetJournal, withResetAccountLock, resetPaths, resetAccountState, manualResetNeedsRefresh, offerLegacyAcknowledgement, acknowledgeLegacyReset, type LegacyAcknowledgementOffer, type ResetAccountState, type LegacyResetIntent, type ResetOperationResult, type ManualResetAction } from "./resets.ts";
import { inspectResetLock, probeResetLock, type ResetLockAvailability } from "./reset-lock.ts";

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

function formatResetCreditExpiries(credits: ResetCredit[], count: number): string[] {
	const now = Date.now();
	const usable = credits.filter((credit) => selectAutoResetCredit([credit], now));
	const expiries = usable.filter((credit) => credit.expiresAt).sort((a, b) => Date.parse(a.expiresAt!) - Date.parse(b.expiresAt!));
	const labels = expiries.slice(0, 3).map((credit) => {
		const minutes = Math.max(1, Math.ceil((Date.parse(credit.expiresAt!) - now) / 60_000));
		return minutes < 90 ? `~${minutes}m` : minutes < 2880 ? `~${Math.round(minutes / 60)}h` : `~${Math.round(minutes / 1440)}d`;
	});
	if (!labels.length) return ["Expiry unknown"];
	const partial = expiries.length < count || usable.length !== credits.length;
	return [`Next expiry in ${labels[0]}${labels.length > 1 ? ` · then ${labels.slice(1).join(", ")}` : ""}${expiries.length > 3 ? ` · +${expiries.length - 3} more` : ""}`,
		...(partial ? ["Other expiry details unknown"] : [])];
}

/** Layout with terminal cells, not byte/string length; truncation is only the outer safety net. */
function resetWrappedLines(text: string, width: number): string[] {
	return wrapTextWithAnsi(text, Math.max(1, width - 2)).map((line) => `  ${line}`);
}

function packControls(controls: string[], width: number): string[] {
	const lines: string[] = [];
	for (const control of controls) {
		const previous = lines.at(-1);
		if (previous && visibleWidth(`${previous} · ${control}`) <= width - 2) lines[lines.length - 1] = `${previous} · ${control}`;
		else lines.push(...wrapTextWithAnsi(control, Math.max(1, width - 2)));
	}
	return lines;
}

function formatResetResult(result: ResetResult): string {
	if (result.outcome === "reset") return "Codex rate limits reset.";
	if (result.outcome === "already_redeemed") return "Reset already applied; refreshed usage.";
	if (result.outcome === "nothing_to_reset") return "No active Codex limit to reset.";
	if (result.outcome === "no_credit") return "No banked resets available.";
	return "Reset response was not recognized; refreshed usage.";
}

function legacyResetIntents(): Map<string, LegacyResetIntent> {
	const store: unknown = Reflect.get(globalThis, Symbol.for("codex-enhanced.reset-request-store"));
	const intents = new Map<string, LegacyResetIntent>();
	if (store instanceof Map) for (const [key, value] of store) {
		if (typeof key !== "string" || !key.startsWith("account:")) continue;
		intents.set(key, legacyResetIntent(value));
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
	onApplying?: () => void,
	manualAction?: ManualResetAction,
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
			agentDir: getAgentDir(), accountKey: account.key, mode, validate, checkBeforePost: check, manualAfterRequestId, manualAction,
			legacyIntent: () => legacyResetIntents().get(account.key),
			readUsage: () => fetchUsageWithHeaders(headers, signal, false),
			// Spending decisions never use the menu's five-second detail cache.
			readCredits: async () => parseResetCredits(await fetchJson(`${DEFAULT_CODEX_BASE_URL}/wham/rate-limit-reset-credits`, { method: "GET", headers, signal })),
			consume: (creditId, requestId) => { onApplying?.(); return consumeResetCredit(headers, creditId, requestId, signal); },
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

function formatResetLines(theme: Theme, usageState: UsageState, loading: boolean,
	autoEnabled: boolean | undefined, status: string, width: number): string[] {
	const usage = usageState && !("error" in usageState) ? usageState : undefined;
	const count = usage?.resetCredits?.availableCount;
	const balance = count === undefined ? (!usageState && loading ? "Loading banked resets…" : "Banked resets: unknown")
		: `${count} banked reset${count === 1 ? "" : "s"}`;
	const lines = resetWrappedLines(theme.bold(balance), width);
	if (count && count > 0) for (const expiry of formatResetCreditExpiries(usage?.resetCredits?.credits ?? [], count)) {
		lines.push(...resetWrappedLines(theme.fg("muted", expiry), width));
	}
	const setting = `Auto reset ${autoEnabled === undefined ? "—" : autoEnabled ? theme.fg("accent", "on") : theme.fg("text", "off")}`;
	const full = `${setting} · Weekly 0% · soonest expiry first · no prompts`;
	const short = `${setting} · Weekly 0% · expiry first · no prompts`;
	lines.push("");
	if (visibleWidth(full) <= width - 2) lines.push(`  ${full}`);
	else if (visibleWidth(short) <= width - 2) lines.push(`  ${short}`);
	else {
		// Exactly one policy wrap at supported narrow widths, preserving "no prompts".
		lines.push(`  ${setting} · Weekly 0%`, `  ${theme.fg("muted", "expiry first · no prompts")}`);
	}
	if (status) lines.push("", ...resetWrappedLines(theme.fg("warning", status), width));
	return lines;
}

/** One muted rule per tab: abbreviated at narrow widths, never wrapped or dropped. */
function fitSettingRule(full: string, short: string, width: number): string {
	if (visibleWidth(full) <= width - 2) return full;
	return truncateToWidth(short, Math.max(1, width - 2), "…");
}

function formatFastLines(theme: Theme, fast: boolean, status: string, width: number): string[] {
	const rule = fast
		? fitSettingRule("Fast service tier on Codex requests · served tier unobserved", "Fast tier · served tier unobserved", width)
		: fitSettingRule("Standard processing · service tier untouched", "Standard processing", width);
	return [
		`  ${theme.bold("Fast mode")}  ${fast ? theme.fg("accent", "on") : theme.fg("text", "off")}`,
		`  ${theme.fg("muted", rule)}`,
		...(status ? ["", ...resetWrappedLines(theme.fg("warning", status), width)] : []),
	];
}

function formatCompactionLines(theme: Theme, enabled: boolean, status: string, width: number): string[] {
	const rule = enabled
		? fitSettingRule("Server-side compaction for Codex sessions · falls back to local", "Codex sessions · local fallback", width)
		: "Pi compacts sessions locally";
	return [
		`  ${theme.bold("Server compaction")}  ${enabled ? theme.fg("accent", "on") : theme.fg("text", "off")}`,
		`  ${theme.fg("muted", rule)}`,
		...(status ? ["", ...resetWrappedLines(theme.fg("warning", status), width)] : []),
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
	clearStatus: (accountKey: string) => void;
	activity: (accountKey: string) => "checking" | "applying" | undefined;
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
		let resetArmedAction: string | undefined;
		let armCurrent: (() => boolean) | undefined;
		let lockAvailability: ResetLockAvailability = "available";
		const localAvailability = () => {
			const pathState = resetAccountKey ? inspectResetLock(resetPaths(getAgentDir(), resetAccountKey).lock) : "available";
			return pathState === "available" ? lockAvailability : pathState;
		};
		let fastMessage: string | undefined;
		let compactionMessage: string | undefined;
		let manualInteractionRevision = 0;
		// Keep confirmation Enter reserved even after an asynchronous render clears the arm.
		let manualEnterReserved = false;
		const cancelManual = (deliberateAction = false) => {
			if (deliberateAction) manualEnterReserved = false;
			manualInteractionRevision += 1;
			resetArmedAccountKey = undefined;
			resetArmedAction = undefined;
			armCurrent = undefined;
		};
		let resetRunning = false;
		let resetMessage: string | undefined;
		let manualRefresh: { accountKey: string; requestId?: string } | undefined;
		let recoveryRevision = 0;
		let recoveryFailure: { offer: LegacyAcknowledgementOffer; contextCurrent: () => boolean } | undefined;
		let recovery: { offer?: LegacyAcknowledgementOffer; outcome?: "reset" | "already_redeemed";
			checking: boolean; valid: () => boolean; contextCurrent: () => boolean; authorization?: string } | undefined;
		const cancelRecovery = () => { recoveryRevision += 1; recovery = undefined; };
		const offerMatches = (offer: LegacyAcknowledgementOffer) => {
			const current = offerLegacyAcknowledgement(getAgentDir(), offer.accountKey,
				() => legacyResetIntents().get(offer.accountKey), localAvailability());
			return current.eligible && current.offer.snapshot === offer.snapshot;
		};
		const offeredRecordCurrent = () => Boolean(recovery?.offer && offerMatches(recovery.offer));
		const durableState = (): ResetAccountState => resetAccountKey
			? resetAccountState(getAgentDir(), resetAccountKey, legacyResetIntents().get(resetAccountKey), localAvailability())
			: { reason: "ready", status: "", manualAction: { kind: "blocked" } };
		const usableManualCredit = () => Boolean(usageState && !("error" in usageState) && usageState.accountKey === resetAccountKey
			&& usageState.resetCredits && usageState.resetCredits.availableCount > 0 && selectResetCredit(usageState.resetCredits.credits));
		const manualEligible = (state: ResetAccountState) => state.manualAction.kind !== "blocked"
			&& !manualResetNeedsRefresh(state.manualAction, manualRefresh)
			&& (state.manualAction.kind === "retry" || usableManualCredit());
		const discardStaleArm = (state: ResetAccountState) => {
			if (resetArmedAccountKey && (resetArmedAccountKey !== resetAccountKey || !armCurrent?.() || !manualEligible(state)
				|| resetArmedAction !== JSON.stringify(state.manualAction))) cancelManual();
		};

		const render = () => {
			if (!viewSignal.aborted) tui.requestRender();
		};
		let stopResetWatcher = () => {};
		let refreshLockStatus = () => {};
		const bindResetAccount = (key: string) => {
			if (viewSignal.aborted || resetAccountKey === key) return;
			stopResetWatcher();
			resetArmedAccountKey = undefined;
			resetArmedAction = undefined;
			armCurrent = undefined;
			manualRefresh = undefined;
			resetAccountKey = key;
			lockAvailability = "available";
			const paths = resetPaths(getAgentDir(), key);
			let watching = true;
			const probeController = new AbortController();
			const probeSignal = AbortSignal.any([viewSignal, probeController.signal]);
			let probing = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const probe = async () => {
				if (!watching || probing) return;
				probing = true;
				if (timer) clearTimeout(timer);
				const state = await probeResetLock(paths.directory, paths.lock, probeSignal);
				probing = false;
				if (!watching || viewSignal.aborted || resetAccountKey !== key) return;
				if (state !== lockAvailability) {
					lockAvailability = state;
					if (state === "available") controls.clearStatus(key);
					render();
				}
				timer = setTimeout(() => void probe(), 1_000);
				timer.unref?.();
			};
			refreshLockStatus = () => { void probe(); };
			const onResetChange = () => {
				if (!watching || resetAccountKey !== key) return;
				render(); // Local reread only; never auth, refresh or auto check.
				void probe();
			};
			for (const path of [paths.lock, paths.journal]) watchFile(path, { interval: 250, persistent: false }, onResetChange);
			void probe();
			stopResetWatcher = () => {
				if (!watching) return;
				watching = false;
				probeController.abort();
				if (timer) clearTimeout(timer);
				for (const path of [paths.lock, paths.journal]) unwatchFile(path, onResetChange);
			};
		};
		const stopStatusListener = controls.onStatusChange((usage) => {
			if (viewSignal.aborted) return;
			cancelRecovery();
			cancelManual();
			recoveryFailure = undefined;
			resetMessage = undefined;
			if (usage && (!resetAccountKey || usage.accountKey === resetAccountKey)) {
				usageRevision += 1; // Do not let an older menu GET overwrite reconciliation.
				usageState = usage;
				bindResetAccount(usage.accountKey);
				manualRefresh = undefined;
			}
			render();
		});
		const configPath = getConfigPath();
		const onConfigChange = () => { if (recovery && (!recovery.valid() || !offeredRecordCurrent())) cancelRecovery(); render(); };
		let configWatcherActive = true;
		watchFile(configPath, { interval: 250, persistent: false }, onConfigChange);
		const stopConfigWatcher = () => {
			if (!configWatcherActive) return;
			configWatcherActive = false;
			stopStatusListener();
			stopResetWatcher();
			unwatchFile(configPath, onConfigChange);
		};
		const closeOnShutdown = () => {
			cancelRecovery();
			cancelManual();
			stopConfigWatcher();
			done(undefined);
		};
		shutdownSignal.addEventListener("abort", closeOnShutdown, { once: true });
		const load = (account?: { key: string; headers: Headers }, explicit = false) => {
			cancelManual(explicit);
			recoveryFailure = undefined;
			if (usageLoading) return;
			cancelRecovery();
			usageLoading = true;
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
					bindResetAccount(usage.accountKey);
				})
				.catch((error) => {
					if (!viewSignal.aborted && revision === usageRevision && current()) usageState = { error: error instanceof Error ? error.message : String(error) };
				})
				.finally(() => { usageLoading = false; refreshLockStatus(); render(); });
		};
		const ensureResetAccount = async (isCurrent = () => true): Promise<{ key: string; headers: Headers } | undefined> => {
			if (resetAccountLoading) return undefined;
			resetAccountLoading = true;
			render();
			try {
				const account = await resolveResetAccount(ctx, viewSignal);
				if (!isCurrent()) return undefined;
				bindResetAccount(account.key);
				return account;
			} catch (error) {
				if (!viewSignal.aborted && isCurrent()) usageState = { error: error instanceof Error ? error.message : String(error) };
				return undefined;
			} finally {
				resetAccountLoading = false;
				render();
			}
		};
		const startReset = async () => {
			const state = durableState();
			discardStaleArm(state);
			if (usageLoading || resetAccountLoading || resetRunning || recovery || !manualEligible(state)) return;
			const revision = ++manualInteractionRevision;
			const lifecycleCurrent = controls.captureCurrent();
			const model = JSON.stringify(ctx.model);
			const current = () => lifecycleCurrent() && !viewSignal.aborted && activeTab === "resets"
				&& revision === manualInteractionRevision && JSON.stringify(ctx.model) === model;
			const action = JSON.stringify(state.manualAction);
			const account = await ensureResetAccount(current);
			if (!account || !current()) return;
			if (state.manualAction.kind !== "retry" && (!usageState || "error" in usageState || usageState.accountKey !== account.key)) {
				load(account);
				return;
			}
			const refreshedState = durableState();
			if (!manualEligible(refreshedState) || action !== JSON.stringify(refreshedState.manualAction)) {
				cancelManual(); render(); return;
			}
			if (resetArmedAccountKey !== account.key || resetArmedAction !== action) {
				manualEnterReserved = true;
				resetArmedAccountKey = account.key;
				resetArmedAction = action;
				armCurrent = () => lifecycleCurrent() && !viewSignal.aborted && activeTab === "resets" && JSON.stringify(ctx.model) === model;
				render();
				return;
			}
			// Clear the visible arm without revoking this confirmed operation's revision.
			resetArmedAccountKey = undefined;
			resetArmedAction = undefined;
			resetRunning = true;
			resetMessage = undefined;
			render();
			const result = await controls.track(runCoordinatedReset(ctx, "manual", shutdownSignal, current, account.key,
				manualRefresh?.accountKey === account.key ? manualRefresh.requestId : undefined, undefined, undefined, JSON.parse(action)));
			manualRefresh = undefined;
			resetRunning = false;
			resetMessage = result.reason === "busy" ? undefined : result.result ? formatResetResult(result.result) : result.displayStatus ?? "Could not apply reset";
			if (!viewSignal.aborted) load();
			render();
		};
		const toggleAuto = async () => {
			cancelRecovery();
			cancelManual(true);
			recoveryFailure = undefined;
			const displayedAccountKey = resetAccountKey;
			const current = controls.captureCurrent();
			const account = await ensureResetAccount();
			if (!account || viewSignal.aborted || !current()) return;
			if (!displayedAccountKey || displayedAccountKey !== account.key) {
				resetMessage = "Account changed; refreshed current account. No spending preference changed.";
				load(account);
				return;
			}
			const preference = readAutoResetPreference(configPath, account.key);
			const result = writeAutoResetPreference(configPath, account.key, !preference.enabled);
			controls.changed();
			if ("error" in result) resetMessage = "Could not save auto reset setting";
			else if (!preference.enabled) void controls.checkAuto().then(render);
			render();
		};
		const beginRecovery = async () => {
			if (recovery || usageLoading || resetAccountLoading || resetRunning || !resetAccountKey) return;
			const key = resetAccountKey;
			const offered = offerLegacyAcknowledgement(getAgentDir(), key, () => legacyResetIntents().get(key), localAvailability());
			if (!offered.eligible) return;
			cancelManual(true);
			recoveryFailure = undefined;
			const revision = ++recoveryRevision;
			const current = controls.captureCurrent();
			const model = JSON.stringify(ctx.model);
			const preference = readAutoResetPreference(configPath, key);
			const contextCurrent = () => !viewSignal.aborted && current() && activeTab === "resets"
				&& resetAccountKey === key && JSON.stringify(ctx.model) === model
				&& JSON.stringify(readAutoResetPreference(configPath, key)) === JSON.stringify(preference);
			const valid = () => contextCurrent() && revision === recoveryRevision;
			const state = { offer: offered.offer, checking: true, valid, contextCurrent, authorization: undefined as string | undefined,
				outcome: undefined as "reset" | "already_redeemed" | undefined };
			recovery = state;
			manualRefresh = undefined;
			render();
			try {
				const account = await resolveResetAccount(ctx, viewSignal);
				if (!valid() || !offeredRecordCurrent() || account.key !== key) throw new Error("Changed");
				state.authorization = account.headers.get("authorization") ?? undefined;
				state.checking = false;
			} catch {
				if (recovery === state) {
					if (state.contextCurrent() && offerMatches(state.offer)) recoveryFailure = { offer: state.offer, contextCurrent: state.contextCurrent };
					cancelRecovery();
				}
			}
			render();
		};
		const confirmRecovery = async () => {
			const state = recovery;
			if (!state?.offer || !state.outcome || state.checking) return;
			state.checking = true;
			render();
			try {
				const account = await resolveResetAccount(ctx, viewSignal);
				const checkCurrent = () => {
					if (!state.valid() || recovery !== state || account.key !== state.offer!.accountKey
						|| account.headers.get("authorization") !== state.authorization) throw new Error("Changed");
				};
				checkCurrent();
				const result = await controls.track(acknowledgeLegacyReset({ agentDir: getAgentDir(), offer: state.offer,
					attestation: { outcome: state.outcome, noPriorOperationInFlight: true }, checkCurrent,
					validateIdentity: async () => {
						const currentAccount = await resolveResetAccount(ctx, viewSignal);
						if (currentAccount.key !== state.offer!.accountKey
							|| currentAccount.headers.get("authorization") !== state.authorization) throw new Error("Changed");
					},
					legacyIntent: () => legacyResetIntents().get(account.key) }));
				if (result.acknowledged) {
					recoveryFailure = undefined;
					controls.clearStatus(account.key);
					manualRefresh = undefined;
					cancelManual();
					resetMessage = "Completion saved locally; no reset used";
				} else if (recovery === state) resetMessage = "Completion not saved; review current state";
			} catch {
				if (recovery === state && state.contextCurrent() && offerMatches(state.offer)) {
					recoveryFailure = { offer: state.offer, contextCurrent: state.contextCurrent };
				}
			}
			if (recovery === state) cancelRecovery();
			render(); // No refresh, auto check, or manual authorization follows acknowledgement.
		};

		const activateTab = (tab: MenuTab) => {
			activeTab = tab;
			cancelRecovery();
			recoveryFailure = undefined;
			fastMessage = undefined;
			compactionMessage = undefined;
			cancelManual(true);
			if (tab === "resets" && !resetAccountKey) void ensureResetAccount();
			render();
		};
		const cycleTab = (offset: number) => {
			const index = MENU_TABS.indexOf(activeTab);
			activateTab(MENU_TABS[(index + offset + MENU_TABS.length) % MENU_TABS.length] ?? "quota");
		};
		const toggleFast = () => {
			fastMessage = undefined;
			const result = toggleFastConfig();
			if ("error" in result) {
				fastMessage = "Could not save setting";
				ctx.ui.notify(`Failed to save Fast mode: ${result.error}`, "error");
			}
			render();
		};
		const toggleCompaction = () => {
			compactionMessage = undefined;
			const result = toggleResponsesCompactConfig();
			if ("error" in result) {
				compactionMessage = "Could not save setting";
				ctx.ui.notify(`Failed to save server compaction: ${result.error}`, "error");
			}
			render();
		};

		load();
		return {
			render: (width: number) => {
				let tabs = `  ${activeTab === "quota" ? theme.bold("Quota") : theme.fg("dim", "Quota")}  ${theme.fg("dim", "/")}  ${activeTab === "resets" ? theme.bold("Resets") : theme.fg("dim", "Resets")}  ${theme.fg("dim", "/")}  ${activeTab === "fast" ? theme.bold("Fast") : theme.fg("dim", "Fast")}  ${theme.fg("dim", "/")}  ${activeTab === "compaction" ? theme.bold("Compaction") : theme.fg("dim", "Compaction")}`;
				if (activeTab === "resets" && visibleWidth(tabs) > width) {
					tabs = `  ${theme.fg("muted", "Quota / ")}${theme.bold("Resets")}${theme.fg("muted", width >= 35 ? " / Fast / Compaction" : " / Fast / Compact")}`;
				}
				const config = readConfig();
				const eligible = isCanonicalCodexModel(ctx.model as RuntimeModel | undefined);
				if (recovery && (!recovery.valid() || !offeredRecordCurrent())) cancelRecovery();
				const state = durableState();
				discardStaleArm(state);
				if (recoveryFailure && (!recoveryFailure.contextCurrent() || !offerMatches(recoveryFailure.offer))) recoveryFailure = undefined;
				const autoActivity = resetAccountKey ? controls.activity(resetAccountKey) : undefined;
				const safety = ["legacy", "legacy-lock", "active", "storage"].includes(state.reason) || (state.reason === "busy" && !resetRunning && !autoActivity);
				const armed = Boolean(resetAccountKey && resetArmedAccountKey === resetAccountKey);
				const preference = resetAccountKey ? readAutoResetPreference(configPath, resetAccountKey).enabled : undefined;
				const canAcknowledge = !usageLoading && !resetRunning && !resetAccountLoading && resetAccountKey
					&& offerLegacyAcknowledgement(getAgentDir(), resetAccountKey, () => legacyResetIntents().get(resetAccountKey!), localAvailability()).eligible;
				const usable = usableManualCredit();
				const manual = !usageLoading && !resetRunning && !resetAccountLoading && manualEligible(state);
				const needsRefresh = manualResetNeedsRefresh(state.manualAction, manualRefresh);
				const status = safety ? (recoveryFailure ? "Paused: could not verify account; completion not saved" : state.status) : resetRunning || autoActivity === "applying" ? "Applying reset…" : resetAccountLoading ? "Checking account…" : autoActivity ? "Checking weekly usage…"
					: armed ? (state.reason === "uncertain" ? "Retry previous reset?" : "Use 1 banked reset?")
					: usageLoading && usageState ? "Refreshing balance…" : resetMessage
					?? (usageState && "error" in usageState ? "Could not refresh balance" : state.reason === "uncertain" ? state.status
						: preference && resetAccountKey ? controls.status(resetAccountKey) : !usable && usageState && !("error" in usageState) && (usageState.resetCredits?.availableCount ?? 0) > 0 ? "No usable reset details" : "");
				const resetFooter = recovery
					? recovery.checking ? ["Esc cancel"] : recovery.outcome ? ["Enter acknowledge · Esc cancel"] : ["1 reset · 2 already applied", "Esc cancel"]
					: armed ? [state.manualAction.kind === "retry" ? "Ctrl+R retry · Esc cancel" : "Ctrl+R use reset · Esc cancel"]
					: [
						...(canAcknowledge ? ["A acknowledge completion"] : []),
						"R refresh",
						...(resetAccountKey && !resetAccountLoading ? ["Space auto"] : []), "Tab next · Esc close",
					];
				const resetBody = recovery ? [
					...resetWrappedLines(theme.bold("Acknowledge completion"), width),
					...resetWrappedLines("Save locally · no reset used", width), "",
					...resetWrappedLines(recovery.checking ? "Checking account…" : recovery.outcome
						? `I confirm the original reset ${recovery.outcome === "reset" ? "completed" : "was already applied"} and no old request is running.`
						: "Choose the confirmed original outcome. If unsure, cancel.", width),
				] : [
					...formatResetLines(theme, usageState, usageLoading, preference, status, width),
					...(armed ? state.manualAction.kind === "retry" ? resetWrappedLines("Same credit and request ID", width) : [] : ["", ...resetWrappedLines(
						safety || resetRunning || autoActivity ? "Manual reset unavailable"
						: needsRefresh ? "Manual reset · R refresh first"
						: manual ? state.manualAction.kind === "retry" ? "Ctrl+R retry previous reset" : "Ctrl+R use 1 reset"
						: usageState && !("error" in usageState) && usageState.resetCredits?.availableCount === 0 ? "Manual reset · no banked resets"
						: "Manual reset · R refresh", width)]),
				];
				return [
					theme.fg("accent", "─".repeat(Math.max(0, width))),
					tabs,
					theme.fg("borderMuted", "─".repeat(Math.max(0, width))),
					...(activeTab === "quota"
						? formatQuotaLines(theme, usageState, usageLoading)
						: activeTab === "resets"
							? resetBody
							: activeTab === "fast"
								? formatFastLines(theme, config.fast, fastMessage ?? (config.fast && !eligible ? "Requires a Codex model" : ""), width)
								: formatCompactionLines(theme, config.compaction.responsesCompactEnabled, compactionMessage ?? (config.compaction.responsesCompactEnabled && !eligible ? "Requires a Codex model" : ""), width)),
					"",
					...(activeTab === "quota"
						? [theme.fg("dim", "  Tab next · Shift+Tab previous · R to refresh · Esc to close")]
						: packControls(activeTab === "resets" ? resetFooter : ["Space toggle", "Tab next · Esc close"], width)
							.map((line) => `  ${theme.fg("muted", line)}`)),
					theme.fg("accent", "─".repeat(Math.max(0, width))),
				].map((line) => truncateToWidth(line, width, ""));
			},
			invalidate: render,
			dispose: () => {
				cancelRecovery();
				cancelManual();
				shutdownSignal.removeEventListener("abort", closeOnShutdown);
				stopConfigWatcher();
				viewController.abort();
			},
			handleInput: (data: string) => {
				if (viewSignal.aborted) return;
				discardStaleArm(durableState());
				// Stale/consumed confirmation keys must not become automatic-spending consent.
				if (activeTab === "resets" && matchesKey(data, "enter")
					&& (resetRunning || (manualEnterReserved && !resetArmedAccountKey))) { render(); return; }
				if (recovery && (!recovery.valid() || !offeredRecordCurrent())) { cancelRecovery(); render(); return; }
				if (matchesKey(data, "escape") && (recovery || resetArmedAccountKey)) {
					cancelRecovery(); cancelManual(true); render(); return;
				}
				if (recovery && !matchesKey(data, "tab") && !matchesKey(data, "shift+tab") && !matchesKey(data, "ctrl+c") && !matchesKey(data, "space")) {
					if (!recovery.checking && (data === "1" || data === "2")) recovery.outcome = data === "1" ? "reset" : "already_redeemed";
					else if (matchesKey(data, "enter")) void confirmRecovery();
					render(); return;
				}
				if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
					cancelManual();
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
				} else if (activeTab === "resets" && resetArmedAccountKey && matchesKey(data, "enter")) {
					void startReset();
				} else if (activeTab === "resets" && (matchesKey(data, "enter") || matchesKey(data, "space"))) {
					void toggleAuto();
				} else if (activeTab === "resets" && data.toLowerCase() === "a") {
					void beginRecovery();
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
	formatResetLines,
	formatResetCreditExpiries,
	formatFastLines,
	formatCompactionLines,
	resetWrappedLines,
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
	const autoActivity = new Map<string, "checking" | "applying">();
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
				autoActivity.set(account.key, "checking");
				for (const render of resetStatusListeners) render();
				const result = await runCoordinatedReset(ctx, "auto", signal, current, account.key, undefined, (usage) => {
					generation += 1; // Invalidate older footer reads as well as its cached value.
					const weeklyLeft = weeklyUsageLeft(usage);
					weeklyUsageCache.set(usage.accountKey, { value: weeklyLeft, expiresAt: Date.now() + WEEKLY_USAGE_CACHE_MS });
					setStatus(ctx, weeklyLeft);
					for (const render of resetStatusListeners) render(usage);
				}, () => {
					autoActivity.set(account.key, "applying");
					for (const render of resetStatusListeners) render();
				});
				autoActivity.delete(account.key);
				if (current()) {
					autoStatus.set(account.key, result.reason === "busy" ? "" : result.displayStatus ?? "");
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
					const durable = resetAccountState(getAgentDir(), key, legacyResetIntents().get(key));
					if (durable.reason !== "ready" && durable.reason !== "recovery") return durable.status;
					if (!readAutoResetPreference(getConfigPath(), key).enabled) return "";
					if (!isCanonicalCodexModel(ctx.model)) return "Paused: select a Codex model";
					return durable.reason === "recovery" ? durable.status : autoStatus.get(key) ?? durable.status;
				},
				clearStatus: (key) => { autoStatus.delete(key); },
				activity: (key) => autoActivity.get(key),
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
		for (const key of legacyResetIntents().keys()) {
			// A prior account's awaited migration may overlap a legacy producer transition.
			const intent = legacyResetIntents().get(key);
			if (!intent) continue;
			try { await preserveLegacyReset(getAgentDir(), key, intent); }
			catch { autoStatus.set(key, "Paused: previous reset needs recovery; see README."); }
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
