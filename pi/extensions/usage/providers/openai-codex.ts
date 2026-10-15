// Adapted from codex-enhanced; see the MIT notice in index.ts.
import {
	displayText,
	isRecord,
	numberValue,
	requireProviderAuth,
	stringValue,
	ProviderStateError,
	WEEKLY_WINDOW_MINUTES,
	windowLabel,
	type AdapterContext,
	type ProviderAdapter,
	type ProviderSnapshot,
	type UsageRow,
} from "../core.ts";
import { fetchBoundedJson } from "../network.ts";

const PROVIDER_ID = "openai-codex";
const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const LOGIN_GUIDANCE = "Run /login openai-codex for Codex backend access; /login openai alone is not enough.";

export type CodexWindow = { usedPercent?: number; windowMinutes?: number; resetsAt?: number };
export type CodexLimit = { limitId: string; limitName?: string; primary?: CodexWindow; secondary?: CodexWindow };
export type CodexUsage = { planType?: string; limits: CodexLimit[] };

function parseWindow(value: unknown): CodexWindow | undefined {
	if (!isRecord(value)) return undefined;
	const usedPercent = numberValue(value.used_percent);
	const seconds = numberValue(value.limit_window_seconds);
	const minutes = numberValue(value.window_minutes);
	// Disagreeing durations make the window length unknown rather than guessed.
	const windowMinutes = minutes !== undefined && seconds !== undefined && minutes !== seconds / 60
		? undefined : minutes ?? (seconds === undefined ? undefined : seconds / 60);
	const resetsAt = numberValue(value.resets_at) ?? numberValue(value.reset_at);
	return usedPercent === undefined && windowMinutes === undefined && resetsAt === undefined
		? undefined
		: { usedPercent, windowMinutes, resetsAt };
}

function parseRateLimit(value: unknown): Pick<CodexLimit, "primary" | "secondary"> {
	if (!isRecord(value)) return {};
	const primary = parseWindow(value.primary_window) ?? parseWindow(value.primary);
	const secondary = parseWindow(value.secondary_window) ?? parseWindow(value.secondary);
	// A lone weekly window always lives in the secondary slot.
	return primary?.windowMinutes === WEEKLY_WINDOW_MINUTES && !secondary ? { secondary: primary } : { primary, secondary };
}

export function parseCodexUsagePayload(payload: unknown): CodexUsage {
	const root = isRecord(payload) ? payload : {};
	const limits: CodexLimit[] = [];
	const addLimit = (limitId: string, limitName: string | undefined, source: unknown) => {
		const rateLimit = isRecord(source) && "rate_limit" in source ? source.rate_limit : source;
		limits.push({ limitId, ...(limitName ? { limitName } : {}), ...parseRateLimit(rateLimit) });
	};
	addLimit("codex", undefined, root.rate_limit);
	if (Array.isArray(root.additional_rate_limits)) {
		for (const item of root.additional_rate_limits) {
			if (!isRecord(item)) continue;
			addLimit(displayText(item.metered_feature) ?? "additional", displayText(item.limit_name), item);
		}
	}
	return { planType: displayText(root.plan_type), limits };
}

export function codexSnapshot(usage: CodexUsage, observedAt = Date.now() / 1000): ProviderSnapshot {
	const rows: UsageRow[] = usage.limits.map((limit) => ({
		label: limit.limitName ?? limit.limitId,
		windows: ([["primary", limit.primary], ["secondary", limit.secondary]] as const)
			.filter((entry): entry is readonly ["primary" | "secondary", CodexWindow] => entry[1] !== undefined)
			.map(([slot, window]) => ({
				label: windowLabel(window.windowMinutes, slot),
				...(window.usedPercent !== undefined ? { usedPercent: window.usedPercent } : {}),
				...(window.resetsAt !== undefined ? { resetsAt: window.resetsAt } : {}),
			})),
	}));
	return {
		providerId: PROVIDER_ID,
		title: "Codex",
		...(usage.planType ? { subtitle: usage.planType } : {}),
		rows,
		...(rows.every((row) => row.windows.length === 0) ? { notes: ["Codex returned no usage windows."] } : {}),
		observedAt: Math.floor(observedAt),
	};
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

export function extractAccountId(token: string): string | undefined {
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

async function buildHeaders(ctx: AdapterContext): Promise<Headers> {
	const auth = await requireProviderAuth(ctx, PROVIDER_ID);
	if (!isCanonicalBaseUrl(auth.baseUrl, true)) throw new ProviderStateError("setup", LOGIN_GUIDANCE);
	const accountId = extractAccountId(auth.apiKey);
	if (!accountId) throw new ProviderStateError("setup", LOGIN_GUIDANCE);
	return new Headers({
		accept: "application/json",
		authorization: `Bearer ${auth.apiKey}`,
		"chatgpt-account-id": accountId,
		"OAI-Language": "en",
		originator: "pi",
	});
}

export const openaiCodexAdapter: ProviderAdapter = {
	id: PROVIDER_ID,
	title: "Codex",
	async hasCredentials(ctx) {
		return ctx.hasProviderCredentials(PROVIDER_ID);
	},
	async fetch(ctx, signal) {
		const headers = await buildHeaders(ctx);
		const payload = await fetchBoundedJson(`${DEFAULT_CODEX_BASE_URL}/wham/usage`, { method: "GET", headers, signal }, { fetch: ctx.fetch, label: "Codex" });
		return codexSnapshot(parseCodexUsagePayload(payload));
	},
};
