/**
 * Command Code account quota, adapted from the `pi-commandcode-provider` package
 * (MIT, https://github.com/patlux/pi-commandcode-provider), whose `/commandcode-quota`
 * command reads the alpha usage endpoints `whoami`, `billing/credits`,
 * `billing/subscriptions` and `usage/summary` with the account's API key. That
 * integration maps the result onto this extension's snapshot contract instead of
 * plain-text output, and re-throws request failures as tab states:
 *
 * - `whoami` is blocking: no account, no tab data. 401/403 anywhere is the
 *   auth-refresh state, everything else fails soft per section.
 * - A section the API does not recognize or cannot serve is reported as an
 *   explicit unavailable note, never displayed as zero usage.
 * - Window-limit percentages are of the window's credit cap; the credit pool
 *   percentage is billing-period spend over (remaining credits + spend), the
 *   same "% used" the upstream command reports.
 */

import {
	displayText,
	epochSeconds,
	isRecord,
	requireProviderAuth,
	ProviderStateError,
	type ProviderAdapter,
	type ProviderSnapshot,
	type UsageRow,
	type UsageWindow,
} from "../core.ts";
import { fetchBoundedJson, HttpError } from "../network.ts";

const PROVIDER_ID = "commandcode";
const LABEL = "Command Code";
/** Registered provider config base; the alpha endpoints hang one level below its API root. */
const DEFAULT_ALPHA_ORIGIN = "https://api.commandcode.ai";
const PROVIDER_BASE_SUFFIX = /\/provider\/v1\/?$/;
const WINDOW_LABELS: Readonly<Record<"fiveHour" | "weekly", string>> = { fiveHour: "5h", weekly: "weekly" };

export type CommandCodeAccount = { login: string; orgId: string | null; keyName?: string };

export type CommandCodeWindowLimit = {
	window: "fiveHour" | "weekly";
	used: number;
	cap: number;
	/** Epoch seconds, normalized. */
	resetAt?: number;
};

export type CommandCodeCredits = {
	monthlyCredits: number;
	purchasedCredits: number;
	freeCredits: number;
	remainingCredits: number;
	windowLimits: CommandCodeWindowLimit[];
};

export type CommandCodeSubscription = {
	planId: string | null;
	status: string | null;
	currentPeriodStart: string | null;
	currentPeriodEnd: string | null;
};

export type CommandCodeUsageSummary = {
	totalCost: number;
	totalCount: number;
	totalTokens?: number;
};

/** Non-negative finite JSON number; the alpha endpoints only make sense for those. */
function amount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function timestamp(value: unknown): string | undefined {
	if (typeof value === "string" && value.trim().length > 0) return value;
	if (typeof value === "number" && Number.isFinite(value) && value >= 0) return String(value);
	return undefined;
}

export function parseWhoami(value: unknown): CommandCodeAccount | null {
	if (!isRecord(value)) return null;
	const org = isRecord(value.org) ? value.org : undefined;
	const user = isRecord(value.user) ? value.user : undefined;
	const login =
		(org ? displayText(org.login) : undefined) ??
		(user ? (displayText(user.userName) ?? displayText(user.name)) : undefined);
	if (!login) return null;
	const keyName = user ? (displayText(user.keyName) ?? displayText(user.displayName)) : undefined;
	return {
		login,
		// An org id is a query parameter, not display text: trim it, never truncate it.
		orgId: org && typeof org.id === "string" && org.id.trim().length > 0 ? org.id.trim() : null,
		...(keyName ? { keyName } : {}),
	};
}

/** Skips empty window pairs (`used` and `cap` both 0 render nothing upstream either). */
function windowLimits(value: unknown): CommandCodeWindowLimit[] {
	const limits: CommandCodeWindowLimit[] = [];
	for (const [window, entry] of [
		["fiveHour", isRecord(value) ? value.fiveHour : undefined],
		["weekly", isRecord(value) ? value.weekly : undefined],
	] as const) {
		if (!isRecord(entry)) continue;
		const used = amount(entry.used);
		const cap = amount(entry.cap);
		if (used === undefined || cap === undefined || (used === 0 && cap === 0)) continue;
		const resetAt = epochSeconds(entry.resetAt);
		limits.push({ window, used, cap, ...(resetAt !== undefined ? { resetAt } : {}) });
	}
	return limits;
}

export function parseCredits(value: unknown): CommandCodeCredits | null {
	if (!isRecord(value) || !isRecord(value.credits)) return null;
	const monthlyCredits = amount(value.credits.monthlyCredits);
	const purchasedCredits = amount(value.credits.purchasedCredits);
	const freeCredits = amount(value.credits.freeCredits);
	if (monthlyCredits === undefined && purchasedCredits === undefined && freeCredits === undefined) return null;
	const remainingCredits = (monthlyCredits ?? 0) + (purchasedCredits ?? 0) + (freeCredits ?? 0);
	return {
		monthlyCredits: monthlyCredits ?? 0,
		purchasedCredits: purchasedCredits ?? 0,
		freeCredits: freeCredits ?? 0,
		remainingCredits,
		windowLimits: windowLimits(value.windowLimits),
	};
}

export function parseSubscription(value: unknown): CommandCodeSubscription | null {
	if (!isRecord(value) || !isRecord(value.data)) return null;
	const data = value.data;
	const planId = displayText(data.planId) ?? null;
	const status = displayText(data.status) ?? null;
	const currentPeriodStart = timestamp(data.currentPeriodStart) ?? null;
	const currentPeriodEnd = timestamp(data.currentPeriodEnd) ?? null;
	if (!planId && !status && !currentPeriodStart && !currentPeriodEnd) return null;
	return { planId, status, currentPeriodStart, currentPeriodEnd };
}

export function parseSummary(value: unknown): CommandCodeUsageSummary | null {
	if (!isRecord(value)) return null;
	const totalCost = amount(value.totalCost);
	const totalCount = amount(value.totalCount);
	if (totalCost === undefined || totalCount === undefined) return null;
	const totalTokens = amount(value.totalTokens) ?? amount(value.tokens);
	return { totalCost, totalCount, ...(totalTokens !== undefined ? { totalTokens } : {}) };
}

/** Same origin rule as the chat transport: strip the known provider-API suffix, pass anything else through. */
export function alphaOrigin(baseUrl: string | undefined): string {
	if (!baseUrl?.trim()) return DEFAULT_ALPHA_ORIGIN;
	const origin = baseUrl.trim().replace(PROVIDER_BASE_SUFFIX, "").replace(/\/+$/, "");
	return origin.length > 0 ? origin : DEFAULT_ALPHA_ORIGIN;
}

export type CommandCodeSections = {
	account: CommandCodeAccount;
	/** Raw section payloads; absent entries were unavailable and must appear in `unavailable`. */
	credits?: unknown;
	subscription?: unknown;
	summary?: unknown;
	/** Section key -> short human reason, e.g. `HTTP 500`, `timed out`, `unrecognized response`. */
	unavailable?: Readonly<Record<string, string>>;
};

const money = (value: number): string => `$${value.toFixed(2)}`;

/** 12_340_000 → "12.3M", matching the upstream dashboard's token rendering. */
export function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000_000) return `${(tokens / 1_000_000_000).toFixed(1)}B`;
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
	return String(tokens);
}

function planDate(value: string | null): Date | undefined {
	if (!value) return undefined;
	const seconds = /^\d+$/.test(value.trim()) ? Number(value.trim()) : Date.parse(value);
	if (!Number.isFinite(seconds) || seconds < 0) return undefined;
	const date = new Date(seconds >= 1e12 ? seconds : seconds * 1000);
	return Number.isNaN(date.getTime()) ? undefined : date;
}

/** `now` is epoch seconds, like every snapshot timestamp. */
function planNote(subscription: CommandCodeSubscription, now: number): string {
	const plan = (subscription.planId ?? "unknown plan").replace(/[_-]+/g, " ").trim();
	let renewal = "";
	const end = planDate(subscription.currentPeriodEnd);
	if (end) {
		const days = Math.ceil((end.getTime() - now * 1000) / 86_400_000);
		const date = end.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
		renewal = days > 0 ? ` · renews ${date} (${days}d)`
			: days === 0 ? ` · renews ${date} (today)`
			: ` · renewed ${date}`;
	}
	return `Plan ${plan}${subscription.status ? ` (${subscription.status})` : ""}${renewal}`;
}

/**
 * Map the parsed sections onto the snapshot contract. Never throws: sections the
 * API serves but that parse to nothing are marked unavailable by the caller.
 */
export function parseCommandCodeSnapshot(
	sections: CommandCodeSections,
	now: number = Date.now() / 1000,
): ProviderSnapshot {
	const { account } = sections;
	const credits = parseCredits(sections.credits);
	const subscription = parseSubscription(sections.subscription);
	const summary = parseSummary(sections.summary);

	const spent = summary?.totalCost ?? 0;
	const remaining = credits?.remainingCredits;
	const pool = remaining !== undefined ? remaining + spent : undefined;

	const windows: UsageWindow[] = [];
	for (const limit of credits?.windowLimits ?? []) {
		windows.push({
			label: WINDOW_LABELS[limit.window],
			usedPercent: (limit.used / limit.cap) * 100,
			...(limit.resetAt !== undefined ? { resetsAt: limit.resetAt } : {}),
			note: `${money(limit.used)} of ${money(limit.cap)}`,
		});
	}
	if (pool !== undefined) {
		// An empty pool (remaining 0, spent 0) has no ratio: 0% is the honest figure.
		windows.push({
			label: "period",
			usedPercent: pool > 0 ? (spent / pool) * 100 : 0,
			note: `remaining ${money(remaining ?? 0)} of ${money(pool)}`,
		});
	} else if (spent > 0) {
		// Credits unavailable or unrecognized, so there is no pool to spend against.
		windows.push({ label: "period", note: `${money(spent)} spent` });
	}
	const rows: UsageRow[] = windows.length ? [{ label: "Credits", windows }] : [];

	const notes: string[] = [];
	notes.push(`Account ${account.login}${account.keyName ? ` · key "${account.keyName}"` : ""}`);
	if (credits) {
		const sources = [`monthly ${money(credits.monthlyCredits)}`, `purchased ${money(credits.purchasedCredits)}`];
		if (credits.freeCredits > 0) sources.push(`free ${money(credits.freeCredits)}`);
		notes.push(`Sources: ${sources.join(" / ")}`);
	}
	if (summary) {
		const tokens = summary.totalTokens !== undefined ? ` · ${formatTokens(summary.totalTokens)} tokens` : "";
		notes.push(`Usage: ${money(summary.totalCost)} · ${summary.totalCount.toLocaleString("en-US")} requests${tokens}`);
	}
	if (subscription) notes.push(planNote(subscription, now));
	for (const [section, reason] of Object.entries(sections.unavailable ?? {})) notes.push(`${section}: ${reason}`);

	const known = rows.flatMap((row) => row.windows.map((window) => window.usedPercent))
		.filter((value): value is number => value !== undefined && Number.isFinite(value));
	return {
		providerId: PROVIDER_ID,
		title: LABEL,
		rows,
		...(subscription?.planId ? { subtitle: displayText(subscription.planId.replace(/[_-]+/g, " "), 24) } : {}),
		notes,
		observedAt: Math.floor(now),
		...(known.length ? { statusPercent: Math.max(...known) } : {}),
	};
}

type SectionResult = { ok: true; value: unknown } | { ok: false; reason: string; blocked: boolean };

/**
 * One GET against an alpha endpoint. A section failure never breaks the tab: the
 * caller turns it into an unavailable note, except for account-key rejections,
 * which block like upstream does.
 */
async function fetchSection(
	url: string,
	params: Record<string, string | undefined>,
	headers: Record<string, string>,
	deps: { fetch: typeof fetch; signal?: AbortSignal },
): Promise<SectionResult> {
	const query = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) if (value) query.set(key, value);
	const suffix = query.size ? `?${query}` : "";
	try {
		const value = await fetchBoundedJson(`${url}${suffix}`, {
			method: "GET",
			headers,
			...(deps.signal ? { signal: deps.signal } : {}),
		}, { fetch: deps.fetch, label: LABEL });
		return { ok: true, value };
	} catch (error) {
		const blocked = error instanceof HttpError && (error.status === 401 || error.status === 403);
		const reason = error instanceof HttpError ? `HTTP ${error.status}`
			: error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError") ? "timed out"
			: "request failed";
		return { ok: false, reason, blocked };
	}
}

export const commandcodeAdapter: ProviderAdapter = {
	id: PROVIDER_ID,
	title: LABEL,
	async hasCredentials(ctx) {
		return ctx.hasProviderCredentials(PROVIDER_ID);
	},
	async fetch(ctx, signal) {
		const auth = await requireProviderAuth(ctx, PROVIDER_ID);
		const origin = alphaOrigin(auth.baseUrl);
		const headers = { accept: "application/json", authorization: `Bearer ${auth.apiKey}` };
		const deps = { fetch: ctx.fetch, ...(signal ? { signal } : {}) };

		const whoami = await fetchSection(`${origin}/alpha/whoami`, {}, headers, deps);
		if (!whoami.ok) throw new ProviderStateError(whoami.blocked ? "auth-refresh" : "blocked",
			whoami.blocked ? `${LABEL} rejected the API key · run /login ${PROVIDER_ID}` : `${LABEL} account lookup failed (${whoami.reason}) · press R to retry.`);
		const account = parseWhoami(whoami.value);
		if (!account) throw new Error(`${LABEL} returned an unrecognized account response.`);

		const orgId = account.orgId ?? undefined;
		const [credits, subscription] = await Promise.all([
			fetchSection(`${origin}/alpha/billing/credits`, { orgId }, headers, deps),
			fetchSection(`${origin}/alpha/billing/subscriptions`, { orgId }, headers, deps),
		]);
		// The key is wrong or the login expired: no point rendering a half-empty tab, and
		// no point spending the summary request on it.
		for (const result of [credits, subscription]) {
			if (result.ok === false && result.blocked) {
				throw new ProviderStateError("auth-refresh", `${LABEL} rejected the API key · run /login ${PROVIDER_ID}`);
			}
		}
		const since = parseSubscription(subscription.ok ? subscription.value : undefined)?.currentPeriodStart ?? undefined;
		const summary = await fetchSection(`${origin}/alpha/usage/summary`, { orgId, since }, headers, deps);
		if (summary.ok === false && summary.blocked) {
			throw new ProviderStateError("auth-refresh", `${LABEL} rejected the API key · run /login ${PROVIDER_ID}`);
		}

		// A section that answers 200 but no longer parses is unavailable too, exactly like upstream:
		// report it explicitly instead of rendering zero usage.
		const parsed = {
			credits: credits.ok ? parseCredits(credits.value) : null,
			subscription: subscription.ok ? parseSubscription(subscription.value) : null,
			summary: summary.ok ? parseSummary(summary.value) : null,
		};
		if (!parsed.credits && !parsed.subscription && !parsed.summary) {
			throw new Error(`${LABEL} returned no recognized usage data for the account.`);
		}
		const unavailable: Record<string, string> = {};
		for (const [section, result, value] of [["credits", credits, parsed.credits], ["subscription", subscription, parsed.subscription], ["summary", summary, parsed.summary]] as const) {
			if (!result.ok) unavailable[section] = result.reason;
			else if (value === null) unavailable[section] = "unrecognized response";
		}
		return parseCommandCodeSnapshot({
			account,
			...(parsed.credits !== null ? { credits: credits.value } : {}),
			...(parsed.subscription !== null ? { subscription: subscription.value } : {}),
			...(parsed.summary !== null ? { summary: summary.value } : {}),
			...(Object.keys(unavailable).length ? { unavailable } : {}),
		});
	},
};
